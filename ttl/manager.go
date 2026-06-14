package ttl

import (
	"context"
	"time"

	"ignite/logger"
	"ignite/process"
	igniteruntime "ignite/runtime"
)

type Manager struct {
	state    *igniteruntime.State
	process  *process.Manager
	logs     *logger.Logger
	interval time.Duration
}

func NewManager(state *igniteruntime.State, processManager *process.Manager, logs *logger.Logger) *Manager {
	return &Manager{
		state:    state,
		process:  processManager,
		logs:     logs,
		interval: 30 * time.Second,
	}
}

func (m *Manager) Start(ctx context.Context) {
	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.evictExpired(ctx)
		}
	}
}

func (m *Manager) evictExpired(ctx context.Context) {
	cfg := m.state.Config()
	now := time.Now()
	for _, loaded := range m.process.Snapshot() {
		ttlSeconds := cfg.TTL.Global
		if model, ok := cfg.Models[loaded.ModelID]; ok && model.TTL != nil {
			ttlSeconds = *model.TTL
		}
		if ttlSeconds <= 0 || loaded.Status != process.StatusRunning {
			continue
		}
		if now.Sub(loaded.LastRequest) < time.Duration(ttlSeconds)*time.Second {
			continue
		}

		unloadCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		if err := m.process.Unload(unloadCtx, loaded.ModelID); err != nil {
			m.logs.Errorf("ttl unload %s: %v", loaded.ModelID, err)
		} else {
			m.logs.Infof("ttl unloaded idle model %s after %ds", loaded.ModelID, ttlSeconds)
		}
		cancel()
	}
}
