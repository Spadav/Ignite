package process

import (
	"bufio"
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"ignite/config"
	"ignite/logger"
	igniteruntime "ignite/runtime"
)

type trackedProcess struct {
	state LoadedModel
	cmd   *exec.Cmd
	done  chan struct{}
}

type Manager struct {
	state     *igniteruntime.State
	logs      *logger.Logger
	mu        sync.Mutex
	loaded    map[string]*trackedProcess
	usedPorts map[int]bool
	loadLocks map[string]*sync.Mutex
	nextPort  int
}

func NewManager(state *igniteruntime.State, logs *logger.Logger) *Manager {
	cfg := state.Config()
	return &Manager{
		state:     state,
		logs:      logs,
		loaded:    make(map[string]*trackedProcess),
		usedPorts: make(map[int]bool),
		loadLocks: make(map[string]*sync.Mutex),
		nextPort:  cfg.StartPort,
	}
}

func (m *Manager) Snapshot() []LoadedModel {
	m.mu.Lock()
	defer m.mu.Unlock()

	out := make([]LoadedModel, 0, len(m.loaded))
	for _, proc := range m.loaded {
		out = append(out, proc.state)
	}
	return out
}

func (m *Manager) Get(modelID string) (LoadedModel, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	proc, ok := m.loaded[modelID]
	if !ok {
		return LoadedModel{}, false
	}
	return proc.state, true
}

func (m *Manager) Touch(modelID string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if proc, ok := m.loaded[modelID]; ok {
		proc.state.LastRequest = time.Now()
	}
}

func (m *Manager) EnsureLoaded(ctx context.Context, modelID string) (LoadedModel, error) {
	lock := m.loadLock(modelID)
	lock.Lock()
	defer lock.Unlock()

	if state, ok := m.Get(modelID); ok && state.Status == StatusRunning {
		m.Touch(modelID)
		return state, nil
	}

	cfg := m.state.Config()
	model, ok := cfg.Models[modelID]
	if !ok {
		return LoadedModel{}, fmt.Errorf("unknown model %q", modelID)
	}

	if err := m.unloadGroupMembers(ctx, cfg, modelID); err != nil {
		return LoadedModel{}, err
	}

	port := m.reservePort()
	cmd, err := m.commandForModel(modelID, model, port)
	if err != nil {
		m.releasePort(port)
		return LoadedModel{}, err
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		m.releasePort(port)
		return LoadedModel{}, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		m.releasePort(port)
		return LoadedModel{}, err
	}

	now := time.Now()
	proc := &trackedProcess{
		state: LoadedModel{
			ModelID:     modelID,
			Port:        port,
			GPU:         model.GPU,
			Status:      StatusStarting,
			LoadedAt:    now,
			LastRequest: now,
		},
		cmd:  cmd,
		done: make(chan struct{}),
	}

	m.mu.Lock()
	m.loaded[modelID] = proc
	m.mu.Unlock()

	if err := cmd.Start(); err != nil {
		m.markError(modelID, err)
		m.releasePort(port)
		return LoadedModel{}, err
	}

	m.mu.Lock()
	proc.state.PID = cmd.Process.Pid
	m.mu.Unlock()

	go m.scanOutput(modelID, "stdout", stdout)
	go m.scanOutput(modelID, "stderr", stderr)
	go m.waitForExit(modelID, cmd)

	timeout := time.Duration(cfg.HealthCheck.Timeout) * time.Second
	if err := m.waitForModelHealth(ctx, proc, timeout); err != nil {
		_ = m.Unload(ctx, modelID)
		return LoadedModel{}, err
	}

	m.mu.Lock()
	proc.state.Status = StatusRunning
	proc.state.LastRequest = time.Now()
	state := proc.state
	m.mu.Unlock()

	m.logs.Infof("model %s loaded on port %d pid %d", modelID, state.Port, state.PID)
	return state, nil
}

func (m *Manager) waitForModelHealth(ctx context.Context, proc *trackedProcess, timeout time.Duration) error {
	healthCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	healthResult := make(chan error, 1)
	go func() {
		healthResult <- waitForHealth(healthCtx, proc.state.Port, timeout)
	}()

	select {
	case err := <-healthResult:
		return err
	case <-proc.done:
		m.mu.Lock()
		message := proc.state.Error
		modelID := proc.state.ModelID
		m.mu.Unlock()
		if message == "" {
			message = "llama-server exited before becoming healthy"
		}
		return fmt.Errorf("model %s failed during startup: %s; see Logs for llama.cpp output", modelID, message)
	}
}

func (m *Manager) loadLock(modelID string) *sync.Mutex {
	m.mu.Lock()
	defer m.mu.Unlock()

	lock, ok := m.loadLocks[modelID]
	if !ok {
		lock = &sync.Mutex{}
		m.loadLocks[modelID] = lock
	}
	return lock
}

