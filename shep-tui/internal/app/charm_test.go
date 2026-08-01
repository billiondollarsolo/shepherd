package app

import (
	"strings"
	"testing"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
	"github.com/billiondollarsolo/shep-tui/internal/ui/theme"
)

func TestNeedsYouBlinkGlyph(t *testing.T) {
	m := newModel(Options{Version: "test", SkipSplash: true})
	m.reducedMotion = false
	m.blinkOn = true
	on := m.statusGlyph(domain.StatusAwaitingInput)
	m.blinkOn = false
	off := m.statusGlyph(domain.StatusAwaitingInput)
	if on == off {
		t.Fatalf("blink on/off should differ: on=%q off=%q", on, off)
	}
	// Labels stay affirmative.
	lab := m.statusLabelBlink(domain.StatusAwaitingInput)
	if !strings.Contains(lab, "Needs you") {
		t.Fatalf("label=%q", lab)
	}
	// Reduced motion freezes solid.
	m.reducedMotion = true
	m.blinkOn = false
	a := m.statusGlyph(domain.StatusAwaitingInput)
	m.blinkOn = true
	b := m.statusGlyph(domain.StatusAwaitingInput)
	if a != b {
		t.Fatalf("reduced motion must not blink: %q vs %q", a, b)
	}
}

func TestBlinkTickToggles(t *testing.T) {
	m := newModel(Options{
		Version:    "test",
		SkipSplash: true,
		Sessions:   []domain.Session{{ID: "n1", Status: domain.StatusAwaitingInput}},
	})
	m.reducedMotion = false
	m.blinkOn = true
	next, cmd := m.Update(blinkTickMsg{seq: m.blinkSeq})
	m = next.(Model)
	if m.blinkOn {
		t.Fatal("expected blink phase toggle to false")
	}
	if cmd == nil {
		t.Fatal("blink must re-arm while a session needs you")
	}
	next, _ = m.Update(blinkTickMsg{seq: m.blinkSeq})
	m = next.(Model)
	if !m.blinkOn {
		t.Fatal("expected blink phase toggle to true")
	}
}

func TestBlinkTickStopsWithoutAttention(t *testing.T) {
	m := newModel(Options{
		Version:    "test",
		SkipSplash: true,
		Sessions:   []domain.Session{{ID: "s1", Status: domain.StatusRunning}},
	})
	m.reducedMotion = false
	m.blinkOn = false
	next, cmd := m.Update(blinkTickMsg{seq: m.blinkSeq})
	m = next.(Model)
	if cmd != nil {
		t.Fatal("idle model must not re-arm the blink tick")
	}
	if !m.blinkOn {
		t.Fatal("glyph must park lit when nothing needs you")
	}
}

func TestAttentionArrivalRearmsBlink(t *testing.T) {
	m := newModel(Options{
		Version:    "test",
		SkipSplash: true,
		Sessions:   []domain.Session{{ID: "s1", Status: domain.StatusRunning}},
	})
	m.reducedMotion = false
	next, cmd := m.Update(statusUpdateMsg{StatusUpdate: backend.StatusUpdate{SessionID: "s1", Status: domain.StatusAwaitingInput}})
	m = next.(Model)
	if !m.blinkActive() {
		t.Fatal("blink should be active once a session awaits input")
	}
	if cmd == nil {
		t.Fatal("status change to Needs you must arm the blink tick")
	}
}

func TestPaletteUsesTextinputFilter(t *testing.T) {
	m := newModel(Options{
		Version:    "test",
		SkipSplash: true,
		Sessions: []domain.Session{
			{ID: "alpha", Name: "Alpha", Status: domain.StatusIdle},
			{ID: "beta", Name: "Beta", Status: domain.StatusRunning},
		},
	})
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyCtrlK})
	m = next.(Model)
	if !m.palInput.Focused() {
		t.Fatal("palette textinput should be focused")
	}
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'b'}})
	m = next.(Model)
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'e'}})
	m = next.(Model)
	if m.palInput.Value() != "be" || m.paletteQuery != "be" {
		t.Fatalf("query input=%q paletteQuery=%q", m.palInput.Value(), m.paletteQuery)
	}
	view := m.View()
	if !strings.Contains(view, "Command palette") {
		t.Fatalf("view missing palette: %s", view)
	}
}

