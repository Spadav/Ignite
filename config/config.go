package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Listen         string                 `yaml:"listen" json:"listen"`
	LogLevel       string                 `yaml:"logLevel" json:"logLevel"`
	Backends       map[string]Backend     `yaml:"backends" json:"backends"`
	ActiveBackend  string                 `yaml:"activeBackend" json:"activeBackend"`
	ModelsPath     string                 `yaml:"modelsPath" json:"modelsPath"`
	MMProjectsPath string                 `yaml:"mmprojectsPath" json:"mmprojectsPath"`
	GPUs           []GPU                  `yaml:"gpus" json:"gpus"`
	TTL            TTL                    `yaml:"ttl" json:"ttl"`
	HealthCheck    HealthCheck            `yaml:"healthCheck" json:"healthCheck"`
	Auth           Auth                   `yaml:"auth" json:"auth"`
	Timbre         Timbre                 `yaml:"timbre" json:"timbre"`
	StartPort      int                    `yaml:"startPort" json:"startPort"`
	Downloads      Downloads              `yaml:"downloads" json:"downloads"`
	Models         map[string]Model       `yaml:"models" json:"models"`
	Groups         map[string]ModelGroup  `yaml:"groups" json:"groups"`
	Path           string                 `yaml:"-" json:"path"`
	Raw            map[string]interface{} `yaml:",inline" json:"-"`
}

type Backend struct {
	Path              string   `yaml:"path" json:"path"`
	Binary            string   `yaml:"binary" json:"binary"`
	Repo              string   `yaml:"repo" json:"repo"`
	BuildDir          string   `yaml:"buildDir" json:"buildDir"`
	CUDACompiler      string   `yaml:"cudaCompiler" json:"cudaCompiler,omitempty"`
	CUDAToolkitRoot   string   `yaml:"cudaToolkitRoot" json:"cudaToolkitRoot,omitempty"`
	CUDAArchitectures []string `yaml:"cudaArchitectures" json:"cudaArchitectures,omitempty"`
	BuildCmd          string   `yaml:"buildCmd" json:"buildCmd"`
}

type GPU struct {
	ID                string `yaml:"id" json:"id"`
	Name              string `yaml:"name" json:"name"`
	VRAM              int    `yaml:"vram" json:"vram"`
	ComputeCapability string `yaml:"computeCapability" json:"computeCapability,omitempty"`
}

type TTL struct {
	Global int `yaml:"global" json:"global"`
}

type HealthCheck struct {
	Model   string `yaml:"model" json:"model"`
	Timeout int    `yaml:"timeout" json:"timeout"`
}

type Auth struct {
	Enabled bool     `yaml:"enabled" json:"enabled"`
	APIKeys []string `yaml:"apiKeys" json:"apiKeys,omitempty"`
}

type Timbre struct {
	Enabled  bool   `yaml:"enabled" json:"enabled"`
	Endpoint string `yaml:"endpoint" json:"endpoint"`
}

type Downloads struct {
	Directory  string `yaml:"directory" json:"directory"`
	Concurrent int    `yaml:"concurrent" json:"concurrent"`
}

type Model struct {
	Family  string   `yaml:"family" json:"family"`
	Profile string   `yaml:"profile" json:"profile"`
	Tags    []string `yaml:"tags" json:"tags"`
	File    string   `yaml:"file" json:"file"`
	MMProj  string   `yaml:"mmproj" json:"mmproj,omitempty"`
	GPU     string   `yaml:"gpu" json:"gpu"`
	TTL     *int     `yaml:"ttl" json:"ttl,omitempty"`
	Args    string   `yaml:"args" json:"args"`
	Aliases []string `yaml:"aliases" json:"aliases"`
}

type ModelGroup struct {
	Swap       bool     `yaml:"swap" json:"swap"`
	Persistent bool     `yaml:"persistent" json:"persistent"`
	Members    []string `yaml:"members" json:"members"`
}

func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return Parse(data, path)
}

func LoadOrCreate(path string) (*Config, error) {
	cfg, err := Load(path)
	if err == nil {
		return cfg, nil
	}
	if !os.IsNotExist(err) {
		return nil, err
	}

	cfg = Default(path)
	if err := cfg.ensureLocalDirs(); err != nil {
		return nil, err
	}
	if err := cfg.Save(); err != nil {
		return nil, err
	}
	return cfg, nil
}

