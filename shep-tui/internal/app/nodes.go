// Nodes: the hosts the agents run on. The table is the same box the agents are
// drawn in, enter scopes the agents to the node under the cursor, and — on fleet
// — a form registers a new one.
package app

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/key"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/lipgloss"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
	"github.com/billiondollarsolo/shep-tui/internal/keybinds"
	uitable "github.com/billiondollarsolo/shep-tui/internal/ui/table"
	"github.com/billiondollarsolo/shep-tui/internal/ui/theme"
)

// noMultiNodeMsg is what a single-node backend says when asked for a second one.
const noMultiNodeMsg = "local agentd is a single node; add nodes from Flock / fleet mode"

// nodesLoadedMsg is the answer to a ListNodes. seq is the load it belongs to, so
// a list the user has already left behind is dropped instead of drawn.
type nodesLoadedMsg struct {
	seq   int
	nodes []domain.Node
	err   error
}

// nodeCreatedMsg is the result of a CreateNode. It carries no credential: the
// secret went into the request body and nowhere else.
type nodeCreatedMsg struct {
	name string
	node domain.Node
	err  error
}

// onNodes reports that the keyboard is on the nodes table.
func (m Model) onNodes() bool {
	return m.bodyStage() == StageNodes && m.region == RegionMain
}

// openNodes shows the nodes table — and, pressed again, comes back off it.
func (m Model) openNodes() (tea.Model, tea.Cmd) {
	if m.bodyStage() == StageNodes {
		m.resetStage()
		return m, nil
	}
	m.resetStage()
	m.stage = StageNodes
	m.region = RegionMain
	m.syncNodesTable()
	return m, m.listNodesCmd()
}

// listNodesCmd asks the backend for its nodes. The call is a command: Update may
// never block on I/O.
func (m *Model) listNodesCmd() tea.Cmd {
	if m.be == nil {
		return nil
	}
	m.nodesSeq++
	seq := m.nodesSeq
	be := m.be
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		nodes, err := be.ListNodes(ctx)
		return nodesLoadedMsg{seq: seq, nodes: nodes, err: err}
	}
}

// nodesLoaded applies a node list to the surface.
func (m Model) nodesLoaded(msg nodesLoadedMsg) (tea.Model, tea.Cmd) {
	if msg.seq != m.nodesSeq {
		return m, nil
	}
	if msg.err != nil {
		m.notifyErrf("nodes: %v", msg.err)
		return m, nil
	}
	m.nodes = msg.nodes
	m.syncNodesTable()
	return m, nil
}

func (m *Model) syncNodesTable() {
	if m.nodesTable == nil {
		m.nodesTable = uitable.BuildNodes(m.nodes)
		return
	}
	m.nodesTable.Rebuild(m.nodes)
}

func (m *Model) moveNodesCursor(delta int) {
	if m.nodesTable == nil || m.nodesTable.Len() == 0 {
		return
	}
	m.nodesTable.Move(delta)
}

// scopeToSelectedNode narrows the agents table to the node under the cursor —
// k9s' namespace, over the machines the agents live on — and goes back to it.
func (m Model) scopeToSelectedNode() (tea.Model, tea.Cmd) {
	if m.nodesTable == nil {
		return m, nil
	}
	id := m.nodesTable.SelectedNodeID()
	if id == "" {
		return m, nil
	}
	m.nodeScope = id
	m.resetStage()
	m.region = RegionMain
	m.syncTable()
	m.syncFocusFromTable()
	m.notifyOK("agents scoped to " + m.nodeScopeName() + " · esc for all nodes")
	return m, nil
}

// clearNodeScope puts every node's agents back in the table.
func (m *Model) clearNodeScope() {
	if m.nodeScope == "" {
		return
	}
	m.nodeScope = ""
	m.syncTable()
	m.syncFocusFromTable()
	m.notify("agents: all nodes")
}

// nodeScopeName is the scoped node as the user named it, not as the API keys it.
func (m Model) nodeScopeName() string {
	if m.nodeScope == "" {
		return ""
	}
	for _, n := range m.nodes {
		if n.ID == m.nodeScope {
			return n.Label()
		}
	}
	return domain.ShortID(m.nodeScope)
}

// headerNodeValue is the header's Node: line — the node the table is scoped to,
// or every node the backend has.
func (m Model) headerNodeValue(fallback string) string {
	if m.nodeScope != "" {
		return m.nodeScopeName()
	}
	if m.caps.MultiNode {
		return "all"
	}
	return fallback
}

