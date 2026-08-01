package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
)

func TestNewDefaults(t *testing.T) {
	s := New()
	if len(s.Sessions()) != 0 {
		t.Fatal("expected empty sessions")
	}
	if len(s.Pens()) != 0 {
		t.Fatal("expected empty pens")
	}
}

func TestSeedSessionsAndGet(t *testing.T) {
	s := New()
	s.SeedSessions([]domain.Session{
		{ID: "b", Name: "beta", Status: domain.StatusIdle},
		{ID: "a", Name: "alpha", Status: domain.StatusRunning},
		{ID: "", Name: "skip"}, // empty id ignored
	})
	list := s.Sessions()
	if len(list) != 2 {
		t.Fatalf("len = %d, want 2", len(list))
	}
	// Stable by ID.
	if list[0].ID != "a" || list[1].ID != "b" {
		t.Fatalf("order by id: %s, %s", list[0].ID, list[1].ID)
	}
	got, ok := s.Get("a")
	if !ok || got.Name != "alpha" {
		t.Fatalf("Get a = %+v ok=%v", got, ok)
	}
	if _, ok := s.Get("missing"); ok {
		t.Fatal("missing should be false")
	}
}

func TestSeedSessionsReplaces(t *testing.T) {
	s := New()
	s.SeedSessions([]domain.Session{{ID: "x", Name: "old"}})
	s.SeedSessions([]domain.Session{{ID: "y", Name: "new"}})
	if _, ok := s.Get("x"); ok {
		t.Fatal("old session should be gone")
	}
	if _, ok := s.Get("y"); !ok {
		t.Fatal("new session missing")
	}
}

func TestApplyStatus(t *testing.T) {
	s := New()
	s.SeedSessions([]domain.Session{
		{ID: "s1", Name: "one", Status: domain.StatusIdle},
	})
	cost := 0.18
	s.ApplyStatus(backend.StatusUpdate{
		SessionID: "s1",
		Status:    domain.StatusAwaitingInput,
		Telemetry: domain.Telemetry{
			Model:         "claude",
			Tool:          "Read",
			Tokens:        12000,
			ContextTokens: 42,
			ContextLimit:  100,
			CostUSD:       &cost,
		},
	})
	got, _ := s.Get("s1")
	if got.Status != domain.StatusAwaitingInput {
		t.Fatalf("status = %s", got.Status)
	}
	if got.Telemetry.Model != "claude" || got.Telemetry.Tool != "Read" {
		t.Fatalf("telemetry = %+v", got.Telemetry)
	}
	// Unknown id ignored.
	s.ApplyStatus(backend.StatusUpdate{SessionID: "nope", Status: domain.StatusError})
	if len(s.Sessions()) != 1 {
		t.Fatal("should not create unknown sessions")
	}
	// Empty session id ignored.
	s.ApplyStatus(backend.StatusUpdate{SessionID: "", Status: domain.StatusError})
}

func TestSetPenTruncatesAndActivates(t *testing.T) {
	s := New()
	s.SetPen("p1", domain.Pen{
		ID:         "pen",
		Name:       "x",
		SessionIDs: []string{"1", "2", "3", "4", "5", "6"},
	})
	p := s.ActivePen("p1")
	if p.ProjectID != "p1" {
		t.Fatalf("project id = %q", p.ProjectID)
	}
	if len(p.SessionIDs) != domain.MaxPenSessions {
		t.Fatalf("truncated: %v", p.SessionIDs)
	}
}

func TestActivePenEmpty(t *testing.T) {
	s := New()
	if p := s.ActivePen("none"); p.ID != "" {
		t.Fatalf("want zero pen, got %+v", p)
	}
}