func Default(path string) *Config {
	return &Config{
		Path:           path,
		Listen:         "127.0.0.1:8091",
		LogLevel:       "info",
		ActiveBackend:  "mainline",
		ModelsPath:     "./models",
		MMProjectsPath: "./models/mmproj",
		StartPort:      5800,
		Backends: map[string]Backend{
			"mainline": {
				Path:     "./llama-backends/mainline",
				Binary:   "build-ignite/bin/llama-server",
				BuildDir: "build-ignite",
				Repo:     "https://github.com/ggml-org/llama.cpp",
			},
		},
		GPUs:   []GPU{},
		Models: map[string]Model{},
		Groups: map[string]ModelGroup{},
		TTL: TTL{
			Global: 600,
		},
		HealthCheck: HealthCheck{
			Timeout: 120,
		},
		Auth: Auth{
			Enabled: false,
			APIKeys: []string{},
		},
		Timbre: Timbre{
			Enabled:  false,
			Endpoint: "http://localhost:5100",
		},
		Downloads: Downloads{
			Directory:  "./models",
			Concurrent: 2,
		},
	}
}

func Parse(data []byte, path string) (*Config, error) {
	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	cfg.Path = path
	cfg.applyDefaults()

	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func (c *Config) YAML() ([]byte, error) {
	return yaml.Marshal(c)
}

func (c *Config) Clone() (*Config, error) {
	data, err := c.YAML()
	if err != nil {
		return nil, err
	}
	return Parse(data, c.Path)
}

func (c *Config) Save() error {
	if c.Path == "" {
		return errors.New("config path is empty")
	}
	if err := os.MkdirAll(filepath.Dir(c.Path), 0o755); err != nil {
		return err
	}
	data, err := c.YAML()
	if err != nil {
		return err
	}
	tmp := c.Path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, c.Path)
}

func (c *Config) ensureLocalDirs() error {
	base := filepath.Dir(c.Path)
	for _, dir := range []string{
		c.ModelsPath,
		c.MMProjectsPath,
		filepath.Join(base, "llama-backends"),
		filepath.Join(base, "logs"),
		filepath.Join(base, "state"),
		filepath.Join(base, "backups"),
	} {
		if err := os.MkdirAll(expandPath(dir), 0o755); err != nil {
			return err
		}
	}
	return nil
}

func (c *Config) Backup() (string, error) {
	if c.Path == "" {
		return "", errors.New("config path is empty")
	}
	data, err := os.ReadFile(c.Path)
	if err != nil {
		return "", err
	}
	dir := filepath.Join(filepath.Dir(c.Path), "backups")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	name := fmt.Sprintf("ignite-%s.yaml", time.Now().Format("20060102-150405"))
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return "", err
	}
	return path, nil
}

func Backups(configPath string) ([]string, error) {
	dir := filepath.Join(filepath.Dir(configPath), "backups")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []string{}, nil
		}
		return nil, err
	}
	out := []string{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".yaml") {
			continue
		}
		out = append(out, filepath.Join(dir, entry.Name()))
	}
	return out, nil
}

func (c *Config) applyDefaults() {
	if c.Listen == "" {
		c.Listen = "127.0.0.1:8091"
	}
	if c.LogLevel == "" {
		c.LogLevel = "info"
	}
	if c.StartPort == 0 {
		c.StartPort = 5800
	}
	if c.HealthCheck.Timeout == 0 {
		c.HealthCheck.Timeout = 120
	}
	if c.TTL.Global == 0 {
		c.TTL.Global = 600
	}
	if c.ModelsPath == "" && c.Path != "" {
		c.ModelsPath = filepath.Join(filepath.Dir(c.Path), "models")
	}
	if c.Downloads.Concurrent == 0 {
		c.Downloads.Concurrent = 2
	}
	if c.Downloads.Directory == "" {
		c.Downloads.Directory = c.ModelsPath
	}
}