// nodeHotkeys is what the nodes table dispatches. Add node is fleet's alone: a
// header may not advertise a key that can only apologise.
func (m Model) nodeHotkeys() []hotkey {
	out := []hotkey{{Key: "esc", Desc: "Back"}}
	if seq := m.binds().Sequence(keybinds.ActionActivate); len(seq) > 0 {
		out = append(out, hotkey{Key: keybinds.FormatChord(seq), Desc: "Scope agents"})
	}
	if m.caps.MultiNode {
		if seq := m.binds().Sequence(keybinds.ActionLaunch); len(seq) > 0 {
			out = append(out, hotkey{Key: keybinds.FormatChord(seq), Desc: "Add node"})
		}
	}
	for _, e := range []struct {
		action keybinds.Action
		desc   string
	}{
		{keybinds.ActionNodes, "Agents"},
		{keybinds.ActionPalette, "Command"},
		{keybinds.ActionHelp, "Help"},
		{keybinds.ActionQuit, "Quit"},
	} {
		if seq := m.binds().Sequence(e.action); len(seq) > 0 {
			out = append(out, hotkey{Key: keybinds.FormatChord(seq), Desc: e.desc})
		}
	}
	return out
}

// nodesTitle is the nodes table's title, drawn in its top border: Nodes[2].
func (m Model) nodesTitle() string {
	n := 0
	if m.nodesTable != nil {
		n = m.nodesTable.Len()
	}
	return fmt.Sprintf("Nodes[%d]", n)
}

func renderNodes(m Model, w, h int) string {
	innerW := max(w-4, 1)
	var body []string
	if m.nodesTable != nil && m.nodesTable.Len() > 0 {
		body = m.nodeLines(innerW, m.tableRows(h))
	}
	empty := "no nodes yet"
	if m.caps.MultiNode {
		empty = "no nodes — press " +
			keybinds.FormatChord(m.binds().Sequence(keybinds.ActionLaunch)) + " to add one"
	}
	return renderGrid(m, w, h, m.nodesTitle(), uitable.NodeHeader(innerW), body, empty)
}

// nodeLines draws the visible window of node rows. The status cell carries the
// meaning, so it carries the color: connected reads as an idle agent does.
func (m Model) nodeLines(innerW, rows int) []string {
	th := m.th()
	cols := uitable.NodeLayout(innerW)
	all := m.nodesTable.Rows()

	styled := make([][]string, 0, len(all))
	plain := make([]string, 0, len(all))
	for _, r := range all {
		cells := make([]string, 0, len(cols))
		flat := make([]string, 0, len(cols))
		for _, c := range cols {
			cell := uitable.Pad(r.Cell(c.Col), c.Width, c.Right)
			flat = append(flat, cell)
			switch {
			case c.Col == uitable.ColNodeStatus:
				cell = th.StatusStyle(nodeStatus(r.Status)).Render(cell)
			case c.Col == uitable.ColNodeName:
				if r.NodeID == m.nodeScope {
					cell = th.Title.Bold(true).Render(cell)
				}
			default:
				cell = th.Muted.Render(cell)
			}
			cells = append(cells, cell)
		}
		styled = append(styled, cells)
		plain = append(plain, strings.Join(flat, "  "))
	}
	cursor := m.nodesTable.Cursor()
	return gridLines(th, styled, plain, cursor, innerW, rows)
}

// nodeStatus maps a node's link state onto the status palette the app already
// paints agents with: one vocabulary of color for one meaning.
func nodeStatus(c domain.ConnectionStatus) domain.Status {
	switch c {
	case domain.NodeConnected:
		return domain.StatusIdle
	case domain.NodeConnecting:
		return domain.StatusStarting
	case domain.NodeErrored:
		return domain.StatusError
	default:
		return domain.StatusDisconnected
	}
}

// --- add node (fleet) ---

// nodeFormVals holds the huh-bound fields of the add-node form.
//
// keyPath is a path, not a key: a private key is never typed into, echoed by, or
// held in this TUI — it is read from disk inside the command that posts it, and
// the bytes go straight into the request body. password is masked on the way in
// and dropped the moment the form closes.
type nodeFormVals struct {
	name     string
	kind     string
	host     string
	port     string
	sshUser  string
	auth     string
	keyPath  string
	password string
	ok       bool
}

