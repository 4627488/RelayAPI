//go:build !windows

package rai

import (
	"golang.org/x/sys/unix"
	"os"
)

func tryOAuthFileLock(file *os.File) (bool, error) {
	err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
	if err == unix.EWOULDBLOCK || err == unix.EAGAIN {
		return false, nil
	}
	return err == nil, err
}
