//go:build !windows

package rai

import "os"

func replaceExecutableFile(staged, target string) error {
	return os.Rename(staged, target)
}