func (m *Manager) Unload(ctx context.Context, modelID string) error {
	m.mu.Lock()
	proc, ok := m.loaded[modelID]
	if !ok {
		m.mu.Unlock()
		return nil
	}
	proc.state.Status = StatusStopping
	m.mu.Unlock()

	if proc.cmd.Process != nil {
		_ = proc.cmd.Process.Signal(syscall.SIGTERM)
		select {
		case <-ctx.Done():
			_ = proc.cmd.Process.Kill()
		case <-time.After(5 * time.Second):
			_ = proc.cmd.Process.Kill()
		case <-proc.done:
		}
	}

	m.mu.Lock()
	delete(m.loaded, modelID)
	m.mu.Unlock()
	m.releasePort(proc.state.Port)
	m.logs.Infof("model %s unloaded", modelID)
	return nil
}

func (m *Manager) UnloadAll(ctx context.Context) error {
	var ids []string
	m.mu.Lock()
	for id := range m.loaded {
		ids = append(ids, id)
	}
	m.mu.Unlock()

	for _, id := range ids {
		if err := m.Unload(ctx, id); err != nil {
			return err
		}
	}
	return nil
}

func (m *Manager) StopRuntime(ctx context.Context) (int, error) {
	stopped := len(m.Snapshot())
	if err := m.UnloadAll(ctx); err != nil {
		return stopped, err
	}

	stale, err := m.stopStaleBackendProcesses(ctx)
	if err != nil {
		return stopped + stale, err
	}
	if stopped+stale == 0 {
		m.logs.Infof("runtime stop requested; no llama.cpp processes were running")
	} else {
		m.logs.Infof("runtime stopped %d llama.cpp process(es)", stopped+stale)
	}
	return stopped + stale, nil
}

func (m *Manager) unloadGroupMembers(ctx context.Context, cfg *config.Config, targetID string) error {
	for _, memberID := range swapUnloadCandidates(cfg, targetID) {
		if _, ok := m.Get(memberID); ok {
			if err := m.Unload(ctx, memberID); err != nil {
				return err
			}
		}
	}
	return nil
}

func swapUnloadCandidates(cfg *config.Config, targetID string) []string {
	_, group, ok := cfg.GroupForModel(targetID)
	if !ok || !group.Swap {
		return nil
	}
	target, ok := cfg.Models[targetID]
	if !ok {
		return nil
	}
	var out []string
	for _, memberID := range group.Members {
		if memberID == targetID {
			continue
		}
		member, ok := cfg.Models[memberID]
		if !ok || member.GPU != target.GPU {
			continue
		}
		out = append(out, memberID)
	}
	return out
}

func (m *Manager) stopStaleBackendProcesses(ctx context.Context) (int, error) {
	cfg := m.state.Config()
	backend := cfg.ActiveBackendConfig()
	binary, err := filepath.Abs(expandPath(filepath.Join(backend.Path, backend.Binary)))
	if err != nil {
		binary = expandPath(filepath.Join(backend.Path, backend.Binary))
	}
	modelsPath, err := filepath.Abs(expandPath(cfg.ModelsPath))
	if err != nil {
		modelsPath = expandPath(cfg.ModelsPath)
	}

	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0, nil
	}

	var stopped int
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid == os.Getpid() {
			continue
		}
		if m.isTrackedPID(pid) {
			continue
		}
		if !matchesIgniteBackendProcess(pid, binary, modelsPath) {
			continue
		}
		if err := terminatePID(ctx, pid); err != nil {
			return stopped, err
		}
		stopped++
	}
	return stopped, nil
}

func (m *Manager) isTrackedPID(pid int) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, proc := range m.loaded {
		if proc.state.PID == pid {
			return true
		}
	}
	return false
}

func matchesIgniteBackendProcess(pid int, binary, modelsPath string) bool {
	exe, err := os.Readlink(filepath.Join("/proc", strconv.Itoa(pid), "exe"))
	if err != nil {
		return false
	}
	exeAbs, err := filepath.Abs(exe)
	if err == nil {
		exe = exeAbs
	}
	if exe != binary {
		return false
	}

	data, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "cmdline"))
	if err != nil {
		return false
	}
	args := strings.Split(strings.TrimRight(string(data), "\x00"), "\x00")
	for i, arg := range args {
		if arg == "-m" && i+1 < len(args) && isWithinPath(args[i+1], modelsPath) {
			return true
		}
		if strings.HasPrefix(arg, modelsPath+string(os.PathSeparator)) {
			return true
		}
	}
	return false
}

func isWithinPath(path, parent string) bool {
	abs, err := filepath.Abs(path)
	if err == nil {
		path = abs
	}
	rel, err := filepath.Rel(parent, path)
	return err == nil && rel != "." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)) && rel != ".."
}

