//go:build windows

package rai

import (
	"os/exec"
	"syscall"
)

func detachProxy(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000008 | 0x00000200, HideWindow: true}
}
