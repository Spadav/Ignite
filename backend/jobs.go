package backend

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"ignite/gpu"
	"ignite/logger"
	igniteruntime "ignite/runtime"
)

type JobStatus string

const (
	JobQueued    JobStatus = "queued"
	JobRunning   JobStatus = "running"
	JobSucceeded JobStatus = "succeeded"
	JobFailed    JobStatus = "failed"
)

type Job struct {
	ID        string    `json:"id"`
	BackendID string    `json:"backendId"`
	Kind      string    `json:"kind"`
	Status    JobStatus `json:"status"`
	StartedAt time.Time `json:"startedAt"`
	EndedAt   time.Time `json:"endedAt,omitempty"`
	Error     string    `json:"error,omitempty"`
	Logs      []string  `json:"logs"`
	Plan      BuildPlan `json:"plan"`
}

type JobManager struct {
	state *igniteruntime.State
	logs  *logger.Logger
	mu    sync.Mutex
	jobs  map[string]*Job
}

func NewJobManager(state *igniteruntime.State, logs *logger.Logger) *JobManager {
	return &JobManager{
		state: state,
		logs:  logs,
		jobs:  map[string]*Job{},
	}
}

func (m *JobManager) StartBuild(ctx context.Context, backendID string, updateFirst bool) (Job, error) {
	cfg := m.state.Config()
	backendCfg, ok := cfg.Backends[backendID]
	if !ok {
		return Job{}, fmt.Errorf("unknown backend %q", backendID)
	}
	detected, _ := gpu.Detect()
	job := &Job{
		ID:        fmt.Sprintf("%d", time.Now().UnixNano()),
		BackendID: backendID,
		Kind:      "build",
		Status:    JobQueued,
		StartedAt: time.Now(),
		Plan:      Plan(backendID, backendCfg, detected),
	}
	if updateFirst {
		job.Kind = "update"
	}

	m.mu.Lock()
	m.jobs[job.ID] = job
	m.mu.Unlock()

	go m.run(ctx, job, updateFirst)
	return m.copyJob(job), nil
}

func (m *JobManager) List() []Job {
	m.mu.Lock()
	defer m.mu.Unlock()

	out := make([]Job, 0, len(m.jobs))
	for _, job := range m.jobs {
		out = append(out, m.copyJob(job))
	}
	return out
}

func (m *JobManager) Get(id string) (Job, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	job, ok := m.jobs[id]
	if !ok {
		return Job{}, false
	}
	return m.copyJob(job), true
}

func (m *JobManager) run(ctx context.Context, job *Job, updateFirst bool) {
	m.setStatus(job, JobRunning, "")
	defer func() {
		if r := recover(); r != nil {
			m.setStatus(job, JobFailed, fmt.Sprintf("panic: %v", r))
		}
	}()

	if updateFirst {
		if err := m.runCommand(ctx, job, job.Plan.Path, []string{"git", "pull", "--ff-only"}); err != nil {
			m.setStatus(job, JobFailed, err.Error())
			return
		}
	}
	if _, err := os.Stat(job.Plan.Path); err != nil {
		if !os.IsNotExist(err) {
			m.setStatus(job, JobFailed, err.Error())
			return
		}
		repo := m.state.Config().Backends[job.BackendID].Repo
		if repo == "" {
			m.setStatus(job, JobFailed, "backend repo is not configured")
			return
		}
		if err := os.MkdirAll(filepath.Dir(job.Plan.Path), 0o755); err != nil {
			m.setStatus(job, JobFailed, err.Error())
			return
		}
		if err := m.runCommand(ctx, job, "", []string{"git", "clone", repo, job.Plan.Path}); err != nil {
			m.setStatus(job, JobFailed, err.Error())
			return
		}
	}
	if err := m.runCommand(ctx, job, "", job.Plan.ConfigureCommand); err != nil {
		m.setStatus(job, JobFailed, err.Error())
		return
	}
	if err := m.runCommand(ctx, job, "", job.Plan.BuildCommand); err != nil {
		m.setStatus(job, JobFailed, err.Error())
		return
	}
	m.setStatus(job, JobSucceeded, "")
}

func (m *JobManager) runCommand(ctx context.Context, job *Job, dir string, args []string) error {
	if len(args) == 0 {
		return errors.New("empty command")
	}
	m.appendLog(job, "$ "+stringsJoin(args))
	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	if dir != "" {
		cmd.Dir = dir
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go m.scan(job, &wg, stdout)
	go m.scan(job, &wg, stderr)
	wg.Wait()

	if err := cmd.Wait(); err != nil {
		return err
	}
	return nil
}

func (m *JobManager) scan(job *Job, wg *sync.WaitGroup, pipe interface{ Read([]byte) (int, error) }) {
	defer wg.Done()
	scanner := bufio.NewScanner(pipe)
	for scanner.Scan() {
		m.appendLog(job, scanner.Text())
	}
}

func (m *JobManager) setStatus(job *Job, status JobStatus, message string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	job.Status = status
	if message != "" {
		job.Error = message
	}
	if status == JobSucceeded || status == JobFailed {
		job.EndedAt = time.Now()
	}
	m.logs.Infof("backend job %s %s: %s", job.ID, job.BackendID, status)
}

func (m *JobManager) appendLog(job *Job, line string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	job.Logs = append(job.Logs, line)
	if len(job.Logs) > 2000 {
		job.Logs = job.Logs[len(job.Logs)-2000:]
	}
}

func (m *JobManager) copyJob(job *Job) Job {
	copy := *job
	copy.Logs = append([]string{}, job.Logs...)
	return copy
}

func stringsJoin(args []string) string {
	out := ""
	for i, arg := range args {
		if i > 0 {
			out += " "
		}
		out += arg
	}
	return out
}
