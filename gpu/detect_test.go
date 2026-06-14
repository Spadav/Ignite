package gpu

import (
	"reflect"
	"testing"
)

func TestParseNvidiaSMI(t *testing.T) {
	input := []byte("GPU-a, NVIDIA GeForce RTX 4090, 24564, 12000, 17, 54, 8.9\nGPU-b, NVIDIA GeForce RTX 3080, 10002, 512, 0, 41, 8.6\n")
	got := ParseNvidiaSMI(input)
	if len(got) != 2 {
		t.Fatalf("expected 2 GPUs, got %d", len(got))
	}
	if got[0].CUDAArchitecture != "89" || got[1].CUDAArchitecture != "86" {
		t.Fatalf("unexpected archs: %#v", got)
	}
	if got[0].VRAMUsed != 12000 || got[1].VRAMUsed != 512 {
		t.Fatalf("unexpected used memory: %#v", got)
	}
}

func TestUniqueArchitectures(t *testing.T) {
	got := UniqueArchitectures([]Info{
		{CUDAArchitecture: "89"},
		{CUDAArchitecture: "86"},
		{CUDAArchitecture: "89"},
	})
	want := []string{"89", "86"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}
