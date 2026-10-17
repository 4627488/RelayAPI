//go:build !windows

package rai

func enableTerminalANSI(uintptr) bool { return true }
