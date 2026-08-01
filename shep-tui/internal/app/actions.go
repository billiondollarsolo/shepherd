// Session actions: the verbs of the selected agent — the list is the app, so
// everything here acts on the row the table has under its cursor.
package app

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/billiondollarsolo/shep-tui/internal/domain"
)

// aliasFileName holds the session names chosen on this client, beside pens.json.
const aliasFileName = "names.json"

// sessionAction is one verb of the selected session: the key that runs it and
// the words the menu lists it under.
type sessionAction struct {
	Key   string
	Label string
}

// actionSession is the session every action acts on: the table's selection,
// falling back to the focused pane's agent when the table has none.
func (m Model) actionSession() (domain.Session, bool) {
	id := ""
	if m.table != nil {
		id = m.table.SelectedSessionID()
	}
	if id == "" {
		id = m.focusSessionID
	}
	if id == "" {
		return domain.Session{}, false
	}
	return m.sessionOrPlaceholder(id), true
}

// sessionAttached reports that the session is live in a pane — the only state in
// which there is a stream to write an answer to.
func (m Model) sessionAttached(id string) bool {
	for i := 0; i < m.nPanes; i++ {
		if m.panes[i].SessionID == id && m.panes[i].Stream != nil {
			return true
		}
	}
	return false
}

// sessionActions is what can be done to the selected session *right now*. An
// action the backend cannot serve is not listed and not dispatched: offering one
// and then apologising for it is worse than never offering it.
func (m Model) sessionActions() []sessionAction {
	s, ok := m.actionSession()
	if !ok {
		return nil
	}
	out := []sessionAction{{Key: "enter", Label: "attach (full screen)"}}
	if m.sessionAttached(s.ID) {
		out = append(out, sessionAction{Key: "R", Label: "respond"})
	}
	out = append(out,
		sessionAction{Key: "r", Label: "rename"},
		sessionAction{Key: "e", Label: "export transcript"},
	)
	if m.caps.Git {
		out = append(out,
			sessionAction{Key: "g", Label: "git status / diff"},
			sessionAction{Key: "c", Label: "git commit (stage all)"},
		)
	}
	if m.caps.Files {
		out = append(out, sessionAction{Key: "f", Label: "files"})
	}
	if m.caps.Chat || m.caps.StructuredChat {
		out = append(out, sessionAction{Key: "m", Label: "chat timeline"})
	}
	if m.caps.Handoff {
		out = append(out, sessionAction{Key: "b", Label: "handoff bootstrap"})
	}
	return append(out, sessionAction{Key: "x", Label: "kill session"})
}

// runSessionAction is the one dispatcher for the selected session's verbs: the
// menu row and the bare key are the same call, so discovery and speed can never
// drift apart. ok=false means the action is not available for this session, and
// the key belongs to whatever would have had it otherwise.
func (m Model) runSessionAction(k string) (tea.Model, tea.Cmd, bool) {
	s, ok := m.actionSession()
	if !ok {
		return m, nil, false
	}
	listed := false
	for _, a := range m.sessionActions() {
		if a.Key == k {
			listed = true
			break
		}
	}
	if !listed {
		return m, nil, false
	}

	model := func(mm tea.Model, cmd tea.Cmd) (tea.Model, tea.Cmd, bool) {
		return mm, cmd, true
	}
	switch k {
	case "enter":
		return model(m.focusSessionIntoPen(s))
	case "R":
		m.focusSessionID = s.ID
		return model(m.openRespond())
	case "r":
		return model(m.openRename(s))
	case "e":
		return m, m.exportTranscriptCmd(s), true
	case "g":
		return model(m.openPanelAsync("git", gitPanelLoader(m.sessionCwd(s))))
	case "c":
		return m, m.cmdGitCommit(), true
	case "f":
		return model(m.openPanelAsync("files", filesPanelLoader(m.sessionCwd(s))))
	case "m":
		return model(m.openPanel("chat", m.buildChatPanelLines()))
	case "b":
		return model(m.openHandoff())
	case "x":
		return model(m.askKillConfirm(s))
	}
	return m, nil, false
}

// runSelectedSessionAction adapts a session verb to the chrome dispatcher. The
// key is the registry's, so chrome consumes it either way: an action that is not
// available for this session is a key that does nothing, not one that falls
// through to whatever else claims the letter.
func (m Model) runSelectedSessionAction(k string) (Model, tea.Cmd, bool) {
	mm, cmd, ok := m.runSessionAction(k)
	if !ok {
		return m, nil, true
	}
	return mm.(Model), cmd, true
}

// sessionCwd is the directory a session's panels act on.
func (m Model) sessionCwd(s domain.Session) string {
	if s.Cwd != "" {
		return s.Cwd
	}
	cwd, _ := os.Getwd()
	return cwd
}