func terminatePID(ctx context.Context, pid int) error {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	_ = proc.Signal(syscall.SIGTERM)

	done := make(chan struct{})
	go func() {
		for processAlive(pid) {
			time.Sleep(100 * time.Millisecond)
		}
		close(done)
	}()

	select {
	case <-done:
		return nil
	case <-ctx.Done():
		_ = proc.Kill()
		return ctx.Err()
	case <-time.After(5 * time.Second):
		_ = proc.Kill()
		return nil
	}
}

func processAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil
}

func (m *Manager) commandForModel(modelID string, model config.Model, port int) (*exec.Cmd, error) {
	cfg := m.state.Config()
	backend := cfg.ActiveBackendConfig()
	binary := expandPath(filepath.Join(backend.Path, backend.Binary))
	args, err := splitArgs(model.Args)
	if err != nil {
		return nil, fmt.Errorf("parse args for %s: %w", modelID, err)
	}

	cmdArgs := []string{
		"-m", filepath.Join(expandPath(cfg.ModelsPath), model.File),
	}
	if model.MMProj != "" {
		cmdArgs = append(cmdArgs, "--mmproj", filepath.Join(expandPath(cfg.MMProjectsPath), model.MMProj))
	}
	cmdArgs = append(cmdArgs, "--host", "0.0.0.0", "--port", fmt.Sprintf("%d", port))
	cmdArgs = append(cmdArgs, args...)

	cmd := exec.Command(binary, cmdArgs...)
	cmd.Env = append(os.Environ(), "CUDA_VISIBLE_DEVICES="+model.GPU)
	return cmd, nil
}

func (m *Manager) reservePort() int {
	m.mu.Lock()
	defer m.mu.Unlock()

	for {
		port := m.nextPort
		m.nextPort++
		if m.nextPort > 65535 {
			m.nextPort = m.state.Config().StartPort
		}
		if !m.usedPorts[port] {
			m.usedPorts[port] = true
			return port
		}
	}
}

func (m *Manager) releasePort(port int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.usedPorts, port)
}

func (m *Manager) markError(modelID string, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if proc, ok := m.loaded[modelID]; ok {
		proc.state.Status = StatusError
		proc.state.Error = err.Error()
	}
}

func (m *Manager) scanOutput(modelID, stream string, pipe interface{ Read([]byte) (int, error) }) {
	scanner := bufio.NewScanner(pipe)
	for scanner.Scan() {
		m.logs.ModelLine(modelID, stream, scanner.Text())
	}
}

func (m *Manager) waitForExit(modelID string, cmd *exec.Cmd) {
	err := cmd.Wait()
	m.mu.Lock()
	defer m.mu.Unlock()

	proc, ok := m.loaded[modelID]
	if !ok {
		return
	}
	close(proc.done)
	proc.state.Status = StatusStopped
	if err != nil {
		proc.state.Status = StatusError
		proc.state.Error = err.Error()
		m.logs.Errorf("llama-server[%s] exited: %v", modelID, err)
	} else {
		m.logs.Infof("llama-server[%s] exited", modelID)
	}
	delete(m.usedPorts, proc.state.Port)
}

func waitForHealth(ctx context.Context, port int, timeout time.Duration) error {
	if timeout <= 0 {
		timeout = 120 * time.Second
	}
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	url := fmt.Sprintf("http://127.0.0.1:%d/health", port)
	client := &http.Client{Timeout: 2 * time.Second}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return fmt.Errorf("health check timed out for %s", url)
		case <-ticker.C:
			resp, err := client.Get(url)
			if err == nil {
				_ = resp.Body.Close()
				if resp.StatusCode >= 200 && resp.StatusCode < 300 {
					return nil
				}
			}
		}
	}
}

func expandPath(path string) string {
	if path == "~" {
		if home, err := os.UserHomeDir(); err == nil {
			return home
		}
	}
	if strings.HasPrefix(path, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, strings.TrimPrefix(path, "~/"))
		}
	}
	return path
}

func splitArgs(input string) ([]string, error) {
	var args []string
	var current strings.Builder
	var quote rune
	escaped := false

	for _, r := range input {
		switch {
		case escaped:
			current.WriteRune(r)
			escaped = false
		case r == '\\':
			escaped = true
		case quote != 0:
			if r == quote {
				quote = 0
			} else {
				current.WriteRune(r)
			}
		case r == '\'' || r == '"':
			quote = r
		case r == ' ' || r == '\n' || r == '\t':
			if current.Len() > 0 {
				args = append(args, current.String())
				current.Reset()
			}
		default:
			current.WriteRune(r)
		}
	}
	if escaped {
		current.WriteRune('\\')
	}
	if quote != 0 {
		return nil, fmt.Errorf("unterminated quote")
	}
	if current.Len() > 0 {
		args = append(args, current.String())
	}
	return args, nil
}
