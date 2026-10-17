package rai

import "golang.org/x/sys/windows"

func enableTerminalANSI(fd uintptr) bool {
	var mode uint32
	handle := windows.Handle(fd)
	if windows.GetConsoleMode(handle, &mode) != nil {
		return false
	}
	return windows.SetConsoleMode(handle, mode|windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING) == nil
}
