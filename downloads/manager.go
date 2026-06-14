package downloads

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"ignite/logger"
)

type Job struct {
	ID         string    `json:"id"`
	Repo       string    `json:"repo,omitempty"`
	Filename   string    `json:"filename"`
	URL        string    `json:"url"`
	Dest       string    `json:"dest"`
	Status     string    `json:"status"`
	Bytes      int64     `json:"bytes"`
	Total      int64     `json:"total"`
	Error      string    `json:"error,omitempty"`
	StartedAt  time.Time `json:"startedAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
	FinishedAt time.Time `json:"finishedAt,omitempty"`
}

type Manager struct {
	mu      sync.Mutex
	state   string
	destDir string
	logs    *logger.Logger
	jobs    map[string]*Job
	cancels map[string]context.CancelFunc
	client  *http.Client
}

func NewManager(statePath, destDir string, logs *logger.Logger) *Manager {
	m := &Manager{
		state:   statePath,
		destDir: expandPath(destDir),
		logs:    logs,
		jobs:    map[string]*Job{},
		cancels: map[string]context.CancelFunc{},
		client:  &http.Client{Timeout: 0},
	}
	m.load()
	m.resume()
	return m
}

func (m *Manager) List() []Job {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Job, 0, len(m.jobs))
	for _, job := range m.jobs {
		out = append(out, *job)
	}
	return out
}

func (m *Manager) Start(repo, filename, rawURL string) (Job, error) {
	if filename == "" || !strings.EqualFold(filepath.Ext(filename), ".gguf") {
		return Job{}, fmt.Errorf("download filename must be a .gguf file")
	}
	if strings.Contains(filename, "/") || strings.Contains(filename, "\\") {
		return Job{}, fmt.Errorf("download filename must not include directories")
	}
	if rawURL == "" {
		return Job{}, fmt.Errorf("download url is required")
	}
	if err := os.MkdirAll(m.destDir, 0o755); err != nil {
		return Job{}, err
	}

	id := stableID(rawURL)
	now := time.Now()
	job := &Job{
		ID:        id,
		Repo:      repo,
		Filename:  filename,
		URL:       rawURL,
		Dest:      filepath.Join(m.destDir, filename),
		Status:    "queued",
		StartedAt: now,
		UpdatedAt: now,
	}

	m.mu.Lock()
	if existing, ok := m.jobs[id]; ok && existing.Status != "failed" && existing.Status != "cancelled" {
		out := *existing
		m.mu.Unlock()
		return out, nil
	}
	m.jobs[id] = job
	m.saveLocked()
	m.mu.Unlock()

	m.launch(id)
	return *job, nil
}

func (m *Manager) Cancel(id string) error {
	m.mu.Lock()
	cancel := m.cancels[id]
	if cancel != nil {
		cancel()
	}
	job, ok := m.jobs[id]
	if ok {
		if job.Status == "completed" || job.Status == "cancelled" || job.Status == "failed" {
			delete(m.jobs, id)
			m.saveLocked()
			m.mu.Unlock()
			return nil
		}
		job.Status = "cancelled"
		job.UpdatedAt = time.Now()
		m.saveLocked()
	}
	m.mu.Unlock()
	return nil
}

func (m *Manager) resume() {
	for id, job := range m.jobs {
		if job.Status == "queued" || job.Status == "downloading" {
			job.Status = "queued"
			m.launch(id)
		}
	}
}

func (m *Manager) launch(id string) {
	ctx, cancel := context.WithCancel(context.Background())
	m.mu.Lock()
	if _, exists := m.cancels[id]; exists {
		m.mu.Unlock()
		cancel()
		return
	}
	m.cancels[id] = cancel
	m.mu.Unlock()
	go m.run(ctx, id)
}

func (m *Manager) run(ctx context.Context, id string) {
	defer func() {
		m.mu.Lock()
		delete(m.cancels, id)
		m.mu.Unlock()
	}()

	m.mu.Lock()
	job := m.jobs[id]
	if job == nil {
		m.mu.Unlock()
		return
	}
	job.Status = "downloading"
	job.Error = ""
	job.UpdatedAt = time.Now()
	m.saveLocked()
	url := job.URL
	dest := job.Dest
	m.mu.Unlock()

	part := dest + ".part"
	offset := fileSize(part)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		m.fail(id, err)
		return
	}
	if offset > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
	}
	resp, err := m.client.Do(req)
	if err != nil {
		m.fail(id, err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 || (offset > 0 && resp.StatusCode != http.StatusPartialContent && resp.StatusCode != http.StatusOK) {
		m.fail(id, fmt.Errorf("download failed: %s", resp.Status))
		return
	}
	if offset > 0 && resp.StatusCode == http.StatusOK {
		offset = 0
		_ = os.Remove(part)
	}

	flags := os.O_CREATE | os.O_WRONLY
	if offset > 0 {
		flags |= os.O_APPEND
	} else {
		flags |= os.O_TRUNC
	}
	file, err := os.OpenFile(part, flags, 0o644)
	if err != nil {
		m.fail(id, err)
		return
	}
	defer file.Close()

	total := resp.ContentLength
	if total > 0 {
		total += offset
	}
	m.updateProgress(id, offset, total)

	buf := make([]byte, 1024*1024)
	written := offset
	lastSave := time.Now()
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, err := file.Write(buf[:n]); err != nil {
				m.fail(id, err)
				return
			}
			written += int64(n)
			if time.Since(lastSave) > time.Second {
				m.updateProgress(id, written, total)
				lastSave = time.Now()
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			if ctx.Err() != nil {
				return
			}
			m.fail(id, readErr)
			return
		}
	}
	if err := file.Close(); err != nil {
		m.fail(id, err)
		return
	}
	if err := os.Rename(part, dest); err != nil {
		m.fail(id, err)
		return
	}

	m.mu.Lock()
	if job := m.jobs[id]; job != nil {
		job.Status = "completed"
		job.Bytes = written
		if job.Total <= 0 {
			job.Total = written
		}
		job.UpdatedAt = time.Now()
		job.FinishedAt = job.UpdatedAt
		m.saveLocked()
	}
	m.mu.Unlock()
	m.logs.Infof("download completed: %s", dest)
}

func (m *Manager) updateProgress(id string, bytes, total int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if job := m.jobs[id]; job != nil {
		job.Bytes = bytes
		if total > 0 {
			job.Total = total
		}
		job.UpdatedAt = time.Now()
		m.saveLocked()
	}
}

func (m *Manager) fail(id string, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if job := m.jobs[id]; job != nil {
		job.Status = "failed"
		job.Error = err.Error()
		job.UpdatedAt = time.Now()
		m.saveLocked()
	}
	m.logs.Errorf("download %s failed: %v", id, err)
}

func (m *Manager) load() {
	data, err := os.ReadFile(m.state)
	if err != nil {
		return
	}
	var jobs []Job
	if err := json.Unmarshal(data, &jobs); err != nil {
		return
	}
	for i := range jobs {
		job := jobs[i]
		m.jobs[job.ID] = &job
	}
}

func (m *Manager) saveLocked() {
	_ = os.MkdirAll(filepath.Dir(m.state), 0o755)
	jobs := make([]Job, 0, len(m.jobs))
	for _, job := range m.jobs {
		jobs = append(jobs, *job)
	}
	data, _ := json.MarshalIndent(jobs, "", "  ")
	_ = os.WriteFile(m.state, data, 0o644)
}

func fileSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return info.Size()
}

func stableID(value string) string {
	sum := sha1.Sum([]byte(value))
	return hex.EncodeToString(sum[:])[:12]
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
