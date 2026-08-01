package palette

import (
	"testing"
)

func cmds() []Command {
	return []Command{
		{ID: "audit", Title: "Open Audit Log", Group: "Views"},
		{ID: "new-session", Title: "New Session", Group: "Actions"},
		{ID: "assign-pen", Title: "Assign to Pen", Group: "Actions"},
		{ID: "theme-dark", Title: "Theme: Dark", Group: "Settings"},
		{ID: "doctor", Title: "Run Doctor", Group: "Meta"},
		{ID: "quit", Title: "Quit", Group: "Meta"},
	}
}

func TestSetItemsEmptyQueryShowsAll(t *testing.T) {
	p := New()
	p.SetItems(cmds())
	if len(p.Filtered) != len(p.Items) {
		t.Fatalf("filtered %d want %d", len(p.Filtered), len(p.Items))
	}
	if p.Query != "" {
		t.Fatalf("query = %q", p.Query)
	}
}

func TestFilterSubstringCaseInsensitive(t *testing.T) {
	p := New()
	p.SetItems(cmds())
	p.Filter("SESSION")
	if len(p.Filtered) != 1 || p.Filtered[0].ID != "new-session" {
		t.Fatalf("got %+v", ids(p.Filtered))
	}
	p.Filter("assign")
	if len(p.Filtered) != 1 || p.Filtered[0].ID != "assign-pen" {
		t.Fatalf("got %+v", ids(p.Filtered))
	}
}

func TestFilterPrefixScoresHigher(t *testing.T) {
	p := New()
	p.SetItems([]Command{
		{ID: "a", Title: "open file"},        // substring "open" at 0 — prefix
		{ID: "b", Title: "reopen last"},      // substring mid
		{ID: "c", Title: "Open Panel"},       // prefix (case)
		{ID: "d", Title: "something opener"}, // mid
	})
	p.Filter("open")
	if len(p.Filtered) < 2 {
		t.Fatalf("expected matches: %+v", ids(p.Filtered))
	}
	// Prefix hits first: "open file" and "Open Panel" before mid-string.
	top := p.Filtered[0].Title
	if top != "open file" && top != "Open Panel" {
		t.Fatalf("prefix should rank first, got %q full=%v", top, titles(p.Filtered))
	}
	// Mid-string "reopen" / "opener" should appear after pure prefixes.
	for i, c := range p.Filtered {
		if c.ID == "b" || c.ID == "d" {
			if i < 2 {
				t.Fatalf("mid-string %q ranked too high at %d: %v", c.Title, i, titles(p.Filtered))
			}
		}
	}
}

func TestFilterExactPrefixOverLonger(t *testing.T) {
	p := New()
	p.SetItems([]Command{
		{ID: "quit-force", Title: "Quit Force"},
		{ID: "quit", Title: "Quit"},
	})
	p.Filter("quit")
	// Both match as prefix; "Quit" is tighter (shorter tail) so ranks first.
	if p.Filtered[0].ID != "quit" {
		t.Fatalf("tighter prefix first: got %v", ids(p.Filtered))
	}
}

func TestFilterNoMatch(t *testing.T) {
	p := New()
	p.SetItems(cmds())
	p.Filter("zzzz-nope")
	if len(p.Filtered) != 0 {
		t.Fatalf("want empty, got %v", ids(p.Filtered))
	}
	if _, ok := p.Selected(); ok {
		t.Fatal("Selected should be false")
	}
}

func TestFilterGroupMatch(t *testing.T) {
	p := New()
	p.SetItems(cmds())
	p.Filter("meta")
	if len(p.Filtered) != 2 {
		t.Fatalf("group meta: %v", ids(p.Filtered))
	}
}

