package rai

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strings"
)

type Command struct {
	Path string
	Args []string
	Env  []string
	Dir  string
}

type Runner func(ctx context.Context, command Command, stdin io.Reader, stdout, stderr io.Writer) error

func DefaultRunner() Runner {
	return runAttached
}

func runAttached(ctx context.Context, command Command, stdin io.Reader, stdout, stderr io.Writer) error {
	if command.Path == "" {
		return errors.New("executable path is empty")
	}
	cmd := exec.CommandContext(ctx, command.Path, command.Args...)
	cmd.Stdin = stdin
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.Dir = command.Dir
	if len(command.Env) > 0 {
		cmd.Env = command.Env
	}
	signal.Ignore(os.Interrupt)
	defer signal.Reset(os.Interrupt)
	if err := cmd.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return ExitError{Code: exit.ExitCode()}
		}
		return err
	}
	return nil
}

type ExitError struct {
	Code int
}

func (e ExitError) Error() string {
	return fmt.Sprintf("exit status %d", e.Code)
}

func mergeEnv(base []string, extra map[string]string) []string {
	if extra == nil {
		return append([]string(nil), base...)
	}
	index := map[string]int{}
	out := make([]string, 0, len(base)+len(extra))
	for _, item := range base {
		key, _, ok := strings.Cut(item, "=")
		if !ok {
			out = append(out, item)
			continue
		}
		if i, exists := index[key]; exists {
			out[i] = item
			continue
		}
		index[key] = len(out)
		out = append(out, item)
	}
	for key, value := range extra {
		item := key + "=" + value
		if i, exists := index[key]; exists {
			out[i] = item
			continue
		}
		index[key] = len(out)
		out = append(out, item)
	}
	return out
}

func lookPath(name string) (string, error) {
	path, err := exec.LookPath(name)
	if err != nil {
		return "", fmt.Errorf("%s is not on PATH", name)
	}
	return path, nil
}
