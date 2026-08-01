// Package agentresume also owns on-disk resume records for agentd restart (H3.3).
package agentresume

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// Record is durable enough to relaunch after agentd restart.
type Record struct {
	SessionID string   `json:"sessionId"`
	AgentKind string   `json:"agentKind"`
	ResumeRef string   `json:"resumeRef"`
	Cwd       string   `json:"cwd"`
	Argv      []string `json:"argv,omitempty"`
	Mode      string   `json:"mode,omitempty"`
}

// Store persists resume records under a state directory.
type Store struct {
	mu   sync.Mutex
	path string
	byID map[string]Record
}

// OpenStore loads (or creates) a JSON store at dir/resume-sessions.json.
func OpenStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &Store{
		path: filepath.Join(dir, "resume-sessions.json"),
		byID: make(map[string]Record),
	}
	raw, err := os.ReadFile(s.path)
	if err == nil && len(raw) > 0 {
		var list []Record
		if json.Unmarshal(raw, &list) == nil {
			for _, r := range list {
				s.byID[r.SessionID] = r
			}
		}
	}
	return s, nil
}

// Put saves or replaces a record.
func (s *Store) Put(r Record) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r.SessionID == "" {
		return nil
	}
	s.byID[r.SessionID] = r
	return s.flushLocked()
}

// Remove drops a session.
func (s *Store) Remove(sessionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.byID, sessionID)
	return s.flushLocked()
}

// List returns all records.
func (s *Store) List() []Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Record, 0, len(s.byID))
	for _, r := range s.byID {
		out = append(out, r)
	}
	return out
}

// Get returns a record by session id.
func (s *Store) Get(sessionID string) (Record, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.byID[sessionID]
	return r, ok
}

// RelaunchCommands returns argv for each record that can resume.
func (s *Store) RelaunchCommands() []struct {
	Record  Record
	Command []string
} {
	var out []struct {
		Record  Record
		Command []string
	}
	for _, r := range s.List() {
		cmd := Command(Ref{AgentKind: r.AgentKind, SessionID: r.ResumeRef, Cwd: r.Cwd})
		if cmd == nil && len(r.Argv) > 0 {
			cmd = append([]string(nil), r.Argv...)
		}
		if cmd == nil {
			continue
		}
		out = append(out, struct {
			Record  Record
			Command []string
		}{r, cmd})
	}
	return out
}

func (s *Store) flushLocked() error {
	list := make([]Record, 0, len(s.byID))
	for _, r := range s.byID {
		list = append(list, r)
	}
	raw, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}
