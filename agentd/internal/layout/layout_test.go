package layout

import (
	"path/filepath"
	"testing"
)

func TestSetGetRoundTrip(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if got := s.Get("ws-a"); got != nil {
		t.Fatalf("expected nil for unknown workspace, got %q", got)
	}
	tree := []byte(`{"split":"v","panes":["L","R"]}`)
	if err := s.Set("ws-a", tree); err != nil {
		t.Fatal(err)
	}
	if got := s.Get("ws-a"); string(got) != string(tree) {
		t.Fatalf("round-trip mismatch: %q", got)
	}
}

func TestGetReturnsCopy(t *testing.T) {
	s, _ := Open(t.TempDir())
	_ = s.Set("ws", []byte(`{"a":1}`))
	got := s.Get("ws")
	got[0] = 'X' // mutating the returned slice must not corrupt the store
	if again := s.Get("ws"); string(again) != `{"a":1}` {
		t.Fatalf("store mutated via returned slice: %q", again)
	}
}

func TestPersistsAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	s1, _ := Open(dir)
	_ = s1.Set("proj/path", []byte(`{"layout":"two-pane"}`))
	_ = s1.Set("other", []byte(`{"layout":"single"}`))

	// A fresh Store (daemon restart) must reload from disk.
	s2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := s2.Get("proj/path"); string(got) != `{"layout":"two-pane"}` {
		t.Fatalf("did not reload proj/path: %q", got)
	}
	if got := s2.Get("other"); string(got) != `{"layout":"single"}` {
		t.Fatalf("did not reload other: %q", got)
	}
}

func TestSetOverwrites(t *testing.T) {
	s, _ := Open(t.TempDir())
	_ = s.Set("ws", []byte(`{"v":1}`))
	_ = s.Set("ws", []byte(`{"v":2}`))
	if got := s.Get("ws"); string(got) != `{"v":2}` {
		t.Fatalf("overwrite failed: %q", got)
	}
}

func TestEmptyTreeClears(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	_ = s.Set("ws", []byte(`{"v":1}`))
	if err := s.Set("ws", nil); err != nil {
		t.Fatal(err)
	}
	if got := s.Get("ws"); got != nil {
		t.Fatalf("expected cleared, got %q", got)
	}
	// File should be gone too, so a reopen stays clear.
	s2, _ := Open(dir)
	if got := s2.Get("ws"); got != nil {
		t.Fatalf("cleared workspace reappeared after reopen: %q", got)
	}
}

func TestNoTempFilesLeftBehind(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	_ = s.Set("ws", []byte(`{"v":1}`))
	matches, _ := filepath.Glob(filepath.Join(dir, "*.tmp"))
	if len(matches) != 0 {
		t.Fatalf("temp files left behind: %v", matches)
	}
}
