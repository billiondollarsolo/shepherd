package app

import (
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/billiondollarsolo/shep-tui/internal/domain"
)

// pump mimics the Bubble Tea runtime: it runs cmd and feeds every message it
// produces back into Update, recursively, collecting the messages seen.
// Timer commands (cursor blink, motion ticks) are abandoned rather than waited on.
func pump(t *testing.T, m Model, cmd tea.Cmd) (Model, []tea.Msg) {
	t.Helper()
	var seen []tea.Msg
	var run func(c tea.Cmd, depth int)
	run = func(c tea.Cmd, depth int) {
		if c == nil || depth > 16 {
			return
		}
		msg := runCmd(c)
		switch mm := msg.(type) {
		case nil:
		case tea.BatchMsg:
			for _, sub := range mm {
				run(sub, depth+1)
			}
		default:
			seen = append(seen, msg)
			next, cmd := m.Update(msg)
			m = next.(Model)
			run(cmd, depth+1)
		}
	}
	run(cmd, 0)
	return m, seen
}

// msgOf runs cmd — flattening tea.Batch — and returns the first message of type
// T. A handler that raises a toast also returns its expiry timer, so a command
// is a batch far more often than it used to be.
func msgOf[T tea.Msg](t *testing.T, cmd tea.Cmd) T {
	t.Helper()
	var zero T
	var find func(c tea.Cmd, depth int) (T, bool)
	find = func(c tea.Cmd, depth int) (T, bool) {
		if c == nil || depth > 8 {
			return zero, false
		}
		switch msg := runCmd(c).(type) {
		case tea.BatchMsg:
			for _, sub := range msg {
				if got, ok := find(sub, depth+1); ok {
					return got, true
				}
			}
		case T:
			return msg, true
		}
		return zero, false
	}
	got, ok := find(cmd, 0)
	if !ok {
		t.Fatalf("no %T in the command's messages", zero)
	}
	return got
}

func runCmd(c tea.Cmd) tea.Msg {
	done := make(chan tea.Msg, 1)
	go func() { done <- c() }()
	select {
	case msg := <-done:
		return msg
	case <-time.After(50 * time.Millisecond):
		return nil
	}
}

func TestLaunchFormCompletesThroughUpdate(t *testing.T) {
	m := newModel(Options{Version: "test", SkipSplash: true, Caps: testLocalCaps()})
	next, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'n'}})
	m = next.(Model)
	if m.launchForm == nil || m.stage != StageLaunch {
		t.Fatalf("n should open the launch form: stage=%s form=%v", m.stage, m.launchForm != nil)
	}
	m, _ = pump(t, m, cmd)

	var seen []tea.Msg
	for i := 0; i < 8 && m.launchForm != nil; i++ {
		next, cmd = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
		m = next.(Model)
		var got []tea.Msg
		m, got = pump(t, m, cmd)
		seen = append(seen, got...)
	}
	if m.launchForm != nil {
		t.Fatal("launch form never completed — huh msgs are not reaching the sub-model")
	}
	if m.stage != StageTable {
		t.Fatalf("stage after the wizard closed = %s want the table", m.stage)
	}
	spawned := false
	for _, msg := range seen {
		if _, ok := msg.(spawnDoneMsg); ok {
			spawned = true
		}
	}
	if !spawned {
		t.Fatal("completed form must issue the launch command")
	}
	if !strings.Contains(m.toast.text, "spawn/launch") {
		t.Fatalf("statusMsg = %q want the launch result", m.toast.text)
	}
}

func TestStaleEpochDoesNotCloseReattachedPane(t *testing.T) {
	m := newModel(Options{Version: "test", SkipSplash: true, Sessions: []domain.Session{{ID: "s1"}}})
	m.width, m.height = 100, 30
	stale := m.panes[0].Epoch

	live := &countingStream{}
	m.panes[0].Stream = live
	m.nextEpoch(0)

	// The parked listener of the pane's previous stream fires late.
	next, _ := m.Update(ptyClosedMsg{pane: 0, epoch: stale})
	m = next.(Model)
	if m.panes[0].Stream != live {
		t.Fatal("a stale ptyClosedMsg must not detach the pane's current stream")
	}
	next, _ = m.Update(ptyOutputMsg{pane: 0, epoch: stale, data: []byte("ghost")})
	m = next.(Model)
	if strings.Contains(m.panes[0].screen.String(), "ghost") {
		t.Fatal("a stale ptyOutputMsg must not write into the pane's screen")
	}

	next, _ = m.Update(ptyClosedMsg{pane: 0, epoch: m.panes[0].Epoch})
	m = next.(Model)
	if m.panes[0].Stream != nil {
		t.Fatal("the current epoch's close must detach the pane")
	}
}

func TestStaleAttachClosesOrphanStream(t *testing.T) {
	m := newModel(Options{Version: "test", SkipSplash: true, Sessions: []domain.Session{{ID: "s1"}}})
	m.width, m.height = 100, 30
	stale := m.panes[0].Epoch
	m.nextEpoch(0)

	orphan := &countingStream{}
	next, cmd := m.Update(attachDoneMsg{pane: 0, epoch: stale, stream: orphan})
	m = next.(Model)
	if m.panes[0].Stream != nil {
		t.Fatal("a stale attach must not land in the pane")
	}
	if cmd == nil {
		t.Fatal("the orphan must be closed off the Update goroutine, not inside it")
	}
	m, _ = pump(t, m, cmd)
	if orphan.Closes() != 1 {
		t.Fatalf("orphaned stream closes = %d want 1", orphan.Closes())
	}
}

func TestApplySizeSizesWidgets(t *testing.T) {
	m := newModel(Options{Version: "test", SkipSplash: true})
	next, _ := m.Update(tea.WindowSizeMsg{Width: 120, Height: 40})
	m = next.(Model)
	if m.palInput.Width != paletteInnerWidth(120)-2 {
		t.Fatalf("palInput width = %d", m.palInput.Width)
	}
	if m.respondInput.Width != respondWidth(120)-8 {
		t.Fatalf("respondInput width = %d", m.respondInput.Width)
	}
	if m.helpModel.Width != 110 {
		t.Fatalf("help width = %d", m.helpModel.Width)
	}
	// Renderers must not resize the widgets they draw.
	before := m.palInput.Width
	_ = m.View()
	if m.palInput.Width != before {
		t.Fatal("View mutated the model")
	}
}
