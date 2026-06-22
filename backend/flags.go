package backend

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"ignite/config"
)

type Flag struct {
	Name         string   `json:"name"`
	Aliases      []string `json:"aliases"`
	Category     string   `json:"category"`
	Kind         string   `json:"kind"`
	ValueHint    string   `json:"valueHint,omitempty"`
	Description  string   `json:"description"`
	Default      string   `json:"default,omitempty"`
	Choices      []string `json:"choices,omitempty"`
	NegativeName string   `json:"negativeName,omitempty"`
	Managed      bool     `json:"managed,omitempty"`
}

type FlagCatalog struct {
	BackendID string `json:"backendId"`
	Binary    string `json:"binary"`
	GitHash   string `json:"gitHash,omitempty"`
	Flags     []Flag `json:"flags"`
}

type cachedCatalog struct {
	key     string
	catalog FlagCatalog
}

var flagCatalogCache = struct {
	sync.Mutex
	items map[string]cachedCatalog
}{items: map[string]cachedCatalog{}}

var (
	headingPattern = regexp.MustCompile(`^-{3,}\s*(.*?)\s*-{3,}$`)
	defaultPattern = regexp.MustCompile(`(?i)\(default:\s*([^\)]+)\)`)
	allowedPattern = regexp.MustCompile(`(?i)allowed values:\s*([^\n]+)`)
)

func DiscoverFlags(ctx context.Context, backendID string, cfg config.Backend) (FlagCatalog, error) {
	binary := filepath.Join(expandBackendPath(cfg.Path), cfg.Binary)
	stat, err := os.Stat(binary)
	if err != nil {
		return FlagCatalog{}, fmt.Errorf("inspect backend binary: %w", err)
	}
	key := fmt.Sprintf("%s:%d:%d", binary, stat.ModTime().UnixNano(), stat.Size())

	flagCatalogCache.Lock()
	if cached, ok := flagCatalogCache.items[backendID]; ok && cached.key == key {
		catalog := cached.catalog
		flagCatalogCache.Unlock()
		return catalog, nil
	}
	flagCatalogCache.Unlock()

	commandCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	output, err := exec.CommandContext(commandCtx, binary, "--help").CombinedOutput()
	if err != nil && len(output) == 0 {
		return FlagCatalog{}, fmt.Errorf("read llama-server flags: %w", err)
	}
	catalog := FlagCatalog{
		BackendID: backendID,
		Binary:    binary,
		GitHash:   backendGitHash(expandBackendPath(cfg.Path)),
		Flags:     ParseFlagHelp(string(output)),
	}
	if len(catalog.Flags) == 0 {
		return FlagCatalog{}, fmt.Errorf("llama-server help did not contain parseable flags")
	}
	flagCatalogCache.Lock()
	flagCatalogCache.items[backendID] = cachedCatalog{key: key, catalog: catalog}
	flagCatalogCache.Unlock()
	return catalog, nil
}

func ParseFlagHelp(help string) []Flag {
	lines := strings.Split(strings.ReplaceAll(help, "\r\n", "\n"), "\n")
	category := "Other"
	var flags []Flag
	for index := 0; index < len(lines); {
		line := strings.TrimRight(lines[index], " \t")
		if match := headingPattern.FindStringSubmatch(strings.TrimSpace(line)); len(match) == 2 {
			category = titleCategory(match[1])
			index++
			continue
		}
		if !strings.HasPrefix(line, "-") {
			index++
			continue
		}

		spec, description := splitFlagLine(line)
		index++
		var continuation []string
		for index < len(lines) {
			next := strings.TrimRight(lines[index], " \t")
			trimmed := strings.TrimSpace(next)
			if strings.HasPrefix(next, "-") || headingPattern.MatchString(trimmed) {
				break
			}
			if trimmed != "" {
				continuation = append(continuation, trimmed)
			}
			index++
		}
		fullDescription := strings.TrimSpace(strings.Join(append([]string{description}, continuation...), " "))
		if flag, ok := parseFlagSpec(spec, fullDescription, category); ok {
			flags = append(flags, flag)
		}
	}
	sort.SliceStable(flags, func(i, j int) bool {
		if flags[i].Category != flags[j].Category {
			return flags[i].Category < flags[j].Category
		}
		return flags[i].Name < flags[j].Name
	})
	return flags
}

func splitFlagLine(line string) (string, string) {
	for index := 0; index < len(line); {
		if line[index] != ' ' {
			index++
			continue
		}
		start := index
		for index < len(line) && line[index] == ' ' {
			index++
		}
		if index-start < 2 {
			continue
		}
		rest := strings.TrimSpace(line[index:])
		if rest == "" || strings.HasPrefix(rest, "-") {
			continue
		}
		return strings.TrimSpace(line[:start]), rest
	}
	return strings.TrimSpace(line), ""
}

