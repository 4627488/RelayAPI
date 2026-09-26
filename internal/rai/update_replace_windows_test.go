package rai

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestWindowsUpdateReplacesRunningExecutable(t *testing.T) {
	const helper = "RAI_TEST_RUNNING_UPDATE"
	if os.Getenv(helper) == "1" {
		target, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		if err := writeFileAtomicWithReplace(target, []byte("new executable"), 0o755, replaceExecutableFile); err != nil {
			t.Fatal(err)
		}
		return
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "rai test.exe")
	if err := os.WriteFile(target, data, 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(target, "-test.run=^TestWindowsUpdateReplacesRunningExecutable$")
	cmd.Env = append(os.Environ(), helper+"=1")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("self-update: %v\n%s", err, output)
	}
	updated, err := os.ReadFile(target)
	if err != nil || string(updated) != "new executable" {
		t.Fatalf("updated binary = %q, %v", updated, err)
	}
	backup, err := os.ReadFile(target + ".rai-old")
	if err != nil || !bytes.Equal(backup, data) {
		t.Fatalf("running image not preserved: %v", err)
	}
	// Once the old process exits, the next update can clean up its backup.
	if err := writeFileAtomicWithReplace(target, []byte("next executable"), 0o755, replaceExecutableFile); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(target + ".rai-old"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale backup: %v", err)
	}
}

func TestWindowsUpdateRestoresOriginalWhenInstallFails(t *testing.T) {
	dir := t.TempDir()
	target, staged := filepath.Join(dir, "rai.exe"), filepath.Join(dir, "new.tmp")
	if err := os.WriteFile(target, []byte("original"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(staged, []byte("new"), 0o755); err != nil {
		t.Fatal(err)
	}
	failure := errors.New("simulated installation failure")
	rename := func(from, to string) error {
		if from == staged {
			return failure
		}
		return os.Rename(from, to)
	}
	err := replaceWindowsExecutable(staged, target, rename, os.Remove)
	if !errors.Is(err, failure) {
		t.Fatalf("error = %v", err)
	}
	data, err := os.ReadFile(target)
	if err != nil || string(data) != "original" {
		t.Fatalf("original lost: %q %v", data, err)
	}
}

func TestWindowsUpdateRefusesLockedBackup(t *testing.T) {
	failure := errors.New("backup is in use")
	err := replaceWindowsExecutable("new.tmp", "rai.exe", func(string, string) error { t.Fatal("must not rename while backup is locked"); return nil }, func(string) error { return failure })
	if !errors.Is(err, failure) || !strings.Contains(err.Error(), "close older rai processes") {
		t.Fatalf("error = %v", err)
	}
}
