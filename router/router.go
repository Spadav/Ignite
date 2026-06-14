package router

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"

	"ignite/logger"
	"ignite/process"
	igniteruntime "ignite/runtime"
)

type Router struct {
	state    *igniteruntime.State
	manager  *process.Manager
	logs     *logger.Logger
	captures *CaptureStore
}

func New(state *igniteruntime.State, manager *process.Manager, logs *logger.Logger) *Router {
	return &Router{state: state, manager: manager, logs: logs, captures: NewCaptureStore(100)}
}

type Capture struct {
	ID               string `json:"id"`
	Time             string `json:"time"`
	Path             string `json:"path"`
	Model            string `json:"model"`
	ResolvedModel    string `json:"resolvedModel"`
	Status           int    `json:"status"`
	DurationMs       int64  `json:"durationMs"`
	PromptTokens     int    `json:"promptTokens,omitempty"`
	CompletionTokens int    `json:"completionTokens,omitempty"`
	TotalTokens      int    `json:"totalTokens,omitempty"`
	RequestPreview   string `json:"requestPreview"`
	ResponsePreview  string `json:"responsePreview"`
}

type CaptureStore struct {
	mu    sync.Mutex
	limit int
	items []Capture
}

func NewCaptureStore(limit int) *CaptureStore {
	return &CaptureStore{limit: limit}
}

func (s *CaptureStore) Add(c Capture) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.items = append([]Capture{c}, s.items...)
	if len(s.items) > s.limit {
		s.items = s.items[:s.limit]
	}
}

func (s *CaptureStore) List() []Capture {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Capture, len(s.items))
	copy(out, s.items)
	return out
}

func (r *Router) Traffic(w http.ResponseWriter, req *http.Request) {
	writeJSON(w, http.StatusOK, r.captures.List())
}

func (r *Router) Models(w http.ResponseWriter, req *http.Request) {
	type modelResponse struct {
		ID      string   `json:"id"`
		Object  string   `json:"object"`
		OwnedBy string   `json:"owned_by"`
		Status  string   `json:"status"`
		Family  string   `json:"family"`
		Profile string   `json:"profile"`
		GPU     string   `json:"gpu"`
		Aliases []string `json:"aliases"`
	}
	resp := struct {
		Object string          `json:"object"`
		Data   []modelResponse `json:"data"`
	}{Object: "list"}

	cfg := r.state.Config()
	for id, model := range cfg.Models {
		status := string(process.StatusStopped)
		if loaded, ok := r.manager.Get(id); ok {
			status = string(loaded.Status)
		}
		resp.Data = append(resp.Data, modelResponse{
			ID:      id,
			Object:  "model",
			OwnedBy: "ignite",
			Status:  status,
			Family:  model.Family,
			Profile: model.Profile,
			GPU:     model.GPU,
			Aliases: model.Aliases,
		})
	}
	writeJSON(w, http.StatusOK, resp)
}

func (r *Router) OpenAI(w http.ResponseWriter, req *http.Request) {
	started := time.Now()
	body, err := io.ReadAll(req.Body)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	req.Body.Close()

	var payload struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	cfg := r.state.Config()
	modelID, _, ok := cfg.ResolveModel(payload.Model)
	if !ok {
		writeError(w, http.StatusNotFound, fmt.Sprintf("unknown model %q", payload.Model))
		return
	}

	ctx, cancel := context.WithTimeout(req.Context(), time.Duration(cfg.HealthCheck.Timeout)*time.Second)
	defer cancel()

	loaded, err := r.manager.EnsureLoaded(ctx, modelID)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	r.manager.Touch(modelID)

	target, _ := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", loaded.Port))
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.ErrorHandler = func(w http.ResponseWriter, req *http.Request, err error) {
		r.logs.Errorf("proxy %s: %v", modelID, err)
		writeError(w, http.StatusBadGateway, err.Error())
	}
	proxy.Director = func(out *http.Request) {
		out.URL.Scheme = target.Scheme
		out.URL.Host = target.Host
		out.URL.Path = req.URL.Path
		out.URL.RawQuery = req.URL.RawQuery
		out.Host = target.Host
		out.Method = req.Method
		out.Header = req.Header.Clone()
		out.Body = io.NopCloser(bytes.NewReader(body))
		out.ContentLength = int64(len(body))
	}
	recorder := newCaptureResponseWriter(w)
	proxy.ServeHTTP(recorder, req)
	r.captures.Add(newCapture(req, body, recorder, payload.Model, modelID, started))
}

type captureResponseWriter struct {
	http.ResponseWriter
	status int
	body   bytes.Buffer
}

func newCaptureResponseWriter(w http.ResponseWriter) *captureResponseWriter {
	return &captureResponseWriter{ResponseWriter: w, status: http.StatusOK}
}

func (w *captureResponseWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *captureResponseWriter) Write(data []byte) (int, error) {
	if w.body.Len() < 64*1024 {
		remaining := 64*1024 - w.body.Len()
		if len(data) < remaining {
			remaining = len(data)
		}
		_, _ = w.body.Write(data[:remaining])
	}
	return w.ResponseWriter.Write(data)
}

func (w *captureResponseWriter) Flush() {
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func newCapture(req *http.Request, requestBody []byte, response *captureResponseWriter, requestedModel string, resolvedModel string, started time.Time) Capture {
	promptTokens, completionTokens, totalTokens := extractUsage(response.body.Bytes())
	return Capture{
		ID:               fmt.Sprintf("%d", started.UnixNano()),
		Time:             started.Format(time.RFC3339Nano),
		Path:             req.URL.Path,
		Model:            requestedModel,
		ResolvedModel:    resolvedModel,
		Status:           response.status,
		DurationMs:       time.Since(started).Milliseconds(),
		PromptTokens:     promptTokens,
		CompletionTokens: completionTokens,
		TotalTokens:      totalTokens,
		RequestPreview:   previewJSON(requestBody),
		ResponsePreview:  previewJSON(response.body.Bytes()),
	}
}

func extractUsage(body []byte) (int, int, int) {
	var payload struct {
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
			TotalTokens      int `json:"total_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return 0, 0, 0
	}
	return payload.Usage.PromptTokens, payload.Usage.CompletionTokens, payload.Usage.TotalTokens
}

func previewJSON(body []byte) string {
	value := strings.TrimSpace(string(body))
	if len(value) > 2000 {
		return value[:2000] + "..."
	}
	return value
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{
			"message": message,
			"type":    "ignite_error",
		},
	})
}
