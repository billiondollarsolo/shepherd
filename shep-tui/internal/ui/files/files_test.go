package files

import (
	"os"
	"path/filepath"
	"testing"
)

func TestListDirAndNavigate(t *testing.T) {
	root := t.TempDir()
	mustMkdir(t, filepath.Join(root, "sub"))
	mustMkdir(t, filepath.Join(root, "alpha"))
	mustWrite(t, filepath.Join(root, "z.txt"), "z")
	mustWrite(t, filepath.Join(root, "a.txt"), "a")
	mustWrite(t, filepath.Join(root, ".hidden"), "h") // skipped
	mustWrite(t, filepath.Join(root, "sub", "inner.txt"), "i")

	var b Browser
	if err := b.ListDir(root); err != nil {
		t.Fatal(err)
	}
	if b.Path != root && b.Path != filepath.Clean(root) {
		// Abs may resolve; ensure base matches.
		if filepath.Base(b.Path) != filepath.Base(root) {
			t.Fatalf("path = %q root = %q", b.Path, root)
		}
	}
	// dirs first (alpha, sub), then files (a.txt, z.txt) — no .hidden
	names := entryNames(b.Entries)
	want := []string{"alpha", "sub", "a.txt", "z.txt"}
	assertNames(t, names, want)

	// Cursor on first dir; move to "sub"
	if b.Cursor != 0 {
		t.Fatalf("cursor = %d", b.Cursor)
	}
	b.Move(1)
	sel, ok := b.Selected()
	if !ok || sel.Name != "sub" || !sel.IsDir {
		t.Fatalf("selected = %#v ok=%v", sel, ok)
	}

	okNav, err := b.Enter()
	if err != nil || !okNav {
		t.Fatalf("enter: ok=%v err=%v", okNav, err)
	}
	if filepath.Base(b.Path) != "sub" {
		t.Fatalf("path after enter = %q", b.Path)
	}
	assertNames(t, entryNames(b.Entries), []string{"inner.txt"})

	// Enter on file is no-op
	b.Cursor = 0
	okNav, err = b.Enter()
	if err != nil || okNav {
		t.Fatalf("enter file: ok=%v err=%v", okNav, err)
	}

	// Up returns to root and re-selects "sub"
	okNav, err = b.Up()
	if err != nil || !okNav {
		t.Fatalf("up: ok=%v err=%v", okNav, err)
	}
	if filepath.Clean(b.Path) != filepath.Clean(root) {
		// Compare basenames if temp cleanup paths differ by abs form.
		if filepath.Base(b.Path) != filepath.Base(root) {
			t.Fatalf("path after up = %q want root %q", b.Path, root)
		}
	}
	sel, ok = b.Selected()
	if !ok || sel.Name != "sub" {
		t.Fatalf("after up selected = %#v", sel)
	}
}

func TestMoveClamps(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "only.txt"), "x")
	var b Browser
	if err := b.ListDir(root); err != nil {
		t.Fatal(err)
	}
	b.Move(-10)
	if b.Cursor != 0 {
		t.Fatalf("cursor = %d", b.Cursor)
	}
	b.Move(100)
	if b.Cursor != 0 {
		t.Fatalf("cursor = %d", b.Cursor)
	}
}

func TestListDirEmpty(t *testing.T) {
	root := t.TempDir()
	var b Browser
	if err := b.ListDir(root); err != nil {
		t.Fatal(err)
	}
	if len(b.Entries) != 0 || b.Cursor != 0 {
		t.Fatalf("empty browser: %#v", b)
	}
	if _, ok := b.Selected(); ok {
		t.Fatal("selected on empty")
	}
	ok, err := b.Enter()
	if err != nil || ok {
		t.Fatalf("enter empty: %v %v", ok, err)
	}
}

func TestListDirMissing(t *testing.T) {
	var b Browser
	err := b.ListDir(filepath.Join(t.TempDir(), "nope"))
	if err == nil {
		t.Fatal("expected error")
	}
	if b.Err == "" {
		t.Fatal("expected b.Err set")
	}
}

func entryNames(ents []Entry) []string {
	out := make([]string, len(ents))
	for i, e := range ents {
		out[i] = e.Name
	}
	return out
}

func assertNames(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("names len got %d want %d\ngot  %v\nwant %v", len(got), len(want), got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("names[%d]=%q want %q (full %v)", i, got[i], want[i], got)
		}
	}
}

func mustMkdir(t *testing.T, p string) {
	t.Helper()
	if err := os.MkdirAll(p, 0o755); err != nil {
		t.Fatal(err)
	}
}

func mustWrite(t *testing.T, p, body string) {
	t.Helper()
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}