func TestMoveAndSelected(t *testing.T) {
	p := New()
	p.SetItems(cmds())
	if c, ok := p.Selected(); !ok || c.ID != "audit" {
		t.Fatalf("first: %+v ok=%v", c, ok)
	}
	p.Move(2)
	if c, ok := p.Selected(); !ok || c.ID != "assign-pen" {
		t.Fatalf("after +2: %+v", c)
	}
	p.Move(-100)
	if p.Cursor != 0 {
		t.Fatalf("clamp low cursor=%d", p.Cursor)
	}
	p.Move(1000)
	if p.Cursor != len(p.Filtered)-1 {
		t.Fatalf("clamp high cursor=%d", p.Cursor)
	}
}

func TestFilterClampsCursor(t *testing.T) {
	p := New()
	p.SetItems(cmds())
	p.Cursor = 5
	p.Filter("doctor")
	if len(p.Filtered) != 1 {
		t.Fatal(ids(p.Filtered))
	}
	if p.Cursor != 0 {
		t.Fatalf("cursor = %d after filter", p.Cursor)
	}
	c, ok := p.Selected()
	if !ok || c.ID != "doctor" {
		t.Fatalf("selected %+v", c)
	}
}

func TestSetItemsReappliesQuery(t *testing.T) {
	p := New()
	p.SetItems(cmds())
	p.Filter("quit")
	p.SetItems(append(cmds(), Command{ID: "quit-all", Title: "Quit All", Group: "Meta"}))
	if len(p.Filtered) != 2 {
		t.Fatalf("re-filter after SetItems: %v", ids(p.Filtered))
	}
}

func TestEmptyPalette(t *testing.T) {
	p := New()
	p.Filter("x")
	p.Move(1)
	if _, ok := p.Selected(); ok {
		t.Fatal("empty selected")
	}
}

func TestRunOptional(t *testing.T) {
	called := false
	p := New()
	p.SetItems([]Command{{
		ID:    "x",
		Title: "Go",
		Run:   func() { called = true },
	}})
	c, ok := p.Selected()
	if !ok {
		t.Fatal("missing")
	}
	// Model does not auto-run.
	if called {
		t.Fatal("should not auto-run")
	}
	c.Run()
	if !called {
		t.Fatal("manual run failed")
	}
}

func ids(cs []Command) []string {
	out := make([]string, len(cs))
	for i, c := range cs {
		out[i] = c.ID
	}
	return out
}

func titles(cs []Command) []string {
	out := make([]string, len(cs))
	for i, c := range cs {
		out[i] = c.Title
	}
	return out
}

func TestFilterMatchesSubsequence(t *testing.T) {
	p := New()
	p.SetItems([]Command{
		{ID: "action:gitcommit", Title: "Git commit (stage all)", Group: "Git"},
		{ID: "action:launch", Title: "Launch agent…", Group: "Agents"},
		{ID: "action:cost", Title: "Cost table", Group: "Inspect"},
	})
	p.Filter("gc")
	if len(p.Filtered) == 0 || p.Filtered[0].ID != "action:gitcommit" {
		t.Fatalf("gc did not find Git commit: %v", ids(p.Filtered))
	}
	p.Filter("lag")
	if len(p.Filtered) == 0 || p.Filtered[0].ID != "action:launch" {
		t.Fatalf("lag did not find Launch agent: %v", ids(p.Filtered))
	}
	p.Filter("zzz")
	if len(p.Filtered) != 0 {
		t.Fatalf("zzz matched %v", ids(p.Filtered))
	}
}

func TestSubstringStillOutranksSubsequence(t *testing.T) {
	p := New()
	p.SetItems([]Command{
		{ID: "action:chat", Title: "Chat timeline", Group: "Inspect"},
		{ID: "action:cost", Title: "Cost table", Group: "Inspect"},
	})
	// "cost" is a substring of one and a subsequence of neither other title.
	p.Filter("cost")
	if len(p.Filtered) == 0 || p.Filtered[0].ID != "action:cost" {
		t.Fatalf("substring hit not first: %v", ids(p.Filtered))
	}
}
