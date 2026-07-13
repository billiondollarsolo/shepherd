package session

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func seedSessionTemp(spec Spec) (string, error) {
	if spec.ID == "" || len(spec.ID) > 128 || strings.ContainsAny(spec.ID, `/\\`) {
		return "", fmt.Errorf("invalid session id for temporary directory")
	}
	home := homeForSpec(spec)
	if home == "" {
		return "", fmt.Errorf("runtime home is unavailable")
	}
	flockDir := filepath.Join(home, ".flock")
	base := filepath.Join(flockDir, "tmp")
	dir := filepath.Join(base, spec.ID)
	if err := os.RemoveAll(dir); err != nil {
		return "", err
	}
	for _, path := range []string{flockDir, base, dir} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			return "", err
		}
		if err := os.Chmod(path, 0o700); err != nil {
			return "", err
		}
		if spec.Identity != nil {
			if err := os.Chown(path, int(spec.Identity.UID), int(spec.Identity.GID)); err != nil {
				return "", err
			}
		}
	}
	return dir, nil
}

// seedHookConfig merges Shepherd's inert-without-token hook files into the runtime
// user's native agent configuration directory.