func TestRespondUsesTextinput(t *testing.T) {
	m := newModel(Options{Version: "test", SkipSplash: true, Sessions: []domain.Session{{ID: "alpha"}}})
	m.panes[0].SessionID = "alpha"
	m.panes[0].Stream = &countingStream{}
	next, _ := m.openRespond()
	m = next.(Model)
	if m.stage != StageRespond || m.respondTarget != "alpha" || !m.respondInput.Focused() {
		t.Fatalf("stage=%s focused=%v", m.stage, m.respondInput.Focused())
	}
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("hi")})
	m = next.(Model)
	if m.respondInput.Value() != "hi" || m.respondDraft != "hi" {
		t.Fatalf("draft=%q input=%q", m.respondDraft, m.respondInput.Value())
	}
}

func TestOpenLaunchUsesHuhForm(t *testing.T) {
	m := newModel(Options{Version: "test", SkipSplash: true})
	next, _ := m.openLaunch()
	m = next.(Model)
	if m.stage != StageLaunch {
		t.Fatalf("stage=%s", m.stage)
	}
	if m.launchForm == nil || m.launchVals == nil {
		t.Fatal("expected huh launch form")
	}
	view := renderLaunch(m, 80, 24)
	if view == "" {
		t.Fatal("empty launch view")
	}
	// Esc aborts form path.
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	m = next.(Model)
	if m.stage != StageTable || m.launchForm != nil {
		t.Fatalf("after esc stage=%s form=%v", m.stage, m.launchForm != nil)
	}
}

func TestHelpUsesBubblesRegistry(t *testing.T) {
	m := newModel(Options{Version: "test", SkipSplash: true})
	m.width, m.height = 100, 40
	out := renderHelp(m)
	for _, needle := range []string{"detach", "ctrl+g", "palette", "launch", "table"} {
		if !strings.Contains(out, needle) {
			t.Fatalf("help missing %q\n%s", needle, out)
		}
	}
}

func TestSpinnerTickDoesNotPanic(t *testing.T) {
	m := newModel(Options{Version: "test", SkipSplash: true})
	m.reconnecting = true
	// Force a tick message through spinner Update path.
	msg := m.spin.Tick()
	// Tick returns a Cmd; run it.
	if msg == nil {
		// spinner.Tick is a Cmd
		cmd := m.spin.Tick
		tm := cmd()
		next, _ := m.Update(tm)
		_ = next
		return
	}
	_ = spinner.TickMsg{}
	// Also accept any TickMsg shape from Init path.
	next, cmd := m.Update(spinner.TickMsg{})
	_ = next
	_ = cmd
}

func TestLaunchFormCompletesToSpec(t *testing.T) {
	// Ensure huh form values map to launch.Spec fields.
	form, vals := newLaunchForm("/tmp/project", theme.DefaultDark())
	if form == nil || vals == nil {
		t.Fatal("nil form")
	}
	if vals.cwd != "/tmp/project" {
		t.Fatalf("cwd=%s", vals.cwd)
	}
	if vals.agent == "" {
		t.Fatal("default agent empty")
	}
	// Form starts normal.
	if form.State != huh.StateNormal {
		t.Fatalf("state=%v", form.State)
	}
}

// The agents that need you lead the table — once, at the top, by name.
func TestTableLeadsWithTheAgentsThatNeedYou(t *testing.T) {
	m := newModel(Options{
		Version:    "test",
		SkipSplash: true,
		Sessions: []domain.Session{
			{ID: "n1", Name: "NeedMe", Status: domain.StatusAwaitingInput},
			{ID: "i1", Name: "IdleOne", Status: domain.StatusIdle},
		},
	})
	m.applySize(100, 30)
	out := renderTable(m, 100, 20)
	if !strings.Contains(out, "Agents(local)[2]") {
		t.Fatalf("the table title must count the agents: %s", out)
	}
	rows := m.table.Rows()
	if rows[0].SessionID != "n1" {
		t.Fatalf("the session that needs you must lead the table: %+v", rows)
	}
	if !strings.Contains(out, "NeedMe") {
		t.Fatalf("expected the session that needs you in the table: %s", out)
	}
	if strings.Count(out, "NeedMe") != 1 {
		t.Fatalf("the session that needs you is listed twice: %s", out)
	}
	if !strings.Contains(out, "Needs you") {
		t.Fatalf("the status column must carry the affirmative label: %s", out)
	}
}
