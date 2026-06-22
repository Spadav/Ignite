package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"ignite/backend"
	"ignite/config"
	"ignite/downloads"
	"ignite/gpu"
	"ignite/logger"
	"ignite/process"
	igniteruntime "ignite/runtime"
	"ignite/version"
)

type Handlers struct {
	state          *igniteruntime.State
	manager        *process.Manager
	jobs           *backend.JobManager
	downloads      *downloads.Manager
	onboardingPath string
	logs           *logger.Logger
	startedAt      time.Time
	updateMu       sync.Mutex
	updateCache    updateInfo
	updateChecked  time.Time
}

func New(state *igniteruntime.State, manager *process.Manager, jobs *backend.JobManager, downloadManager *downloads.Manager, onboardingPath string, logs *logger.Logger) *Handlers {
	return &Handlers{state: state, manager: manager, jobs: jobs, downloads: downloadManager, onboardingPath: onboardingPath, logs: logs, startedAt: time.Now()}
}

func (h *Handlers) Status(w http.ResponseWriter, r *http.Request) {
	cfg := h.state.Config()
	writeJSON(w, http.StatusOK, map[string]any{
		"status":        "ok",
		"uptimeSeconds": int(time.Since(h.startedAt).Seconds()),
		"listen":        cfg.Listen,
		"activeBackend": cfg.ActiveBackend,
		"loadedModels":  h.manager.Snapshot(),
	})
}

func (h *Handlers) About(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"name":    version.Name,
		"version": version.Version,
		"commit":  version.Commit,
		"repo":    version.Repo,
		"links": map[string]string{
			"authorName": version.AuthorName,
			"author":     version.AuthorURL,
			"timbre":     version.TimbreURL,
			"ignite":     igniteRepoURL(),
			"releases":   igniteReleasesURL(),
		},
		"update": h.checkIgniteUpdate(r.Context()),
	})
}

type updateInfo struct {
	Configured     bool   `json:"configured"`
	Available      bool   `json:"available"`
	CurrentVersion string `json:"currentVersion"`
	LatestVersion  string `json:"latestVersion,omitempty"`
	ReleaseURL     string `json:"releaseUrl,omitempty"`
	Prerelease     bool   `json:"prerelease,omitempty"`
	CheckedAt      string `json:"checkedAt,omitempty"`
	Error          string `json:"error,omitempty"`
}