func newNodeForm(th theme.Theme) (*huh.Form, *nodeFormVals) {
	v := &nodeFormVals{kind: string(domain.NodeSSH), auth: "key", ok: true}
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title("Name").
				Description("What the fleet calls this machine").
				Value(&v.name).
				Validate(required("name")),
			huh.NewSelect[string]().
				Title("Kind").
				Options(
					huh.NewOption("ssh — a remote machine", string(domain.NodeSSH)),
					huh.NewOption("local — the orchestrator's own host", string(domain.NodeLocal)),
				).
				Value(&v.kind),
			huh.NewInput().
				Title("Host").
				Description("ssh only: hostname or IP").
				Value(&v.host),
			huh.NewInput().
				Title("Port").
				Description("ssh only: blank = 22").
				Value(&v.port).
				Validate(func(s string) error {
					s = strings.TrimSpace(s)
					if s == "" {
						return nil
					}
					n, err := strconv.Atoi(s)
					if err != nil || n <= 0 || n > 65535 {
						return fmt.Errorf("port must be 1–65535")
					}
					return nil
				}),
			huh.NewInput().
				Title("SSH user").
				Description("ssh only").
				Value(&v.sshUser),
			huh.NewSelect[string]().
				Title("Auth").
				Options(
					huh.NewOption("key — a private key file", "key"),
					huh.NewOption("password", "password"),
				).
				Value(&v.auth),
			huh.NewInput().
				Title("Private key file").
				Description("key auth: the PATH to the key — shep-tui reads it once and never stores it").
				Value(&v.keyPath),
			huh.NewInput().
				Title("Password").
				Description("password auth: sent once over the authed connection, never stored").
				EchoMode(huh.EchoModePassword).
				Value(&v.password),
			huh.NewConfirm().
				Title("Register node?").
				Affirmative("Add").
				Negative("Cancel").
				Value(&v.ok),
		),
	).
		WithTheme(theme.HuhTheme(th)).
		WithWidth(60).
		WithShowHelp(true).
		WithShowErrors(true)
	return form, v
}

func required(field string) func(string) error {
	return func(s string) error {
		if strings.TrimSpace(s) == "" {
			return fmt.Errorf("%s required", field)
		}
		return nil
	}
}

// openAddNode raises the registration form — or, on a backend that has exactly
// one node and always will, says so instead of pretending.
func (m Model) openAddNode() (tea.Model, tea.Cmd) {
	if !m.caps.MultiNode {
		m.notifyErr(noMultiNodeMsg)
		return m, nil
	}
	form, vals := newNodeForm(m.theme)
	m.nodeForm = form
	m.nodeVals = vals
	m.pushStage(StageAddNode)
	m.region = RegionMain
	return m, m.nodeForm.Init()
}

// closeAddNode tears the form down. The credential the user typed dies with it:
// nothing on the Model outlives this call.
func (m *Model) closeAddNode() {
	m.nodeForm = nil
	m.nodeVals = nil
	m.popStage()
}

// advanceNodeForm feeds msg to the huh form and applies its terminal states. huh
// only completes while handling its own commands' messages, so this must run for
// every message, not only key presses.
func (m Model) advanceNodeForm(msg tea.Msg) (Model, tea.Cmd, bool) {
	if m.nodeForm == nil {
		return m, nil, false
	}
	form, cmd := m.nodeForm.Update(msg)
	if f, ok := form.(*huh.Form); ok {
		m.nodeForm = f
	}
	switch m.nodeForm.State {
	case huh.StateCompleted:
		vals := m.nodeVals
		m.closeAddNode()
		if vals == nil || !vals.ok {
			m.notify("add node cancelled")
			return m, nil, true
		}
		spec, keyPath, err := vals.spec()
		if err != nil {
			m.notifyErr("add node: " + err.Error())
			return m, nil, true
		}
		return m, m.createNodeCmd(spec, keyPath), true
	case huh.StateAborted:
		m.closeAddNode()
		m.notify("add node cancelled")
		return m, nil, true
	}
	return m, cmd, true
}

