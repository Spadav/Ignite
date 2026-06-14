package logger

import (
	"fmt"
	"log"
	"sync"
	"time"
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
}

func New() *Logger {
	return &Logger{limit: 500}
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

func (l *Logger) add(level, message string) {
	entry := Entry{Time: time.Now(), Level: level, Message: message}
	log.Printf("[%s] %s", level, message)

	l.mu.Lock()
	defer l.mu.Unlock()
	l.entries = append(l.entries, entry)
	if len(l.entries) > l.limit {
		l.entries = l.entries[len(l.entries)-l.limit:]
	}
}
