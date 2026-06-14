package runtime

import (
	"sync"

	"ignite/config"
)

type State struct {
	mu  sync.RWMutex
	cfg *config.Config
}

func NewState(cfg *config.Config) *State {
	return &State{cfg: cfg}
}

func (s *State) Config() *config.Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cfg
}

func (s *State) ReplaceConfig(cfg *config.Config) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cfg = cfg
}
