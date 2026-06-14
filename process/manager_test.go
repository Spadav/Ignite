package process

import (
	"reflect"
	"testing"

	"ignite/config"
)

func TestSwapUnloadCandidatesAreScopedToTargetGPU(t *testing.T) {
	cfg := &config.Config{
		Models: map[string]config.Model{
			"target":        {GPU: "GPU-3080"},
			"same-gpu":      {GPU: "GPU-3080"},
			"different-gpu": {GPU: "GPU-4090"},
		},
		Groups: map[string]config.ModelGroup{
			"mixed": {
				Swap:    true,
				Members: []string{"target", "same-gpu", "different-gpu"},
			},
		},
	}

	got := swapUnloadCandidates(cfg, "target")
	want := []string{"same-gpu"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}