func (h *Handlers) checkIgniteUpdate(ctx context.Context) updateInfo {
	current := strings.TrimPrefix(version.Version, "v")
	if version.Repo == "" {
		return updateInfo{Configured: false, CurrentVersion: current}
	}

	h.updateMu.Lock()
	if time.Since(h.updateChecked) < 6*time.Hour && h.updateCache.CurrentVersion != "" {
		cached := h.updateCache
		h.updateMu.Unlock()
		return cached
	}
	h.updateMu.Unlock()

	info := updateInfo{Configured: true, CurrentVersion: current}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/repos/"+version.Repo+"/releases?per_page=10", nil)
	if err != nil {
		info.Error = err.Error()
		return h.storeUpdateInfo(info)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "Ignite/"+version.Version)

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		info.Error = err.Error()
		return h.storeUpdateInfo(info)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		info.Error = "release feed not found"
		return h.storeUpdateInfo(info)
	}
	if resp.StatusCode >= 400 {
		info.Error = resp.Status
		return h.storeUpdateInfo(info)
	}
	var releases []struct {
		TagName    string `json:"tag_name"`
		HTMLURL    string `json:"html_url"`
		Draft      bool   `json:"draft"`
		Prerelease bool   `json:"prerelease"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&releases); err != nil {
		info.Error = err.Error()
		return h.storeUpdateInfo(info)
	}
	var release struct {
		TagName    string
		HTMLURL    string
		Prerelease bool
	}
	for _, item := range releases {
		if item.Draft || item.TagName == "" {
			continue
		}
		release.TagName = item.TagName
		release.HTMLURL = item.HTMLURL
		release.Prerelease = item.Prerelease
		break
	}
	if release.TagName == "" {
		info.Error = "no published releases found"
		return h.storeUpdateInfo(info)
	}
	latest := strings.TrimPrefix(release.TagName, "v")
	info.LatestVersion = latest
	info.ReleaseURL = release.HTMLURL
	info.Prerelease = release.Prerelease
	info.Available = compareVersions(latest, current) > 0
	return h.storeUpdateInfo(info)
}

func (h *Handlers) storeUpdateInfo(info updateInfo) updateInfo {
	info.CheckedAt = time.Now().Format(time.RFC3339)
	h.updateMu.Lock()
	h.updateCache = info
	h.updateChecked = time.Now()
	h.updateMu.Unlock()
	return info
}

func (h *Handlers) GPUs(w http.ResponseWriter, r *http.Request) {
	detected, err := gpu.Detect()
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"detected": []gpu.Info{},
			"error":    err.Error(),
			"config":   h.state.Config().GPUs,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"detected": detected,
		"config":   h.state.Config().GPUs,
	})
}

func (h *Handlers) Backends(w http.ResponseWriter, r *http.Request) {
	cfg := h.state.Config()
	detected, _ := gpu.Detect()
	plans := make(map[string]backend.BuildPlan, len(cfg.Backends))
	engines := make(map[string]engineInfo, len(cfg.Backends))
	for id, backendCfg := range cfg.Backends {
		plans[id] = backend.Plan(id, backendCfg, detected)
		info := inspectEngine(backendCfg)
		info.ID = id
		engines[id] = info
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"active":  cfg.ActiveBackend,
		"items":   cfg.Backends,
		"plans":   plans,
		"engines": engines,
	})
}

func (h *Handlers) BackendFlags(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	backendCfg, ok := h.state.Config().Backends[id]
	if !ok {
		writeError(w, http.StatusNotFound, "backend not found")
		return
	}
	catalog, err := backend.DiscoverFlags(r.Context(), id, backendCfg)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, catalog)
}

type onboardingState struct {
	Complete bool       `json:"complete"`
	DoneAt   *time.Time `json:"doneAt,omitempty"`
}

func (h *Handlers) Onboarding(w http.ResponseWriter, r *http.Request) {
	state := onboardingState{}
	data, err := os.ReadFile(h.onboardingPath)
	if err == nil {
		_ = json.Unmarshal(data, &state)
	}
	writeJSON(w, http.StatusOK, state)
}

func (h *Handlers) CompleteOnboarding(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	state := onboardingState{Complete: true, DoneAt: &now}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := os.MkdirAll(filepath.Dir(h.onboardingPath), 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := os.WriteFile(h.onboardingPath, data, 0o644); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, state)
}

func (h *Handlers) BuildBackend(w http.ResponseWriter, r *http.Request) {
	job, err := h.jobs.StartBuild(context.Background(), r.PathValue("id"), false)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, job)
}

func (h *Handlers) UpdateBackend(w http.ResponseWriter, r *http.Request) {
	job, err := h.jobs.StartBuild(context.Background(), r.PathValue("id"), true)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, job)
}

func (h *Handlers) BackendJobs(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, h.jobs.List())
}

func (h *Handlers) BackendJob(w http.ResponseWriter, r *http.Request) {
	job, ok := h.jobs.Get(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "backend job not found")
		return
	}
	writeJSON(w, http.StatusOK, job)
}

func (h *Handlers) Models(w http.ResponseWriter, r *http.Request) {
	type response struct {
		ID      string   `json:"id"`
		Family  string   `json:"family"`
		Profile string   `json:"profile"`
		Tags    []string `json:"tags"`
		File    string   `json:"file"`
		MMProj  string   `json:"mmproj,omitempty"`
		GPU     string   `json:"gpu"`
		TTL     *int     `json:"ttl,omitempty"`
		Args    string   `json:"args"`
		Aliases []string `json:"aliases"`
		Status  string   `json:"status"`
	}

	cfg := h.state.Config()
	out := make([]response, 0, len(cfg.Models))
	for id, model := range cfg.Models {
		status := string(process.StatusStopped)
		if loaded, ok := h.manager.Get(id); ok {
			status = string(loaded.Status)
		}
		out = append(out, response{
			ID:      id,
			Family:  model.Family,
			Profile: model.Profile,
			Tags:    model.Tags,
			File:    model.File,
			MMProj:  model.MMProj,
			GPU:     model.GPU,
			TTL:     model.TTL,
			Args:    model.Args,
			Aliases: model.Aliases,
			Status:  status,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *Handlers) ModelFiles(w http.ResponseWriter, r *http.Request) {
	type modelFile struct {
		Name       string   `json:"name"`
		Path       string   `json:"path"`
		Relative   string   `json:"relative"`
		SizeBytes  int64    `json:"sizeBytes"`
		Configured []string `json:"configured"`
	}

	cfg := h.state.Config()
	root := expandUserPath(cfg.ModelsPath)
	configured := map[string][]string{}
	for id, model := range cfg.Models {
		abs, err := filepath.Abs(filepath.Join(root, model.File))
		if err != nil {
			continue
		}
		configured[filepath.Clean(abs)] = append(configured[filepath.Clean(abs)], id)
	}

	var files []modelFile
	if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if entry.IsDir() {
			if entry.Name() == ".git" || entry.Name() == "mmproj" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.EqualFold(filepath.Ext(entry.Name()), ".gguf") {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return nil
		}
		abs, err := filepath.Abs(path)
		if err != nil {
			abs = path
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			rel = entry.Name()
		}
		ids := append([]string{}, configured[filepath.Clean(abs)]...)
		sort.Strings(ids)
		files = append(files, modelFile{
			Name:       entry.Name(),
			Path:       path,
			Relative:   rel,
			SizeBytes:  info.Size(),
			Configured: ids,
		})
		return nil
	}); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	sort.Slice(files, func(i, j int) bool {
		return strings.ToLower(files[i].Relative) < strings.ToLower(files[j].Relative)
	})
	writeJSON(w, http.StatusOK, files)
}

func (h *Handlers) DeleteModelFile(w http.ResponseWriter, r *http.Request) {
	relative := r.URL.Query().Get("relative")
	if relative == "" {
		writeError(w, http.StatusBadRequest, "relative path is required")
		return
	}
	if !strings.EqualFold(filepath.Ext(relative), ".gguf") {
		writeError(w, http.StatusBadRequest, "only .gguf files can be deleted")
		return
	}
	root := expandUserPath(h.state.Config().ModelsPath)
	path, err := safeJoin(root, relative)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := os.Remove(path); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

type hfTreeFile struct {
	Type string `json:"type"`
	Path string `json:"path"`
	Size int64  `json:"size"`
	LFS  *struct {
		Size int64 `json:"size"`
	} `json:"lfs,omitempty"`
}

type hfFileResponse struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	Quant string `json:"quant"`
	Size  int64  `json:"size"`
	URL   string `json:"url"`
}

type hfModelSearchResult struct {
	ID        string           `json:"id"`
	Author    string           `json:"author"`
	Name      string           `json:"name"`
	Downloads int              `json:"downloads"`
	Tags      []string         `json:"tags"`
	Files     []hfFileResponse `json:"files"`
}

func (h *Handlers) HuggingFaceRepo(w http.ResponseWriter, r *http.Request) {
	repo := strings.TrimSpace(r.URL.Query().Get("repo"))
	if repo == "" || !strings.Contains(repo, "/") {
		writeError(w, http.StatusBadRequest, "repo must look like owner/name")
		return
	}
	files, err := h.fetchHuggingFaceFiles(r.Context(), repo)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"repo": repo, "files": files})
}

func (h *Handlers) HuggingFaceModels(w http.ResponseWriter, r *http.Request) {
	limit := 30
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err == nil && parsed > 0 && parsed <= 50 {
			limit = parsed
		}
	}
	query := strings.TrimSpace(r.URL.Query().Get("search"))
	params := url.Values{}
	params.Set("filter", "gguf")
	params.Set("sort", "downloads")
	params.Set("limit", strconv.Itoa(limit))
	if query != "" {
		params.Set("search", query)
	}
	apiURL := "https://huggingface.co/api/models?" + params.Encode()
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, apiURL, nil)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if token := os.Getenv("HF_TOKEN"); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		writeError(w, resp.StatusCode, string(body))
		return
	}
	var raw []struct {
		ID        string   `json:"id"`
		ModelID   string   `json:"modelId"`
		Downloads int      `json:"downloads"`
		Tags      []string `json:"tags"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	results := make([]hfModelSearchResult, len(raw))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 6)
	for i := range raw {
		i := i
		repo := raw[i].ModelID
		if repo == "" {
			repo = raw[i].ID
		}
		author, name := splitRepo(repo)
		results[i] = hfModelSearchResult{
			ID:        repo,
			Author:    author,
			Name:      name,
			Downloads: raw[i].Downloads,
			Tags:      raw[i].Tags,
			Files:     []hfFileResponse{},
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			files, err := h.fetchHuggingFaceFiles(r.Context(), repo)
			if err == nil {
				results[i].Files = files
			}
		}()
	}
	wg.Wait()
	filtered := make([]hfModelSearchResult, 0, len(results))
	for _, result := range results {
		if len(result.Files) > 0 {
			filtered = append(filtered, result)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": filtered})
}

func (h *Handlers) fetchHuggingFaceFiles(ctx context.Context, repo string) ([]hfFileResponse, error) {
	apiURL := "https://huggingface.co/api/models/" + escapeRepo(repo) + "/tree/main?recursive=true"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
	if err != nil {
		return nil, err
	}
	if token := os.Getenv("HF_TOKEN"); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return nil, errors.New(strings.TrimSpace(string(body)))
	}
	var tree []hfTreeFile
	if err := json.NewDecoder(resp.Body).Decode(&tree); err != nil {
		return nil, err
	}
	files := []hfFileResponse{}
	for _, file := range tree {
		if file.Type != "file" || !strings.EqualFold(filepath.Ext(file.Path), ".gguf") {
			continue
		}
		size := file.Size
		if file.LFS != nil && file.LFS.Size > 0 {
			size = file.LFS.Size
		}
		name := filepath.Base(file.Path)
		files = append(files, hfFileResponse{
			Name:  name,
			Path:  file.Path,
			Quant: quantFromGGUF(name),
			Size:  size,
			URL:   "https://huggingface.co/" + repo + "/resolve/main/" + escapePath(file.Path),
		})
	}
	sort.Slice(files, func(i, j int) bool {
		return files[i].Name < files[j].Name
	})
	return files, nil
}