func (c *Config) Validate() error {
	var problems []string
	if c.Listen == "" {
		problems = append(problems, "listen is required")
	}
	if c.ModelsPath == "" {
		problems = append(problems, "modelsPath is required")
	}
	if c.MMProjectsPath == "" {
		c.MMProjectsPath = filepath.Join(c.ModelsPath, "mmproj")
	}
	if c.StartPort <= 0 || c.StartPort > 65535 {
		problems = append(problems, "startPort must be in 1..65535")
	}
	if len(c.Backends) == 0 {
		problems = append(problems, "at least one backend is required")
	}
	if c.ActiveBackend == "" {
		problems = append(problems, "activeBackend is required")
	} else if _, ok := c.Backends[c.ActiveBackend]; !ok {
		problems = append(problems, "activeBackend must match a configured backend")
	}
	for id, backend := range c.Backends {
		if strings.TrimSpace(id) == "" {
			problems = append(problems, "backend id cannot be blank")
		}
		if backend.Path == "" {
			problems = append(problems, fmt.Sprintf("backend %q path is required", id))
		}
		if backend.Binary == "" {
			problems = append(problems, fmt.Sprintf("backend %q binary is required", id))
		}
		if backend.BuildDir == "" {
			backend.BuildDir = "build-ignite"
			c.Backends[id] = backend
		}
	}
	for id, model := range c.Models {
		if strings.TrimSpace(id) == "" {
			problems = append(problems, "model id cannot be blank")
		}
		if model.File == "" {
			problems = append(problems, fmt.Sprintf("model %q file is required", id))
		}
		if model.GPU == "" {
			problems = append(problems, fmt.Sprintf("model %q gpu is required", id))
		}
	}
	for groupID, group := range c.Groups {
		for _, modelID := range group.Members {
			if _, ok := c.Models[modelID]; !ok {
				problems = append(problems, fmt.Sprintf("group %q references unknown model %q", groupID, modelID))
			}
		}
	}
	if len(problems) > 0 {
		return errors.New(strings.Join(problems, "; "))
	}
	return nil
}

func (c *Config) ResolveModel(idOrAlias string) (string, Model, bool) {
	if model, ok := c.Models[idOrAlias]; ok {
		return idOrAlias, model, true
	}
	for id, model := range c.Models {
		for _, alias := range model.Aliases {
			if alias == idOrAlias {
				return id, model, true
			}
		}
	}
	return "", Model{}, false
}

func (c *Config) GroupForModel(modelID string) (string, ModelGroup, bool) {
	for groupID, group := range c.Groups {
		for _, member := range group.Members {
			if member == modelID {
				return groupID, group, true
			}
		}
	}
	return "", ModelGroup{}, false
}

func (c *Config) ActiveBackendConfig() Backend {
	return c.Backends[c.ActiveBackend]
}

type Diagnostic struct {
	Kind    string `json:"kind"`
	ID      string `json:"id"`
	Path    string `json:"path"`
	OK      bool   `json:"ok"`
	Message string `json:"message,omitempty"`
}

func (c *Config) Diagnostics() []Diagnostic {
	var out []Diagnostic
	out = append(out, checkPath("modelsPath", "modelsPath", expandPath(c.ModelsPath), true))
	out = append(out, checkPath("mmprojectsPath", "mmprojectsPath", expandPath(c.MMProjectsPath), true))
	for id, backend := range c.Backends {
		backendPath := expandPath(backend.Path)
		out = append(out, checkPath("backendPath", id, backendPath, true))
		out = append(out, checkPath("backendBinary", id, filepath.Join(backendPath, backend.Binary), false))
	}
	for id, model := range c.Models {
		out = append(out, checkPath("modelFile", id, filepath.Join(expandPath(c.ModelsPath), model.File), false))
		if model.MMProj != "" {
			out = append(out, checkPath("mmprojFile", id, filepath.Join(expandPath(c.MMProjectsPath), model.MMProj), false))
		}
	}
	return out
}

func checkPath(kind, id, path string, wantDir bool) Diagnostic {
	info, err := os.Stat(path)
	if err != nil {
		return Diagnostic{Kind: kind, ID: id, Path: path, OK: false, Message: err.Error()}
	}
	if wantDir && !info.IsDir() {
		return Diagnostic{Kind: kind, ID: id, Path: path, OK: false, Message: "expected directory"}
	}
	if !wantDir && info.IsDir() {
		return Diagnostic{Kind: kind, ID: id, Path: path, OK: false, Message: "expected file"}
	}
	return Diagnostic{Kind: kind, ID: id, Path: path, OK: true}
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
