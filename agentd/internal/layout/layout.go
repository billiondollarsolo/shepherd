// Package layout persists per-workspace terminal pane layouts to disk so a user
// can "go away and come back" with their split layout intact — even across a
// daemon restart or node reboot. The layout tree itself is an opaque JSON blob
// authored by the browser (server-authoritative storage, client-authoritative
// shape): the daemon never interprets it, it just stores and returns the latest
// bytes for a workspace key.
//
// One file per workspace under the store dir, named by the hash of the workspace
// key (keys are opaque — a node/project path or session group — so they are NOT
// filesystem-safe). Each file wraps the layout with its workspace + timestamp so
// the cache can be rebuilt on startup. Writes are atomic (temp + rename).
package layout

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// record is the on-disk wrapper: the opaque layout plus enough metadata to
// rebuild the in-memory cache (keyed by workspace) on startup.
type record struct {
	Workspace string          `json:"workspace"`
	Layout    json.RawMessage `json:"layout"`
	UpdatedAt string          `json:"updatedAt"`
}

// Store is a concurrency-safe, disk-backed map of workspace → layout bytes.
type Store struct {
	dir   string
	mu    sync.RWMutex
	cache map[string][]byte
	now   func() time.Time // injectable for tests
}

// Open creates (if needed) the store dir and loads any existing layouts into the
// in-memory cache. A corrupt file is skipped, not fatal.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &Store{dir: dir, cache: make(map[string][]byte), now: time.Now}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		b, rerr := os.ReadFile(filepath.Join(dir, e.Name()))
		if rerr != nil {
			continue
		}
		var rec record
		if json.Unmarshal(b, &rec) != nil || rec.Workspace == "" {
			continue // skip corrupt/partial files
		}
		s.cache[rec.Workspace] = []byte(rec.Layout)
	}
	return s, nil
}

// Get returns the latest layout bytes for a workspace, or nil if none. The
// returned slice is a copy — callers may not mutate the store.
func (s *Store) Get(workspace string) []byte {
	s.mu.RLock()
	defer s.mu.RUnlock()
	b, ok := s.cache[workspace]
	if !ok {
		return nil
	}
	out := make([]byte, len(b))
	copy(out, b)
	return out
}

// Set replaces the layout for a workspace and persists it atomically. An empty
// tree clears the workspace (removes the file).
func (s *Store) Set(workspace string, tree []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	path := s.pathFor(workspace)
	if len(tree) == 0 {
		delete(s.cache, workspace)
		err := os.Remove(path)
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	stored := make([]byte, len(tree))
	copy(stored, tree)
	rec := record{
		Workspace: workspace,
		Layout:    json.RawMessage(stored),
		UpdatedAt: s.now().UTC().Format(time.RFC3339),
	}
	b, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	// Atomic write: temp file in the same dir + rename (rename is atomic on the
	// same filesystem), so a reader never sees a half-written layout.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	s.cache[workspace] = stored
	return nil
}

// pathFor maps an opaque workspace key to a deterministic, filesystem-safe path.
func (s *Store) pathFor(workspace string) string {
	sum := sha256.Sum256([]byte(workspace))
	return filepath.Join(s.dir, hex.EncodeToString(sum[:])+".json")
}