type downloadRequest struct {
	Repo     string `json:"repo"`
	Filename string `json:"filename"`
	URL      string `json:"url"`
}

func (h *Handlers) Downloads(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, h.downloads.List())
}

func (h *Handlers) StartDownload(w http.ResponseWriter, r *http.Request) {
	var req downloadRequest
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	job, err := h.downloads.Start(req.Repo, req.Filename, req.URL)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, job)
}

func (h *Handlers) CancelDownload(w http.ResponseWriter, r *http.Request) {
	if err := h.downloads.Cancel(r.PathValue("id")); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "cancelled"})
}

func expandUserPath(path string) string {
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

type engineInfo struct {
	ID      string `json:"id"`
	Path    string `json:"path"`
	Binary  string `json:"binary"`
	Ready   bool   `json:"ready"`
	Cloned  bool   `json:"cloned"`
	GitHash string `json:"gitHash,omitempty"`
}

func inspectEngine(backendCfg config.Backend) engineInfo {
	path := expandUserPath(backendCfg.Path)
	binary := filepath.Join(path, backendCfg.Binary)
	info := engineInfo{
		Path:   path,
		Binary: binary,
	}
	if stat, err := os.Stat(path); err == nil && stat.IsDir() {
		info.Cloned = true
		info.GitHash = readGitHash(path)
	}
	if stat, err := os.Stat(binary); err == nil && !stat.IsDir() {
		info.Ready = true
	}
	return info
}

func readGitHash(repoPath string) string {
	headPath := filepath.Join(repoPath, ".git", "HEAD")
	data, err := os.ReadFile(headPath)
	if err != nil {
		return ""
	}
	head := strings.TrimSpace(string(data))
	if strings.HasPrefix(head, "ref: ") {
		ref := strings.TrimSpace(strings.TrimPrefix(head, "ref: "))
		data, err := os.ReadFile(filepath.Join(repoPath, ".git", filepath.FromSlash(ref)))
		if err != nil {
			return ""
		}
		head = strings.TrimSpace(string(data))
	}
	if len(head) > 12 {
		return head[:12]
	}
	return head
}

func safeJoin(root, relative string) (string, error) {
	if filepath.IsAbs(relative) {
		return "", errors.New("path must be relative")
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	pathAbs, err := filepath.Abs(filepath.Join(rootAbs, relative))
	if err != nil {
		return "", err
	}
	if pathAbs != rootAbs && !strings.HasPrefix(pathAbs, rootAbs+string(os.PathSeparator)) {
		return "", errors.New("path escapes models directory")
	}
	return pathAbs, nil
}

func escapeRepo(repo string) string {
	parts := strings.Split(repo, "/")
	for i := range parts {
		parts[i] = url.PathEscape(parts[i])
	}
	return strings.Join(parts, "/")
}

func splitRepo(repo string) (string, string) {
	parts := strings.SplitN(repo, "/", 2)
	if len(parts) != 2 {
		return "", repo
	}
	return parts[0], parts[1]
}

func igniteRepoURL() string {
	if version.Repo == "" {
		return ""
	}
	return "https://github.com/" + version.Repo
}

func igniteReleasesURL() string {
	if version.Repo == "" {
		return ""
	}
	return "https://github.com/" + version.Repo + "/releases"
}

func compareVersions(a, b string) int {
	coreA, preA := splitVersion(a)
	coreB, preB := splitVersion(b)
	ap := versionParts(coreA)
	bp := versionParts(coreB)
	for i := 0; i < len(ap) || i < len(bp); i++ {
		av, bv := 0, 0
		if i < len(ap) {
			av = ap[i]
		}
		if i < len(bp) {
			bv = bp[i]
		}
		if av > bv {
			return 1
		}
		if av < bv {
			return -1
		}
	}
	if preA == preB {
		return 0
	}
	if preA == "" {
		return 1
	}
	if preB == "" {
		return -1
	}
	return comparePrerelease(preA, preB)
}

func splitVersion(value string) (string, string) {
	value = strings.TrimPrefix(value, "v")
	value = strings.SplitN(value, "+", 2)[0]
	parts := strings.SplitN(value, "-", 2)
	if len(parts) == 1 {
		return parts[0], ""
	}
	return parts[0], parts[1]
}

func comparePrerelease(a, b string) int {
	ap := strings.Split(a, ".")
	bp := strings.Split(b, ".")
	for i := 0; i < len(ap) || i < len(bp); i++ {
		if i >= len(ap) {
			return -1
		}
		if i >= len(bp) {
			return 1
		}
		ai, aErr := strconv.Atoi(ap[i])
		bi, bErr := strconv.Atoi(bp[i])
		switch {
		case aErr == nil && bErr == nil:
			if ai > bi {
				return 1
			}
			if ai < bi {
				return -1
			}
		case aErr == nil:
			return -1
		case bErr == nil:
			return 1
		default:
			if ap[i] > bp[i] {
				return 1
			}
			if ap[i] < bp[i] {
				return -1
			}
		}
	}
	return 0
}

func versionParts(value string) []int {
	fields := regexp.MustCompile(`[^0-9]+`).Split(value, -1)
	parts := make([]int, 0, len(fields))
	for _, field := range fields {
		if field == "" {
			continue
		}
		n, err := strconv.Atoi(field)
		if err != nil {
			continue
		}
		parts = append(parts, n)
	}
	return parts
}

func escapePath(path string) string {
	parts := strings.Split(path, "/")
	for i := range parts {
		parts[i] = url.PathEscape(parts[i])
	}
	return strings.Join(parts, "/")
}

var quantPattern = regexp.MustCompile(`(?i)(BF16|F16|Q[2-8]_[A-Z0-9_]+|IQ[0-9]_[A-Z0-9_]+)`)

func quantFromGGUF(name string) string {
	matches := quantPattern.FindAllString(strings.TrimSuffix(name, filepath.Ext(name)), -1)
	if len(matches) == 0 {
		return ""
	}
	return matches[len(matches)-1]
}

func (h *Handlers) LoadModel(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(h.state.Config().HealthCheck.Timeout)*time.Second)
	defer cancel()

	loaded, err := h.manager.EnsureLoaded(ctx, id)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, loaded)
}

