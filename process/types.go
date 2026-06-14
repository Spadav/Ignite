package process

import "time"

type Status string

const (
	StatusStarting Status = "starting"
	StatusRunning  Status = "running"
	StatusStopping Status = "stopping"
	StatusStopped  Status = "stopped"
	StatusError    Status = "error"
)

type LoadedModel struct {
	ModelID     string    `json:"modelId"`
	PID         int       `json:"pid"`
	Port        int       `json:"port"`
	GPU         string    `json:"gpu"`
	Status      Status    `json:"status"`
	LoadedAt    time.Time `json:"loadedAt"`
	LastRequest time.Time `json:"lastRequest"`
	Error       string    `json:"error,omitempty"`
}
