package backend

import "testing"

func TestParseFlagHelp(t *testing.T) {
	help := `----- common params -----

-c,    --ctx-size N                     size of the prompt context (default: 0, 0 = loaded from model)
-fa,   --flash-attn [on|off|auto]       set Flash Attention use (default: auto)
-kvo,  --kv-offload, -nkvo, --no-kv-offload
                                        whether to enable KV cache offloading (default: enabled)
--no-host                               bypass host buffer
-ctk,  --cache-type-k TYPE              KV cache data type for K
                                        allowed values: f32, f16, q8_0, q4_0
                                        (default: f16)
-m,    --model FNAME                    model path to load
`
	flags := ParseFlagHelp(help)
	if len(flags) != 6 {
		t.Fatalf("expected 6 flags, got %d: %#v", len(flags), flags)
	}
	byName := map[string]Flag{}
	for _, flag := range flags {
		byName[flag.Name] = flag
	}
	if flag := byName["--ctx-size"]; flag.Kind != "number" || flag.Default != "0, 0 = loaded from model" {
		t.Fatalf("unexpected ctx flag: %#v", flag)
	}
	if flag := byName["--flash-attn"]; flag.Kind != "select" || len(flag.Choices) != 3 {
		t.Fatalf("unexpected flash flag: %#v", flag)
	}
	if flag := byName["--kv-offload"]; flag.Kind != "boolean" || flag.NegativeName != "--no-kv-offload" {
		t.Fatalf("unexpected kv flag: %#v", flag)
	}
	if flag := byName["--no-host"]; flag.Kind != "boolean" || flag.NegativeName != "" {
		t.Fatalf("unexpected standalone negative flag: %#v", flag)
	}
	if flag := byName["--cache-type-k"]; flag.Kind != "select" || len(flag.Choices) != 4 {
		t.Fatalf("unexpected cache flag: %#v", flag)
	}
	if !byName["--model"].Managed {
		t.Fatal("model flag should be managed by Ignite")
	}
}

func TestParseFlagHelpDoesNotTreatCacheRAMAsHeading(t *testing.T) {
	help := `----- common params -----

-cram, --cache-ram N                    set the maximum cache size in MiB (default: 8192, -1 - no limit, 0 -
                                        disable)
--jinja                                 whether to use jinja template engine for chat (default: enabled)
-np,   --parallel N                     number of server slots (default: -1, -1 = auto)
`

	flags := ParseFlagHelp(help)
	if len(flags) != 3 {
		t.Fatalf("expected 3 flags, got %d: %#v", len(flags), flags)
	}
	for _, flag := range flags {
		if flag.Category != "Common Params" {
			t.Fatalf("flag %s has corrupted category %q", flag.Name, flag.Category)
		}
	}
}