type modelUpsertRequest struct {
	ID    string       `json:"id"`
	Model config.Model `json:"model"`
	Group string       `json:"group,omitempty"`
}

type duplicateModelRequest struct {
	ID string `json:"id"`
}

func (h *Handlers) UpdateGroups(w http.ResponseWriter, r *http.Request) {
	var groups map[string]config.ModelGroup
	if err := readJSON(r, &groups); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if groups == nil {
		groups = map[string]config.ModelGroup{}
	}

	cfg, err := h.mutateConfig(func(cfg *config.Config) error {
		cfg.Groups = normalizeGroups(groups)
		return nil
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status": "saved",
		"groups": cfg.Groups,
	})
}

func (h *Handlers) CreateModelConfig(w http.ResponseWriter, r *http.Request) {
	var req modelUpsertRequest
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.ID == "" {
		writeError(w, http.StatusBadRequest, "model id is required")
		return
	}

	cfg, err := h.mutateConfig(func(cfg *config.Config) error {
		if _, exists := cfg.Models[req.ID]; exists {
			return errHTTP("model already exists")
		}
		cfg.Models[req.ID] = req.Model
		if req.Group != "" {
			group := cfg.Groups[req.Group]
			group.Members = appendUnique(group.Members, req.ID)
			if !group.Swap {
				group.Swap = true
			}
			cfg.Groups[req.Group] = group
		}
		return nil
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, cfg.Models[req.ID])
}

func (h *Handlers) UpdateModelConfig(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	req, err := readModelUpsertRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	cfg, err := h.mutateConfig(func(cfg *config.Config) error {
		if _, exists := cfg.Models[id]; !exists {
			return errHTTP("model not found")
		}
		cfg.Models[id] = req.Model
		assignModelToGroup(cfg.Groups, id, req.Group)
		return nil
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, cfg.Models[id])
}

func (h *Handlers) DeleteModelConfig(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if loaded, ok := h.manager.Get(id); ok && loaded.Status != process.StatusStopped {
		writeError(w, http.StatusConflict, "unload model before deleting it")
		return
	}

	_, err := h.mutateConfig(func(cfg *config.Config) error {
		if _, exists := cfg.Models[id]; !exists {
			return errHTTP("model not found")
		}
		delete(cfg.Models, id)
		for groupID, group := range cfg.Groups {
			group.Members = removeString(group.Members, id)
			cfg.Groups[groupID] = group
		}
		return nil
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (h *Handlers) DuplicateModelConfig(w http.ResponseWriter, r *http.Request) {
	sourceID := r.PathValue("id")
	var req duplicateModelRequest
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.ID == "" {
		writeError(w, http.StatusBadRequest, "new model id is required")
		return
	}

	cfg, err := h.mutateConfig(func(cfg *config.Config) error {
		source, exists := cfg.Models[sourceID]
		if !exists {
			return errHTTP("source model not found")
		}
		if _, exists := cfg.Models[req.ID]; exists {
			return errHTTP("target model already exists")
		}
		cfg.Models[req.ID] = source
		for groupID, group := range cfg.Groups {
			for _, member := range group.Members {
				if member == sourceID {
					group.Members = appendUnique(group.Members, req.ID)
					cfg.Groups[groupID] = group
					break
				}
			}
		}
		return nil
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, cfg.Models[req.ID])
}

func (h *Handlers) UnloadModel(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	if err := h.manager.Unload(ctx, id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "unloaded"})
}

func (h *Handlers) UnloadAll(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	if err := h.manager.UnloadAll(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "unloaded"})
}

func (h *Handlers) Config(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, h.state.Config())
}

func (h *Handlers) ConfigRaw(w http.ResponseWriter, r *http.Request) {
	data, err := os.ReadFile(h.state.Config().Path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "text/yaml; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func (h *Handlers) ValidateConfig(w http.ResponseWriter, r *http.Request) {
	cfg, err := h.configFromRequest(r)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"valid": false,
			"error": err.Error(),
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"valid":       true,
		"diagnostics": cfg.Diagnostics(),
	})
}

func (h *Handlers) UpdateConfig(w http.ResponseWriter, r *http.Request) {
	cfg, err := h.configFromRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	current := h.state.Config()
	cfg.Path = current.Path
	backupPath, err := current.Backup()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := cfg.Save(); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	h.state.ReplaceConfig(cfg)
	h.logs.Infof("config updated, backup written to %s", backupPath)
	writeJSON(w, http.StatusOK, map[string]any{
		"status":      "saved",
		"backup":      backupPath,
		"config":      cfg,
		"diagnostics": cfg.Diagnostics(),
	})
}

func (h *Handlers) ConfigBackups(w http.ResponseWriter, r *http.Request) {
	backups, err := config.Backups(h.state.Config().Path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, backups)
}

func (h *Handlers) CreateConfigBackup(w http.ResponseWriter, r *http.Request) {
	path, err := h.state.Config().Backup()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": path})
}

func (h *Handlers) ConfigDiagnostics(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, h.state.Config().Diagnostics())
}

func (h *Handlers) configFromRequest(r *http.Request) (*config.Config, error) {
	defer r.Body.Close()
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}

	path := h.state.Config().Path
	contentType := strings.ToLower(r.Header.Get("Content-Type"))
	if strings.HasPrefix(contentType, "text/yaml") ||
		strings.HasPrefix(contentType, "application/yaml") ||
		strings.HasPrefix(contentType, "application/x-yaml") {
		return config.Parse(body, path)
	}

	var cfg config.Config
	if err := json.Unmarshal(body, &cfg); err != nil {
		return config.Parse(body, path)
	}
	cfg.Path = path
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func (h *Handlers) mutateConfig(fn func(*config.Config) error) (*config.Config, error) {
	current := h.state.Config()
	next, err := current.Clone()
	if err != nil {
		return nil, err
	}
	if next.Models == nil {
		next.Models = map[string]config.Model{}
	}
	if next.Groups == nil {
		next.Groups = map[string]config.ModelGroup{}
	}
	if err := fn(next); err != nil {
		return nil, err
	}
	if err := next.Validate(); err != nil {
		return nil, err
	}
	backupPath, err := current.Backup()
	if err != nil {
		return nil, err
	}
	if err := next.Save(); err != nil {
		return nil, err
	}
	h.state.ReplaceConfig(next)
	h.logs.Infof("config updated, backup written to %s", backupPath)
	return next, nil
}

func readJSON(r *http.Request, dst any) error {
	defer r.Body.Close()
	return json.NewDecoder(r.Body).Decode(dst)
}

func readModelUpsertRequest(r *http.Request) (modelUpsertRequest, error) {
	defer r.Body.Close()
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return modelUpsertRequest{}, err
	}
	var wrapped modelUpsertRequest
	if err := json.Unmarshal(body, &wrapped); err != nil {
		return modelUpsertRequest{}, err
	}
	if wrapped.Model.File != "" || wrapped.Model.Args != "" || wrapped.Model.GPU != "" {
		return wrapped, nil
	}
	var model config.Model
	if err := json.Unmarshal(body, &model); err != nil {
		return modelUpsertRequest{}, err
	}
	return modelUpsertRequest{Model: model}, nil
}

