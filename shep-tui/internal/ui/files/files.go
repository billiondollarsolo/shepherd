// Package files implements a simple file browser model for the Files stage.
package files

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Entry is one directory listing row.
type Entry struct {
	Name  string
	IsDir bool
}

// Browser is a path + cursor model over a directory listing.
type Browser struct {
	Path    string
	Entries []Entry
	Cursor  int
	Err     string
}

// ListDir reads path with os.ReadDir and replaces Entries (sorted: dirs first, then name).
// Cursor is clamped to the new listing. Path is set to the absolute cleaned path.
func (b *Browser) ListDir(path string) error {
	b.Err = ""
	abs, err := filepath.Abs(path)
	if err != nil {
		b.Err = err.Error()
		return err
	}
	abs = filepath.Clean(abs)

	ents, err := os.ReadDir(abs)
	if err != nil {
		b.Err = err.Error()
		return err
	}

	entries := make([]Entry, 0, len(ents))
	for _, e := range ents {
		// Skip dotfiles for a calm default browser; callers can reimplement later.
		name := e.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		entries = append(entries, Entry{Name: name, IsDir: e.IsDir()})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDir != entries[j].IsDir {
			return entries[i].IsDir
		}
		return entries[i].Name < entries[j].Name
	})

	b.Path = abs
	b.Entries = entries
	if b.Cursor < 0 {
		b.Cursor = 0
	}
	if len(b.Entries) == 0 {
		b.Cursor = 0
	} else if b.Cursor >= len(b.Entries) {
		b.Cursor = len(b.Entries) - 1
	}
	return nil
}

// Selected returns the entry under the cursor, or false if empty.
func (b *Browser) Selected() (Entry, bool) {
	if b.Cursor < 0 || b.Cursor >= len(b.Entries) {
		return Entry{}, false
	}
	return b.Entries[b.Cursor], true
}

// Move adjusts the cursor by delta and clamps to the listing.
func (b *Browser) Move(delta int) {
	if len(b.Entries) == 0 {
		b.Cursor = 0
		return
	}
	b.Cursor += delta
	if b.Cursor < 0 {
		b.Cursor = 0
	}
	if b.Cursor >= len(b.Entries) {
		b.Cursor = len(b.Entries) - 1
	}
}

// Enter opens the selected directory (if any). Non-directories are a no-op (return false).
// Returns true when navigation occurred.
func (b *Browser) Enter() (bool, error) {
	e, ok := b.Selected()
	if !ok || !e.IsDir {
		return false, nil
	}
	next := filepath.Join(b.Path, e.Name)
	if err := b.ListDir(next); err != nil {
		return false, err
	}
	b.Cursor = 0
	return true, nil
}

// Up navigates to the parent directory. Root stays put (returns false).
func (b *Browser) Up() (bool, error) {
	if b.Path == "" {
		return false, fmt.Errorf("files: no path set")
	}
	parent := filepath.Dir(b.Path)
	if parent == b.Path {
		return false, nil
	}
	// Remember current dir name to re-select after listing parent.
	curName := filepath.Base(b.Path)
	if err := b.ListDir(parent); err != nil {
		return false, err
	}
	b.Cursor = 0
	for i, e := range b.Entries {
		if e.Name == curName && e.IsDir {
			b.Cursor = i
			break
		}
	}
	return true, nil
}
