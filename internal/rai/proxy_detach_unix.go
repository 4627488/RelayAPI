//go:build !windows

package rai

import (
	"os/exec"
	"syscall"
)

func detachProxy(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }
