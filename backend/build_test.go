package backend

import (
	"reflect"
	"testing"

	"ignite/config"
	"ignite/gpu"
)

func TestPlanUsesDetectedArchitectures(t *testing.T) {
	plan := Plan("mainline", config.Backend{
		Path:            "./llama-backends/llama.cpp",
		Binary:          "build-ignite/bin/llama-server",
		BuildDir:        "build-ignite",
		CUDACompiler:    "/usr/local/cuda-12.8/bin/nvcc",
		CUDAToolkitRoot: "/usr/local/cuda-12.8",
	}, []gpu.Info{
		{CUDAArchitecture: "89"},
		{CUDAArchitecture: "86"},
	})

	if !reflect.DeepEqual(plan.CUDAArchitectures, []string{"89", "86"}) {
		t.Fatalf("unexpected archs: %#v", plan.CUDAArchitectures)
	}
	want := "-DCMAKE_CUDA_ARCHITECTURES=89;86"
	if plan.ConfigureCommand[len(plan.ConfigureCommand)-1] != want {
		t.Fatalf("last configure arg = %q, want %q", plan.ConfigureCommand[len(plan.ConfigureCommand)-1], want)
	}
}
