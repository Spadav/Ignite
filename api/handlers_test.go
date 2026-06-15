package api

import "testing"

func TestCompareVersionsHandlesPrereleases(t *testing.T) {
	tests := []struct {
		a    string
		b    string
		want int
	}{
		{"2.0.0-beta.2", "2.0.0-beta.1", 1},
		{"2.0.0-beta.1", "2.0.0-beta.2", -1},
		{"2.0.0", "2.0.0-beta.2", 1},
		{"2.0.0-beta.2", "2.0.0", -1},
		{"v2.1.0", "2.0.9", 1},
		{"2.0.0", "v2.0.0", 0},
	}

	for _, tt := range tests {
		got := compareVersions(tt.a, tt.b)
		switch {
		case tt.want > 0 && got <= 0:
			t.Fatalf("compareVersions(%q, %q) = %d, want positive", tt.a, tt.b, got)
		case tt.want < 0 && got >= 0:
			t.Fatalf("compareVersions(%q, %q) = %d, want negative", tt.a, tt.b, got)
		case tt.want == 0 && got != 0:
			t.Fatalf("compareVersions(%q, %q) = %d, want zero", tt.a, tt.b, got)
		}
	}
}
