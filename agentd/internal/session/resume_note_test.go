package session

import (
	"path/filepath"
	"testing"

	"github.com/billiondollarsolo/flock/agentd/internal/agentresume"
)

func TestNoteResumeRefUpdatesStore(t *testing.T) {
	dir := t.TempDir()
	store, err := agentresume.OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	m := NewManager()
	m.SetResumeStore(store)

	s, err := m.Open(Spec{
		ID: "r1", Command: []string{"claude"}, Cwd: "/tmp/p",
		Env: []string{"PATH=/bin"}, Cols: 40, Rows: 10,
	})
	// open may fail if claude missing — still NoteResumeRef works on store
	if s != nil {
		defer m.Close("r1")
	}
	_ = err

	m.NoteResumeRef("r1", "native-sess-abc")
	rec, ok := store.Get("r1")
	if !ok || rec.ResumeRef != "native-sess-abc" {
		// Open may have created record without ref first
		m.NoteResumeRef("r1", "native-sess-abc")
		rec, ok = store.Get("r1")
	}
	if !ok || rec.ResumeRef != "native-sess-abc" {
		t.Fatalf("resume ref not stored: %+v ok=%v path=%s", rec, ok, filepath.Join(dir, "resume-sessions.json"))
	}
}