func TestCreateSwitchPens(t *testing.T) {
	s := New()
	p1, err := s.CreatePen("(default)", "", "Main", domain.PenLayoutCols)
	if err != nil {
		t.Fatal(err)
	}
	if p1.Name != "Main" || p1.ID == "" {
		t.Fatalf("%+v", p1)
	}
	p2, err := s.CreatePen("(default)", "side", "Side", domain.PenLayoutRows)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SwitchActivePen("(default)", p1.ID); err != nil {
		t.Fatal(err)
	}
	if s.ActivePen("(default)").ID != p1.ID {
		t.Fatal(s.ActivePen("(default)"))
	}
	if err := s.SetPenLayout(p2.ID, domain.PenLayoutGrid2x2); err != nil {
		t.Fatal(err)
	}
	got, _ := s.Pen(p2.ID)
	if got.Layout != domain.PenLayoutGrid2x2 {
		t.Fatalf("layout = %q", got.Layout)
	}
	// multi-pen persist
	path := filepath.Join(t.TempDir(), "pens.json")
	if err := s.SavePens(path); err != nil {
		t.Fatal(err)
	}
	s2 := New()
	if err := s2.LoadPens(path); err != nil {
		t.Fatal(err)
	}
	if len(s2.Pens()) != 2 {
		t.Fatalf("pens=%d", len(s2.Pens()))
	}
}

func TestSaveLoadPens(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "pens.json")

	s := New()
	s.SetPen("proj-a", domain.Pen{
		ID:         "pen-a",
		Name:       "Alpha",
		Layout:     domain.PenLayoutCols,
		SessionIDs: []string{"s1", "s2"},
	})
	s.SetPen("proj-b", domain.Pen{
		ID:     "pen-b",
		Name:   "Beta",
		Layout: domain.PenLayoutRows,
	})
	// Second pen on proj-a becomes active.
	s.SetPen("proj-a", domain.Pen{
		ID:         "pen-a2",
		Name:       "Alpha2",
		Layout:     domain.PenLayoutGrid2x2,
		SessionIDs: []string{"s3"},
	})

	if err := s.SavePens(path); err != nil {
		t.Fatalf("save: %v", err)
	}

	// Spot-check JSON shape.
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("json: %v\n%s", err, raw)
	}
	if _, ok := doc["pens"]; !ok {
		t.Fatal("missing pens key")
	}
	if _, ok := doc["active"]; !ok {
		t.Fatal("missing active key")
	}

	// File mode 0600.
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm()&0o077 != 0 {
		t.Fatalf("perms too open: %o", fi.Mode().Perm())
	}

	s2 := New()
	if err := s2.LoadPens(path); err != nil {
		t.Fatalf("load: %v", err)
	}
	pens := s2.Pens()
	if len(pens) != 3 {
		t.Fatalf("pens len = %d, want 3", len(pens))
	}
	active := s2.ActivePen("proj-a")
	if active.ID != "pen-a2" {
		t.Fatalf("active proj-a = %q, want pen-a2", active.ID)
	}
	if active.Layout != domain.PenLayoutGrid2x2 || len(active.SessionIDs) != 1 || active.SessionIDs[0] != "s3" {
		t.Fatalf("active pen = %+v", active)
	}
	activeB := s2.ActivePen("proj-b")
	if activeB.ID != "pen-b" {
		t.Fatalf("active proj-b = %q", activeB.ID)
	}
}

func TestLoadPensMissingFile(t *testing.T) {
	s := New()
	if err := s.LoadPens(filepath.Join(t.TempDir(), "nope.json")); err != nil {
		t.Fatalf("missing file should be ok: %v", err)
	}
}

func TestLoadPensMalformed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bad.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := New()
	if err := s.LoadPens(path); err == nil {
		t.Fatal("want error for malformed json")
	}
}

func TestAliasesRoundTrip(t *testing.T) {
	s := New()
	s.SetAlias("a", "payments")
	s.SetAlias("b", "  ")
	if got := s.Aliases(); got["a"] != "payments" || len(got) != 1 {
		t.Fatalf("aliases = %v", got)
	}

	path := filepath.Join(t.TempDir(), "names.json")
	if err := s.SaveAliases(path); err != nil {
		t.Fatal(err)
	}
	loaded := New()
	if err := loaded.LoadAliases(path); err != nil {
		t.Fatal(err)
	}
	if got := loaded.Aliases()["a"]; got != "payments" {
		t.Fatalf("alias did not survive the file: %q", got)
	}

	s.SetAlias("a", "")
	if got := s.Aliases(); len(got) != 0 {
		t.Fatalf("empty name must clear the alias: %v", got)
	}
}

// A missing names file is the common case, not an error.
func TestLoadAliasesMissingFile(t *testing.T) {
	s := New()
	if err := s.LoadAliases(filepath.Join(t.TempDir(), "nope.json")); err != nil {
		t.Fatal(err)
	}
}