func errHTTP(message string) error {
	return errors.New(message)
}

func appendUnique(items []string, value string) []string {
	for _, item := range items {
		if item == value {
			return items
		}
	}
	return append(items, value)
}

func removeString(items []string, value string) []string {
	out := items[:0]
	for _, item := range items {
		if item != value {
			out = append(out, item)
		}
	}
	return out
}

func normalizeGroups(groups map[string]config.ModelGroup) map[string]config.ModelGroup {
	out := make(map[string]config.ModelGroup, len(groups))
	assigned := map[string]bool{}
	keys := make([]string, 0, len(groups))
	for name := range groups {
		keys = append(keys, name)
	}
	sort.Strings(keys)
	for _, name := range keys {
		group := groups[name]
		group.Members = uniqueUnassigned(group.Members, assigned)
		out[name] = group
	}
	return out
}

func assignModelToGroup(groups map[string]config.ModelGroup, modelID, groupID string) {
	for name, group := range groups {
		group.Members = removeString(group.Members, modelID)
		groups[name] = group
	}
	if groupID == "" {
		return
	}
	group := groups[groupID]
	group.Members = appendUnique(group.Members, modelID)
	if !group.Swap {
		group.Swap = true
	}
	groups[groupID] = group
}

func uniqueUnassigned(items []string, assigned map[string]bool) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		if item == "" || assigned[item] {
			continue
		}
		assigned[item] = true
		out = append(out, item)
	}
	return out
}

func (h *Handlers) Logs(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, h.logs.Bundle())
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
