package rai

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestMergeEnvOverridesAndPreserves(t *testing.T) {
	got := mergeEnv([]string{"PATH=/bin", "HOME=/tmp"}, map[string]string{"RAI_API_KEY": "secret", "PATH": "/opt/bin"})
	if !containsEnv(got, "PATH=/opt/bin") || !containsEnv(got, "HOME=/tmp") || !containsEnv(got, "RAI_API_KEY=secret") {
		t.Fatalf("env = %v", got)
	}
}

func TestRunAttachedReturnsChildExitCode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses a unix stub")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "child")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 7\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	err := runAttached(context.Background(), Command{Path: path}, bytes.NewReader(nil), &bytes.Buffer{}, &bytes.Buffer{})
	var exit ExitError
	if !errors.As(err, &exit) || exit.Code != 7 {
		t.Fatalf("err = %v", err)
	}
}
