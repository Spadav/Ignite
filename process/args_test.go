package process

import (
	"reflect"
	"testing"
)

func TestSplitArgsPreservesQuotedJSON(t *testing.T) {
	got, err := splitArgs(`--jinja --chat-template-kwargs '{"enable_thinking": false}' -ngl 99`)
	if err != nil {
		t.Fatal(err)
	}

	want := []string{
		"--jinja",
		"--chat-template-kwargs",
		`{"enable_thinking": false}`,
		"-ngl",
		"99",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("splitArgs mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

func TestSplitArgsRejectsUnterminatedQuote(t *testing.T) {
	if _, err := splitArgs(`--jinja "unterminated`); err == nil {
		t.Fatal("expected unterminated quote error")
	}
}
