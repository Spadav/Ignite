package main

import (
	"context"
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"ignite/api"
	"ignite/backend"
	"ignite/config"
	"ignite/downloads"
	"ignite/logger"
	"ignite/process"
	"ignite/router"
	igniteruntime "ignite/runtime"
	"ignite/ttl"
)

//go:embed web/dist/*
var webDist embed.FS

func main() {
	configPath := flag.String("config", "ignite.yaml", "path to ignite YAML config")
	flag.Parse()

	cfg, err := config.LoadOrCreate(*configPath)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	if cfg.Listen == "" {
		cfg.Listen = "127.0.0.1:8091"
	}

	logs, err := logger.New(cfg.LogsPath)
	if err != nil {
		log.Fatalf("init logger: %v", err)
	}
	state := igniteruntime.NewState(cfg)
	manager := process.NewManager(state, logs)
	backendJobs := backend.NewJobManager(state, logs)
	downloadJobs := downloads.NewManager(filepath.Join(filepath.Dir(cfg.Path), "state", "downloads.json"), cfg.Downloads.Directory, logs)
	proxy := router.New(state, manager, logs)
	apiHandlers := api.New(state, manager, backendJobs, downloadJobs, filepath.Join(filepath.Dir(cfg.Path), "state", "onboarding.json"), logs)
	ctx, stopBackground := context.WithCancel(context.Background())
	defer stopBackground()
	go ttl.NewManager(state, manager, logs).Start(ctx)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/models", proxy.Models)
	mux.HandleFunc("POST /v1/chat/completions", proxy.OpenAI)
	mux.HandleFunc("POST /v1/completions", proxy.OpenAI)
	mux.HandleFunc("POST /v1/embeddings", proxy.OpenAI)
	mux.HandleFunc("GET /api/runtime/traffic", proxy.Traffic)

	mux.HandleFunc("GET /api/status", apiHandlers.Status)
	mux.HandleFunc("GET /api/about", apiHandlers.About)
	mux.HandleFunc("GET /api/gpus", apiHandlers.GPUs)
	mux.HandleFunc("GET /api/backends", apiHandlers.Backends)
	mux.HandleFunc("GET /api/backends/{id}/flags", apiHandlers.BackendFlags)
	mux.HandleFunc("POST /api/backends/{id}/build", apiHandlers.BuildBackend)
	mux.HandleFunc("POST /api/backends/{id}/update", apiHandlers.UpdateBackend)
	mux.HandleFunc("GET /api/backend-jobs", apiHandlers.BackendJobs)
	mux.HandleFunc("GET /api/backend-jobs/{id}", apiHandlers.BackendJob)
	mux.HandleFunc("GET /api/models", apiHandlers.Models)
	mux.HandleFunc("GET /api/model-files", apiHandlers.ModelFiles)
	mux.HandleFunc("DELETE /api/model-files", apiHandlers.DeleteModelFile)
	mux.HandleFunc("GET /api/huggingface/repo", apiHandlers.HuggingFaceRepo)
	mux.HandleFunc("GET /api/huggingface/models", apiHandlers.HuggingFaceModels)
	mux.HandleFunc("GET /api/downloads", apiHandlers.Downloads)
	mux.HandleFunc("POST /api/downloads", apiHandlers.StartDownload)
	mux.HandleFunc("DELETE /api/downloads/{id}", apiHandlers.CancelDownload)
	mux.HandleFunc("PUT /api/groups", apiHandlers.UpdateGroups)
	mux.HandleFunc("POST /api/models", apiHandlers.CreateModelConfig)
	mux.HandleFunc("POST /api/models/{id}/load", apiHandlers.LoadModel)
	mux.HandleFunc("POST /api/models/{id}/unload", apiHandlers.UnloadModel)
	mux.HandleFunc("PUT /api/models/{id}/config", apiHandlers.UpdateModelConfig)
	mux.HandleFunc("DELETE /api/models/{id}/config", apiHandlers.DeleteModelConfig)
	mux.HandleFunc("POST /api/models/{id}/duplicate", apiHandlers.DuplicateModelConfig)
	mux.HandleFunc("POST /api/models/unload-all", apiHandlers.UnloadAll)
	mux.HandleFunc("POST /api/runtime/stop", apiHandlers.StopRuntime)
	mux.HandleFunc("GET /api/config", apiHandlers.Config)
	mux.HandleFunc("PUT /api/config", apiHandlers.UpdateConfig)
	mux.HandleFunc("GET /api/config/raw", apiHandlers.ConfigRaw)
	mux.HandleFunc("PUT /api/config/raw", apiHandlers.UpdateConfig)
	mux.HandleFunc("POST /api/config/validate", apiHandlers.ValidateConfig)
	mux.HandleFunc("GET /api/config/backup", apiHandlers.ConfigBackups)
	mux.HandleFunc("POST /api/config/backup", apiHandlers.CreateConfigBackup)
	mux.HandleFunc("GET /api/config/diagnostics", apiHandlers.ConfigDiagnostics)
	mux.HandleFunc("GET /api/logs", apiHandlers.Logs)
	mux.HandleFunc("DELETE /api/logs", apiHandlers.ClearLogs)
	mux.HandleFunc("GET /api/onboarding", apiHandlers.Onboarding)
	mux.HandleFunc("POST /api/onboarding/complete", apiHandlers.CompleteOnboarding)
	mux.Handle("GET /", spaHandler())

	server := &http.Server{
		Addr:              cfg.Listen,
		Handler:           requestLogger(logs, mux),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		logs.Infof("ignite listening on http://%s", cfg.Listen)
		errCh <- server.ListenAndServe()
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	select {
	case sig := <-sigCh:
		logs.Infof("received %s, shutting down", sig)
	case err := <-errCh:
		if err != nil && err != http.ErrServerClosed {
			logs.Errorf("server failed: %v", err)
			os.Exit(1)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	_ = server.Shutdown(ctx)
	if err := manager.UnloadAll(ctx); err != nil {
		logs.Errorf("unload all: %v", err)
	}
}

func spaHandler() http.Handler {
	dist, err := fs.Sub(webDist, "web/dist")
	if err != nil {
		return http.NotFoundHandler()
	}
	files := http.FileServer(http.FS(dist))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "" {
			path = "index.html"
		}
		if file, err := dist.Open(path); err == nil {
			_ = file.Close()
			files.ServeHTTP(w, r)
			return
		}
		r.URL.Path = "/index.html"
		files.ServeHTTP(w, r)
	})
}

func requestLogger(logs *logger.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		tracked := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(tracked, r)
		duration := time.Since(start)
		if r.Method != http.MethodGet || strings.HasPrefix(r.URL.Path, "/v1/") || tracked.status >= 400 || duration >= 2*time.Second {
			logs.Infof("%s %s %d %s", r.Method, r.URL.Path, tracked.status, fmtDuration(duration))
		}
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusWriter) Flush() {
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func fmtDuration(d time.Duration) string {
	if d < time.Second {
		return fmt.Sprintf("%dms", d.Milliseconds())
	}
	return d.Round(time.Millisecond).String()
}
