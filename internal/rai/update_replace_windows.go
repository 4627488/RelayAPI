package rai

import (
	"errors"
	"fmt"
	"os"
)

// Windows permits renaming a running executable, but not replacing its image.
// Keep that image at a reserved backup path until its processes exit. A later
// update removes the backup before moving the then-current executable aside.
func replaceExecutableFile(staged, target string) error {
	return replaceWindowsExecutable(staged, target, os.Rename, os.Remove)
}

func replaceWindowsExecutable(staged, target string, rename func(string, string) error, remove func(string) error) error {
	backup := target + ".rai-old"
	if err := remove(backup); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove previous update backup %s (close older rai processes and retry): %w", backup, err)
	}
	moved := true
	if err := rename(target, backup); err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("move running executable aside: %w", err)
		}
		moved = false
	}
	if err := rename(staged, target); err != nil {
		if moved {
			if restoreErr := rename(backup, target); restoreErr != nil {
				return errors.Join(err, fmt.Errorf("restore failed; previous executable remains at %s: %w", backup, restoreErr))
			}
		}
		return err
	}
	if moved {
		// A running image is still locked. Leaving it here is expected and does
		// not prevent the newly installed target from being launched.
		_ = remove(backup)
	}
	return nil
}
