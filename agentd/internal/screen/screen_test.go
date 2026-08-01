package screen

import (
	"strings"
	"testing"
)

func TestWritePlainAndNewline(t *testing.T) {
	m := New(40, 5)
	m.Write([]byte("hello\r\nworld"))
	snap := m.Snapshot()
	if !strings.Contains(snap.Text, "hello") || !strings.Contains(snap.Text, "world") {
		t.Fatalf("expected hello/world in %q", snap.Text)
	}
}

func TestOSCTitle(t *testing.T) {
	m := New(40, 5)
	// OSC 0 ; title BEL
	m.Write([]byte("\x1b]0;Action Required\x07plain"))
	snap := m.Snapshot()
	if snap.OSCTitle != "Action Required" {
		t.Fatalf("title=%q", snap.OSCTitle)
	}
	if !strings.Contains(snap.Text, "plain") {
		t.Fatalf("text=%q", snap.Text)
	}
}

func TestAltScreenEnterLeave(t *testing.T) {
	m := New(20, 4)
	m.Write([]byte("primary\r\n"))
	m.Write([]byte("\x1b[?1049h"))
	m.Write([]byte("alt content"))
	snap := m.Snapshot()
	if !snap.AltScreen {
		t.Fatal("expected alt screen")
	}
	if !strings.Contains(snap.Text, "alt content") {
		t.Fatalf("alt text=%q", snap.Text)
	}
	m.Write([]byte("\x1b[?1049l"))
	snap = m.Snapshot()
	if snap.AltScreen {
		t.Fatal("expected primary restored")
	}
	if !strings.Contains(snap.Text, "primary") {
		t.Fatalf("primary text=%q", snap.Text)
	}
}

func TestCUPAndClear(t *testing.T) {
	m := New(20, 4)
	m.Write([]byte("abcdefghij"))
	m.Write([]byte("\x1b[1;1H\x1b[2J"))
	snap := m.Snapshot()
	// screen cleared — should not contain original mid-line junk only
	if strings.Contains(snap.Text, "abcdefghij") {
		// after ED2 lines reset; text may be empty-ish
		t.Fatalf("expected clear, got %q", snap.Text)
	}
}

func TestStripANSI(t *testing.T) {
	in := "\x1b[31mred\x1b[0m plain"
	out := StripANSI(in)
	if out != "red plain" {
		t.Fatalf("got %q", out)
	}
}

func TestRevisionIncrements(t *testing.T) {
	m := New(10, 3)
	r0 := m.Snapshot().Revision
	m.Write([]byte("x"))
	r1 := m.Snapshot().Revision
	if r1 <= r0 {
		t.Fatalf("revision did not advance %d -> %d", r0, r1)
	}
}

func TestConcurrentWriteSnapshot(t *testing.T) {
	m := New(40, 10)
	done := make(chan struct{})
	go func() {
		for i := 0; i < 200; i++ {
			m.Write([]byte("line\r\n"))
		}
		close(done)
	}()
	for i := 0; i < 200; i++ {
		_ = m.Snapshot()
	}
	<-done
}
