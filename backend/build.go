package backend

import (
	"path/filepath"
	goruntime "runtime"
	"strconv"
	"strings"

	"ignite/config"
	"ignite/gpu"
)

type BuildPlan struct {
	ID                string   `json:"id"`
	Path              string   `json:"path"`
	BuildDir          string   `json:"buildDir"`
	Binary            string   `json:"binary"`
	CUDACompiler      string   `json:"cudaCompiler,omitempty"`
	CUDAToolkitRoot   string   `json:"cudaToolkitRoot,omitempty"`
	CUDAArchitectures []string `json:"cudaArchitectures,omitempty"`
	ConfigureCommand  []string `json:"configureCommand"`
	BuildCommand      []string `json:"buildCommand"`
}

func Plan(id string, cfg config.Backend, detected []gpu.Info) BuildPlan {
	buildDir := cfg.BuildDir
	if buildDir == "" {
		buildDir = "build-ignite"
	}

	archs := cfg.CUDAArchitectures
	if len(archs) == 0 {
		archs = gpu.UniqueArchitectures(detected)
	}

	configure := []string{
		"cmake",
		"-S", cfg.Path,
		"-B", filepath.Join(cfg.Path, buildDir),
		"-DGGML_CUDA=ON",
		"-DCMAKE_BUILD_TYPE=Release",
	}
	if cfg.CUDACompiler != "" {
		configure = append(configure, "-DCMAKE_CUDA_COMPILER="+cfg.CUDACompiler)
	}
	if cfg.CUDAToolkitRoot != "" {
		configure = append(configure, "-DCUDAToolkit_ROOT="+cfg.CUDAToolkitRoot)
	}
	if len(archs) > 0 {
		configure = append(configure, "-DCMAKE_CUDA_ARCHITECTURES="+strings.Join(archs, ";"))
	}

	return BuildPlan{
		ID:                id,
		Path:              cfg.Path,
		BuildDir:          buildDir,
		Binary:            cfg.Binary,
		CUDACompiler:      cfg.CUDACompiler,
		CUDAToolkitRoot:   cfg.CUDAToolkitRoot,
		CUDAArchitectures: archs,
		ConfigureCommand:  configure,
		BuildCommand: []string{
			"cmake",
			"--build", filepath.Join(cfg.Path, buildDir),
			"--config", "Release",
			"-j", strconv.Itoa(goruntime.NumCPU()),
			"--target", "llama-server",
		},
	}
}
