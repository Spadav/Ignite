package api

import (
	"testing"

	"ignite/config"
)

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

func TestNormalizeGroupsKeepsSingleAssignment(t *testing.T) {
	groups := normalizeGroups(map[string]config.ModelGroup{
		"b": {Swap: true, Members: []string{"same", "other"}},
		"a": {Swap: true, Members: []string{"same", "same"}},
	})

	if got := groups["a"].Members; len(got) != 1 || got[0] != "same" {
		t.Fatalf("unexpected group a members: %#v", got)
	}
	if got := groups["b"].Members; len(got) != 1 || got[0] != "other" {
		t.Fatalf("unexpected group b members: %#v", got)
	}
}

func TestAssignModelToGroupMovesMembership(t *testing.T) {
	groups := map[string]config.ModelGroup{
		"old": {Swap: true, Members: []string{"model-a", "model-b"}},
		"new": {Members: []string{"model-c"}},
	}

	assignModelToGroup(groups, "model-a", "new")

	if contains(groups["old"].Members, "model-a") {
		t.Fatalf("old group still contains model-a: %#v", groups["old"].Members)
	}
	if !contains(groups["new"].Members, "model-a") {
		t.Fatalf("new group missing model-a: %#v", groups["new"].Members)
	}
	if !groups["new"].Swap {
		t.Fatal("new group should default swap on when assigned through model save")
	}
}

func contains(items []string, value string) bool {
	for _, item := range items {
		if item == value {
			return true
		}
	}
	return false
}