// spec is the form as a NodeSpec, plus the key file still to be read. The key is
// deliberately left on disk until the command runs: Update does no I/O, and the
// bytes never live on the model.
func (v *nodeFormVals) spec() (backend.NodeSpec, string, error) {
	spec := backend.NodeSpec{
		Name:    strings.TrimSpace(v.name),
		Kind:    domain.NodeKind(v.kind),
		Host:    strings.TrimSpace(v.host),
		SSHUser: strings.TrimSpace(v.sshUser),
	}
	if spec.Name == "" {
		return backend.NodeSpec{}, "", fmt.Errorf("name required")
	}
	if p := strings.TrimSpace(v.port); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil || n <= 0 || n > 65535 {
			return backend.NodeSpec{}, "", fmt.Errorf("port must be 1–65535")
		}
		spec.Port = n
	}
	keyPath := ""
	if spec.Kind == domain.NodeSSH {
		if spec.Host == "" || spec.SSHUser == "" {
			return backend.NodeSpec{}, "", fmt.Errorf("ssh nodes need a host and an ssh user")
		}
		spec.SSHAuthMethod = v.auth
		if v.auth == "password" {
			if v.password == "" {
				return backend.NodeSpec{}, "", fmt.Errorf("password required for password auth")
			}
			spec.SSHPassword = v.password
		} else {
			spec.SSHAuthMethod = "key"
			keyPath = strings.TrimSpace(v.keyPath)
			if keyPath == "" {
				return backend.NodeSpec{}, "", fmt.Errorf("private key file required for key auth")
			}
		}
	}
	return spec, keyPath, nil
}

// createNodeCmd reads the key file (if any) and posts the node. Everything about
// the credential happens inside this command: it is read here, sent here, and
// scrubbed out of anything that comes back — a secret in an error message is a
// secret on the screen.
func (m Model) createNodeCmd(spec backend.NodeSpec, keyPath string) tea.Cmd {
	be := m.be
	name := spec.Name
	return func() tea.Msg {
		if be == nil {
			return nodeCreatedMsg{name: name, err: fmt.Errorf("no backend")}
		}
		if keyPath != "" {
			raw, err := os.ReadFile(keyPath)
			if err != nil {
				return nodeCreatedMsg{name: name, err: fmt.Errorf("read key file: %w", err)}
			}
			spec.SSHPrivateKey = strings.TrimSpace(string(raw))
			if spec.SSHPrivateKey == "" {
				return nodeCreatedMsg{name: name, err: fmt.Errorf("key file %s is empty", keyPath)}
			}
		}
		secrets := spec.Secrets()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		node, err := be.CreateNode(ctx, spec)
		if err != nil {
			return nodeCreatedMsg{name: name, err: fmt.Errorf("%s", scrubSecrets(err.Error(), secrets))}
		}
		return nodeCreatedMsg{name: name, node: node}
	}
}

// scrubSecrets takes the credential back out of a message. An orchestrator that
// echoes what it was sent, or a transport error that quotes the body, must not be
// the way a private key reaches the screen.
func scrubSecrets(msg string, secrets []string) string {
	for _, s := range secrets {
		if s == "" {
			continue
		}
		msg = strings.ReplaceAll(msg, s, "«redacted»")
		for _, line := range strings.Split(s, "\n") {
			if len(strings.TrimSpace(line)) >= 8 {
				msg = strings.ReplaceAll(msg, line, "«redacted»")
			}
		}
	}
	return msg
}

// nodeCreated folds a registered node into the list.
func (m Model) nodeCreated(msg nodeCreatedMsg) (tea.Model, tea.Cmd) {
	if msg.err != nil {
		m.notifyErrf("add node %s: %v", msg.name, msg.err)
		return m, nil
	}
	if msg.node.ID != "" {
		replaced := false
		for i := range m.nodes {
			if m.nodes[i].ID == msg.node.ID {
				m.nodes[i] = msg.node
				replaced = true
				break
			}
		}
		if !replaced {
			m.nodes = append(m.nodes, msg.node)
		}
		m.syncNodesTable()
	}
	m.notifyOK("added node " + msg.node.Label())
	return m, m.listNodesCmd()
}

func (m Model) handleAddNodeKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.nodeForm == nil {
		m.popStage()
		return m, nil
	}
	if key.Matches(msg, m.keys.Esc) {
		m.closeAddNode()
		return m, nil
	}
	// A huh field owns every printable rune, so only the chords are global.
	if mm, cmd, ok := m.handleGlobalKey(msg, true); ok {
		return mm, cmd
	}
	nm, cmd, _ := m.advanceNodeForm(msg)
	return nm, cmd
}

func renderAddNode(m Model, w, h int) string {
	th := m.th()
	if m.nodeForm == nil {
		return ""
	}
	body := th.Title.Render("Add node") + "\n" +
		th.Muted.Render("the credential is sent once and never stored by shep-tui") + "\n\n" +
		m.nodeForm.View()
	return lipgloss.NewStyle().Width(max(w-2, 10)).Height(max(h-2, 1)).Render(body)
}