func parseFlagSpec(spec, description, category string) (Flag, bool) {
	fields := strings.Fields(spec)
	aliases := make([]string, 0, len(fields))
	valueParts := make([]string, 0, 2)
	for _, field := range fields {
		clean := strings.TrimSuffix(field, ",")
		if strings.HasPrefix(clean, "-") {
			aliases = append(aliases, clean)
		} else {
			valueParts = append(valueParts, clean)
		}
	}
	if len(aliases) == 0 {
		return Flag{}, false
	}
	name := canonicalFlagName(aliases)
	negative := ""
	for _, alias := range aliases {
		if strings.HasPrefix(alias, "--no-") && alias != name {
			negative = alias
			break
		}
	}
	valueHint := strings.Join(valueParts, " ")
	choices := flagChoices(valueHint, description)
	kind := flagKind(valueHint, choices, negative)
	defaultValue := ""
	if match := defaultPattern.FindStringSubmatch(description); len(match) == 2 {
		defaultValue = strings.Trim(strings.TrimSpace(match[1]), "'\"")
	}
	return Flag{
		Name:         name,
		Aliases:      aliases,
		Category:     category,
		Kind:         kind,
		ValueHint:    valueHint,
		Description:  description,
		Default:      defaultValue,
		Choices:      choices,
		NegativeName: negative,
		Managed:      isManagedFlag(aliases),
	}, true
}

func canonicalFlagName(aliases []string) string {
	for _, alias := range aliases {
		if strings.HasPrefix(alias, "--") && !strings.HasPrefix(alias, "--no-") {
			return alias
		}
	}
	for _, alias := range aliases {
		if strings.HasPrefix(alias, "--") {
			return alias
		}
	}
	return aliases[0]
}

func flagChoices(valueHint, description string) []string {
	for _, pair := range [][2]string{{"[", "]"}, {"{", "}"}} {
		if strings.HasPrefix(valueHint, pair[0]) && strings.HasSuffix(valueHint, pair[1]) {
			inner := strings.TrimSuffix(strings.TrimPrefix(valueHint, pair[0]), pair[1])
			return splitChoices(inner)
		}
	}
	if match := allowedPattern.FindStringSubmatch(description); len(match) == 2 {
		allowed := match[1]
		for _, suffix := range []string{" (default:", " (env:", " default:"} {
			if index := strings.Index(strings.ToLower(allowed), strings.ToLower(suffix)); index >= 0 {
				allowed = allowed[:index]
			}
		}
		return splitChoices(allowed)
	}
	return nil
}

func splitChoices(value string) []string {
	value = strings.NewReplacer(" or ", ",", "|", ",").Replace(value)
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.Trim(strings.TrimSpace(part), "'\".()")
		if part != "" && !strings.Contains(part, " ") {
			out = append(out, part)
		}
	}
	return out
}

func flagKind(valueHint string, choices []string, negative string) string {
	if len(choices) > 0 {
		return "select"
	}
	if valueHint == "" {
		return "boolean"
	}
	upper := strings.ToUpper(valueHint)
	if upper == "N" || upper == "INDEX" || strings.Contains(upper, "<0") {
		return "number"
	}
	if negative != "" {
		return "boolean"
	}
	return "string"
}

func isManagedFlag(aliases []string) bool {
	managed := map[string]bool{
		"-h": true, "--help": true, "--usage": true, "--version": true,
		"-m": true, "--model": true, "--model-url": true, "--host": true, "--port": true,
		"--completion-bash": true, "--list-devices": true, "--cache-list": true,
	}
	for _, alias := range aliases {
		if managed[alias] {
			return true
		}
	}
	return false
}

func titleCategory(value string) string {
	words := strings.Fields(strings.TrimSpace(value))
	for index, word := range words {
		words[index] = strings.ToUpper(word[:1]) + strings.ToLower(word[1:])
	}
	return strings.Join(words, " ")
}

func expandBackendPath(path string) string {
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

func backendGitHash(path string) string {
	data, err := os.ReadFile(filepath.Join(path, ".git", "HEAD"))
	if err != nil {
		return ""
	}
	head := strings.TrimSpace(string(data))
	if strings.HasPrefix(head, "ref: ") {
		ref := strings.TrimSpace(strings.TrimPrefix(head, "ref: "))
		if data, err = os.ReadFile(filepath.Join(path, ".git", filepath.FromSlash(ref))); err != nil {
			return ""
		}
		head = strings.TrimSpace(string(data))
	}
	if len(head) > 12 {
		return head[:12]
	}
	return head
}