func (m Model) openSessionActions() (tea.Model, tea.Cmd) {
	if m.stage == StageActions {
		return m, nil
	}
	s, ok := m.actionSession()
	if !ok {
		m.notifyErr("no session selected")
		return m, nil
	}
	m.actionsTarget = s.ID
	m.pushStage(StageActions)
	return m, nil
}

// handleActionsKey runs a listed action, or closes. Every other key is swallowed:
// the paddock is still mounted behind the overlay and may not be reconfigured by
// keys the user aimed at the menu.
func (m Model) handleActionsKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if key.Matches(msg, m.keys.Esc) {
		m.popStage()
		return m, nil
	}
	if mm, cmd, ok := m.handleGlobalKey(msg, true); ok {
		return mm, cmd
	}
	m.popStage()
	if mm, cmd, ok := m.runSessionAction(msg.String()); ok {
		return mm, cmd
	}
	m.pushStage(StageActions)
	return m, nil
}

func renderActions(m Model) string {
	th := m.th()
	s, ok := m.actionSession()
	if !ok {
		return ""
	}
	var b strings.Builder
	b.WriteString(th.Title.Render("Actions") + th.Muted.Render(" · "+m.sessionName(s)) + "\n\n")
	for _, a := range m.sessionActions() {
		b.WriteString("  " + th.Help.Render(fmt.Sprintf("%-7s", a.Key)) + " " + a.Label + "\n")
	}
	b.WriteString("  " + th.Help.Render(fmt.Sprintf("%-7s", "esc")) + " " + th.Muted.Render("close"))
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(th.Accent).
		Padding(1, 2).
		Background(th.Surface1).
		Render(b.String())
}

// --- rename: a local name for a session the backend will not rename ---

// openRename asks for the name this client will call the session. agentd has no
// rename op, so the name never leaves this machine.
func (m Model) openRename(s domain.Session) (tea.Model, tea.Cmd) {
	m.renameTarget = s.ID
	m.renameInput.SetValue(m.aliases[s.ID])
	m.renameInput.CursorEnd()
	m.pushStage(StageRename)
	return m, tea.Batch(m.renameInput.Focus(), textinput.Blink)
}

func (m *Model) closeRename() {
	m.renameTarget = ""
	m.renameInput.Blur()
	m.renameInput.SetValue("")
	m.popStage()
}

func (m Model) handleRenameKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, m.keys.Esc):
		m.closeRename()
		return m, nil
	case key.Matches(msg, m.keys.Activate):
		name := strings.TrimSpace(m.renameInput.Value())
		id := m.renameTarget
		m.closeRename()
		return m.applyRename(id, name)
	}
	if mm, cmd, ok := m.handleGlobalKey(msg, true); ok {
		return mm, cmd
	}
	var cmd tea.Cmd
	m.renameInput, cmd = m.renameInput.Update(msg)
	return m, cmd
}

// applyRename sets (or, on an empty name, clears) the session's display name and
// applies it everywhere the session is drawn.
func (m Model) applyRename(id, name string) (tea.Model, tea.Cmd) {
	if id == "" || m.st == nil {
		return m, nil
	}
	m.st.SetAlias(id, name)
	m.aliases = m.st.Aliases()
	for i := range m.panes {
		if m.panes[i].SessionID == id {
			m.panes[i].Title = m.paneTitle(m.sessionOrPlaceholder(id))
		}
	}
	m.syncTable()
	if name == "" {
		m.notifyOK("name cleared")
	} else {
		m.notifyOK("renamed to " + name)
	}
	return m, m.saveAliasesCmd()
}

// aliasesSavedMsg reports the write of the local names file.
type aliasesSavedMsg struct{ err error }

func (m Model) saveAliasesCmd() tea.Cmd {
	if m.aliasPath == "" || m.st == nil {
		return nil
	}
	st, path := m.st, m.aliasPath
	return func() tea.Msg {
		return aliasesSavedMsg{err: st.SaveAliases(path)}
	}
}

func renderRename(m Model) string {
	th := m.th()
	w := respondWidth(m.width)
	head := "Rename"
	if m.renameTarget != "" {
		head += " → " + domain.ShortID(m.renameTarget)
	}
	body := th.Title.Render(head) + "\n" +
		m.renameInput.View() + "\n" +
		th.Muted.Render("enter save · empty clears · esc cancel")
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(th.Accent).
		Padding(0, 1).
		Width(max(w-2, 10)).
		Background(th.Surface1).
		Render(body)
}

// --- kill: irreversible, so it is asked for twice ---

func (m Model) askKillConfirm(s domain.Session) (tea.Model, tea.Cmd) {
	m.killTarget = s.ID
	m.confirmPrompt = "kill " + m.sessionName(s) + "?"
	m.pushStage(StageConfirm)
	return m, nil
}

func (m *Model) closeConfirm() {
	m.killTarget = ""
	m.confirmPrompt = ""
	m.popStage()
}

