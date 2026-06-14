package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveModelDirectAndAlias(t *testing.T) {
	cfg := &Config{
		Models: map[string]Model{
			"primary": {
				File:    "primary.gguf",
				GPU:     "GPU-1",
				Aliases: []string{"alias-model"},
			},
		},
	}

	id, _, ok := cfg.ResolveModel("primary")
	if !ok || id != "primary" {
		t.Fatalf("direct model resolution failed: id=%q ok=%v", id, ok)
	}

	id, _, ok = cfg.ResolveModel("alias-model")
	if !ok || id != "primary" {
		t.Fatalf("alias model resolution failed: id=%q ok=%v", id, ok)
	}
}

func TestValidateRejectsUnknownGroupMember(t *testing.T) {
	cfg := &Config{
		Listen:        "127.0.0.1:8090",
		ModelsPath:    "/models",
		StartPort:     5800,
		ActiveBackend: "mainline",
		Backends: map[string]Backend{
			"mainline": {Path: "/tmp/llama.cpp", Binary: "build/bin/llama-server"},
		},
		Models: map[string]Model{
			"known": {File: "known.gguf", GPU: "GPU-1"},
		},
		Groups: map[string]ModelGroup{
			"default": {Swap: true, Members: []string{"known", "missing"}},
		},
	}

	if err := cfg.Validate(); err == nil {
		t.Fatal("expected validation error for unknown group member")
	}
}

func TestExampleYAMLLoads(t *testing.T) {
	cfg, err := Load("../ignite.example.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ModelsPath != "./models" {
		t.Fatalf("unexpected modelsPath: %s", cfg.ModelsPath)
	}
	if len(cfg.Models) != 0 {
		t.Fatalf("expected no example models, got %d", len(cfg.Models))
	}
}

func TestLoadOrCreateWritesDefaultConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ignite.yaml")
	cfg, err := LoadOrCreate(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Path != path {
		t.Fatalf("unexpected path: %s", cfg.Path)
	}
	if cfg.ModelsPath != "./models" {
		t.Fatalf("unexpected modelsPath: %s", cfg.ModelsPath)
	}
	if _, ok := cfg.Backends["mainline"]; !ok {
		t.Fatal("expected mainline backend")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
}

func TestSaveBackupAndDiagnostics(t *testing.T) {
	dir := t.TempDir()
	modelsDir := filepath.Join(dir, "models")
	mmprojDir := filepath.Join(modelsDir, "mmproj")
	backendDir := filepath.Join(dir, "llama.cpp")
	if err := os.MkdirAll(mmprojDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(backendDir, "build-ignite", "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(modelsDir, "model.gguf"), []byte("model"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mmprojDir, "mmproj.gguf"), []byte("mmproj"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(backendDir, "build-ignite", "bin", "llama-server"), []byte("bin"), 0o755); err != nil {
		t.Fatal(err)
	}

	path := filepath.Join(dir, "ignite.yaml")
	cfg := &Config{
		Path:           path,
		Listen:         "127.0.0.1:8091",
		ModelsPath:     modelsDir,
		MMProjectsPath: mmprojDir,
		StartPort:      5800,
		ActiveBackend:  "mainline",
		Backends: map[string]Backend{
			"mainline": {Path: backendDir, Binary: "build-ignite/bin/llama-server", BuildDir: "build-ignite"},
		},
		Models: map[string]Model{
			"model": {File: "model.gguf", MMProj: "mmproj.gguf", GPU: "GPU-1"},
		},
		Groups: map[string]ModelGroup{
			"default": {Swap: true, Members: []string{"model"}},
		},
	}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	if err := cfg.Save(); err != nil {
		t.Fatal(err)
	}
	backup, err := cfg.Backup()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(backup); err != nil {
		t.Fatal(err)
	}
	for _, diagnostic := range cfg.Diagnostics() {
		if !diagnostic.OK {
			t.Fatalf("diagnostic failed: %#v", diagnostic)
		}
	}
}
