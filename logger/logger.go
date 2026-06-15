package logger

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"time"
)

var (
	lineSplitPattern = regexp.MustCompile(`\r?\n`)
	unsafeNameChars  = regexp.MustCompile(`[^A-Za-z0-9_.-]+`)
)

type Entry struct {
	Time    time.Time `json:"time"`
	Level   string    `json:"level"`
	Message string    `json:"message"`
}

type Logger struct {
	mu      sync.Mutex
	entries []Entry
	limit   int
	dir     string
}

func New(dir string) (*Logger, error) {
	if dir == "" {
		dir = "logs"
	}
	if err := os.MkdirAll(filepath.Join(dir, "models"), 0o755); err != nil {
		return nil, err
	}
	return &Logger{limit: 500, dir: dir}, nil
}

func (l *Logger) Infof(format string, args ...any) {
	l.add("info", fmt.Sprintf(format, args...))
}

func (l *Logger) Errorf(format string, args ...any) {
	l.add("error", fmt.Sprintf(format, args...))
}

func (l *Logger) Recent() []Entry {
	l.mu.Lock()
	defer l.mu.Unlock()

	out := make([]Entry, len(l.entries))
	copy(out, l.entries)
	return out
}

func (l *Logger) ModelLine(modelID, stream, message string) {
	l.Infof("llama-server[%s] %s: %s", modelID, stream, message)
	l.writeModel(modelID, stream, message)
}

func (l *Logger) Bundle() Bundle {
	return Bundle{
		Directory: l.dir,
		Ignite:    readTail(filepath.Join(l.dir, "ignite.log"), 400),
		Models:    l.modelLogs(),
	}
}

func (l *Logger) add(level, message string) {
	entry := Entry{Time: time.Now(), Level: level, Message: message}
	log.Printf("[%s] %s", level, message)
	l.writeIgnite(entry)

	l.mu.Lock()
	defer l.mu.Unlock()
	l.entries = append(l.entries, entry)
	if len(l.entries) > l.limit {
		l.entries = l.entries[len(l.entries)-l.limit:]
	}
}

type LogFile struct {
	Name  string   `json:"name"`
	Path  string   `json:"path"`
	Lines []string `json:"lines"`
}

type Bundle struct {
	Directory string    `json:"directory"`
	Ignite    LogFile   `json:"ignite"`
	Models    []LogFile `json:"models"`
}

func (l *Logger) writeIgnite(entry Entry) {
	line := fmt.Sprintf("%s [%s] %s\n", entry.Time.Format(time.RFC3339), entry.Level, entry.Message)
	appendLine(filepath.Join(l.dir, "ignite.log"), line)
}

func (l *Logger) writeModel(modelID, stream, message string) {
	line := fmt.Sprintf("%s [%s] %s\n", time.Now().Format(time.RFC3339), stream, message)
	appendLine(filepath.Join(l.dir, "models", safeName(modelID)+".log"), line)
}

func (l *Logger) modelLogs() []LogFile {
	dir := filepath.Join(l.dir, "models")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	out := make([]LogFile, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".log" {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		out = append(out, readTail(path, 260))
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].Name < out[j].Name
	})
	return out
}

func appendLine(path, line string) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer file.Close()
	_, _ = file.WriteString(line)
}

func readTail(path string, limit int) LogFile {
	data, err := os.ReadFile(path)
	logFile := LogFile{Name: filepath.Base(path), Path: path}
	if err != nil {
		return logFile
	}
	lines := lineSplitPattern.Split(string(data), -1)
	filtered := make([]string, 0, len(lines))
	for _, line := range lines {
		if line != "" {
			filtered = append(filtered, line)
		}
	}
	if len(filtered) > limit {
		filtered = filtered[len(filtered)-limit:]
	}
	logFile.Lines = filtered
	return logFile
}

func safeName(value string) string {
	name := unsafeNameChars.ReplaceAllString(value, "_")
	if name == "" {
		return "unknown"
	}
	return name
}