func (m Model) handleConfirmKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if key.Matches(msg, m.keys.Quit) && isModifierKey(msg.String()) {
		return m.quit()
	}
	switch msg.String() {
	case "y", "Y":
		id := m.killTarget
		name := m.sessionName(m.sessionOrPlaceholder(id))
		m.closeConfirm()
		if id == "" {
			return m, nil
		}
		return m, m.killSessionCmd(id, name)
	}
	// Anything that is not yes is no: a destructive key may not be reached by a
	// keystroke the user did not mean for this box.
	m.closeConfirm()
	return m, nil
}

func renderConfirm(m Model) string {
	th := m.th()
	body := th.Title.Render(m.confirmPrompt) + "\n\n" +
		th.Muted.Render("y kill · n / esc cancel")
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(th.Error).
		Padding(1, 2).
		Background(th.Surface1).
		Render(body)
}

// killDoneMsg is the result of a CloseSession. name is what the user called the
// session, so the toast says what they killed rather than a uuid they never read.
type killDoneMsg struct {
	id   string
	name string
	err  error
}

func (m Model) killSessionCmd(id, name string) tea.Cmd {
	if m.be == nil {
		return func() tea.Msg {
			return killDoneMsg{id: id, name: name, err: fmt.Errorf("no backend")}
		}
	}
	be := m.be
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return killDoneMsg{id: id, name: name, err: be.CloseSession(ctx, id)}
	}
}

// sessionKilled drops a session the backend has torn down: the panes holding it
// are detached, the pen forgets it, and the list is rebuilt around what is left.
func (m Model) sessionKilled(msg killDoneMsg) (tea.Model, tea.Cmd) {
	before := m.motionState()
	kept := m.sessions[:0:0]
	for _, s := range m.sessions {
		if s.ID != msg.id {
			kept = append(kept, s)
		}
	}
	m.sessions = kept
	if m.st != nil {
		m.st.SeedSessions(m.sessions)
	}

	var cmds []tea.Cmd
	for i := range m.panes {
		if m.panes[i].SessionID != msg.id {
			continue
		}
		if m.panes[i].Stream != nil {
			cmds = append(cmds, closeStreamCmd(m.panes[i].Stream))
			m.panes[i].Stream = nil
		}
		m.nextEpoch(i)
		m.panes[i].SessionID = ""
		m.panes[i].Title = fmt.Sprintf("pane %d", i+1)
		m.panes[i].Status = domain.StatusDisconnected
		m.panes[i].AttachErr = ""
		m.panes[i].EmptyMsg = m.emptyPaneMsg()
		m.panes[i].scrollOff = 0
		m.panes[i].Telemetry = domain.Telemetry{}
		if m.mode == ModeInput && m.focus == i && m.inputTarget == targetPane {
			m.mode = ModeChrome
			m.clearChord()
		}
	}
	ids := m.pen.SessionIDs[:0:0]
	for _, id := range m.pen.SessionIDs {
		if id != msg.id {
			ids = append(ids, id)
		}
	}
	m.pen.SessionIDs = ids
	if m.focusSessionID == msg.id {
		m.focusSessionID = ""
	}
	m.syncTable()
	m.syncFocusFromTable()
	m.notifyOK("killed " + msg.name)
	return m.armMotion(before, tea.Batch(cmds...))
}

// --- export: the transcript as the user last saw it ---

// exportDoneMsg is the result of writing a transcript to disk.
type exportDoneMsg struct {
	path string
	err  error
}

// exportTranscriptCmd writes what the session has said. The lines are taken here,
// off the pane's screen, and the file is written in the command: the Model is
// copied on every Update and may not be captured by one.
func (m Model) exportTranscriptCmd(s domain.Session) tea.Cmd {
	lines := m.transcriptLines(s)
	name := fmt.Sprintf("flock-%s-%s.txt", domain.ShortID(s.ID), time.Now().Format("20060102-150405"))
	path := filepath.Join(m.sessionCwd(s), name)
	body := strings.Join(lines, "\n") + "\n"
	return func() tea.Msg {
		return exportDoneMsg{path: path, err: os.WriteFile(path, []byte(body), 0o600)}
	}
}

// transcriptLines is the session's scrollback and live screen when it is attached,
// and what the app knows about it when it is not.
func (m Model) transcriptLines(s domain.Session) []string {
	head := []string{
		"session: " + s.ID,
		"name: " + m.sessionName(s),
		"status: " + s.Status.Label(),
	}
	for i := 0; i < m.nPanes; i++ {
		if m.panes[i].SessionID != s.ID || m.panes[i].screen == nil {
			continue
		}
		screen := m.panes[i].screen
		out := append(head, "")
		for j := 0; j < screen.ScrollbackLen(); j++ {
			out = append(out, strings.TrimRight(screen.ScrollbackLine(j), " "))
		}
		return append(out, strings.Split(screen.TrimmedString(), "\n")...)
	}
	return append(head, "", "(not attached — no transcript)")
}
