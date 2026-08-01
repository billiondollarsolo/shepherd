package app

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
	"github.com/billiondollarsolo/shep-tui/internal/keybinds"
)

// nodesBackend serves a node list and records the registration it is handed.
type nodesBackend struct {
	backend.Backend
	nodes   []domain.Node
	created backend.NodeSpec
	err     error
}

func (n *nodesBackend) ListNodes(ctx context.Context) ([]domain.Node, error) {
	return n.nodes, nil
}

func (n *nodesBackend) CreateNode(ctx context.Context, spec backend.NodeSpec) (domain.Node, error) {
	n.created = spec
	if n.err != nil {
		return domain.Node{}, n.err
	}
	return domain.Node{ID: "n9", Name: spec.Name, Kind: spec.Kind,
		ConnectionStatus: domain.NodeConnecting}, nil
}

func (n *nodesBackend) Capabilities() backend.Caps {
	return backend.Caps{Mode: "fleet", MultiNode: true}
}

var testNodes = []domain.Node{
	{ID: "n1", Name: "alpha", Kind: domain.NodeLocal, ConnectionStatus: domain.NodeConnected},
	{ID: "n2", Name: "beta", Kind: domain.NodeSSH, Host: "10.0.0.2", SSHUser: "mj",
		Pool: "gpu", ConnectionStatus: domain.NodeDisconnected},
}

func nodesModel(t *testing.T, caps backend.Caps) (Model, *nodesBackend) {
	t.Helper()
	be := &nodesBackend{nodes: testNodes}
	m := newModel(Options{
		Version:    "test",
		SkipSplash: true,
		Backend:    be,
		Caps:       caps,
		Sessions: []domain.Session{
			{ID: "s1", NodeID: "n1", Name: "one", Status: domain.StatusIdle},
			{ID: "s2", NodeID: "n2", Name: "two", Status: domain.StatusIdle},
			{ID: "s3", NodeID: "n2", Name: "three", Status: domain.StatusIdle},
		},
	})
	m.applySize(120, 40)
	return m, be
}

var fleetCaps = backend.Caps{Mode: "fleet", MultiNode: true}
var localCaps = backend.Caps{Mode: "local", MultiNode: false}

// loadNodes opens the nodes surface and runs the list command it returns.
func loadNodes(t *testing.T, m Model) Model {
	t.Helper()
	nm, cmd := m.openNodes()
	m = nm.(Model)
	if cmd == nil {
		t.Fatal("openNodes issued no list command")
	}
	next, _ := m.Update(cmd())
	return next.(Model)
}

func TestNodesSurfaceListsTheNodes(t *testing.T) {
	m, _ := nodesModel(t, fleetCaps)
	m = loadNodes(t, m)
	if m.bodyStage() != StageNodes {
		t.Fatalf("stage = %s", m.stage)
	}
	view := renderNodes(m, 120, 20)
	if !strings.Contains(view, "Nodes[2]") {
		t.Fatalf("border title missing the count:\n%s", view)
	}
	for _, want := range []string{"NAME", "KIND", "HOST", "STATUS", "POOL", "SEEN",
		"alpha", "beta", "mj@10.0.0.2", "gpu", "disconnected"} {
		if !strings.Contains(view, want) {
			t.Errorf("nodes view omits %q:\n%s", want, view)
		}
	}
}

// enter on a node is k9s' namespace switch: the agents table shows that node's
// sessions and says so in its border, and esc puts every node back.
func TestEnterOnANodeScopesTheAgentsTable(t *testing.T) {
	m, _ := nodesModel(t, fleetCaps)
	m = loadNodes(t, m)
	m.nodesTable.SetCursor(1) // beta (n2)

	nm, _ := m.scopeToSelectedNode()
	m = nm.(Model)
	if m.nodeScope != "n2" {
		t.Fatalf("scope = %q", m.nodeScope)
	}
	if m.bodyStage() != StageTable {
		t.Fatalf("scoping did not return to the agents table: %s", m.stage)
	}
	if got := m.table.Len(); got != 2 {
		t.Fatalf("scoped table has %d rows, want beta's 2", got)
	}
	for _, r := range m.table.Rows() {
		if r.SessionID == "s1" {
			t.Fatal("the scoped table still lists another node's agent")
		}
	}
	if got := m.tableTitle(); got != "Agents(beta)[2]" {
		t.Fatalf("table title = %q", got)
	}
	if got := m.headerNodeValue("local"); got != "beta" {
		t.Fatalf("header Node: = %q", got)
	}

	nm2, _, ok := m.runAction(keybinds.ActionEsc)
	if !ok {
		t.Fatal("esc is not dispatched on the table")
	}
	m = nm2
	if m.nodeScope != "" || m.table.Len() != 3 {
		t.Fatalf("esc did not clear the scope: scope=%q rows=%d", m.nodeScope, m.table.Len())
	}
	if got := m.headerNodeValue("local"); got != "all" {
		t.Fatalf("header Node: = %q after clearing the scope", got)
	}
}

// A scope whose node has no sessions shows an empty table, not the whole fleet.
func TestNodeScopeFiltersEvenWhenItEmptiesTheTable(t *testing.T) {
	m, _ := nodesModel(t, fleetCaps)
	m.nodeScope = "n-unknown"
	m.syncTable()
	if m.table.Len() != 0 {
		t.Fatalf("scope to an empty node listed %d agents", m.table.Len())
	}
}

// Local agentd is one node and always will be: the add-node key is not offered,
// and the command says why rather than opening a form that cannot post.
func TestLocalRefusesToAddANode(t *testing.T) {
	m, _ := nodesModel(t, localCaps)
	m = loadNodes(t, m)

	for _, k := range m.headerHotkeys() {
		if strings.Contains(k.Desc, "Add node") {
			t.Fatal("local advertises a key it cannot serve")
		}
	}
	nm, _ := m.openAddNode()
	m = nm.(Model)
	if m.stage == StageAddNode {
		t.Fatal("local opened the add-node form")
	}
	if !strings.Contains(m.toast.text, "single node") {
		t.Fatalf("toast = %q", m.toast.text)
	}
	if !strings.Contains(m.toast.text, "fleet") {
		t.Fatalf("the refusal does not say where nodes can be added: %q", m.toast.text)
	}
}

func TestFleetOffersAddNodeOnTheNodesSurface(t *testing.T) {
	m, _ := nodesModel(t, fleetCaps)
	m = loadNodes(t, m)
	found := false
	for _, k := range m.headerHotkeys() {
		if strings.Contains(k.Desc, "Add node") {
			found = true
		}
	}
	if !found {
		t.Fatalf("fleet hides add node: %+v", m.headerHotkeys())
	}
	nm, _ := m.openAddNode()
	if nm.(Model).stage != StageAddNode {
		t.Fatalf("stage = %s", nm.(Model).stage)
	}
}

// The private key is taken from a file at submit time, posted once, and kept
// nowhere: not on the model, and not on the screen.
func TestAddNodeReadsTheKeyFileAndKeepsIt(t *testing.T) {
	m, be := nodesModel(t, fleetCaps)
	keyPath := filepath.Join(t.TempDir(), "id_ed25519")
	const secret = "-----BEGIN OPENSSH PRIVATE KEY-----\nSUPERSECRETKEYMATERIAL\n"
	if err := os.WriteFile(keyPath, []byte(secret), 0o600); err != nil {
		t.Fatal(err)
	}

	vals := &nodeFormVals{name: "box", kind: string(domain.NodeSSH), host: "10.0.0.2",
		port: "2222", sshUser: "mj", auth: "key", keyPath: keyPath, ok: true}
	spec, path, err := vals.spec()
	if err != nil {
		t.Fatal(err)
	}
	if spec.SSHPrivateKey != "" {
		t.Fatal("the key was read into the model instead of the command")
	}
	cmd := m.createNodeCmd(spec, path)
	next, _ := m.Update(cmd())
	m = next.(Model)

	if got := be.created.SSHPrivateKey; got != strings.TrimSpace(secret) {
		t.Fatalf("posted key = %q", got)
	}
	if be.created.Port != 2222 || be.created.SSHUser != "mj" || be.created.SSHAuthMethod != "key" {
		t.Fatalf("posted spec = %+v", be.created)
	}
	if !strings.Contains(m.toast.text, "added node") {
		t.Fatalf("toast = %q", m.toast.text)
	}
	assertNoSecret(t, m, "SUPERSECRETKEYMATERIAL")
}

// An orchestrator that echoes what it was sent must not be the way a credential
// reaches the screen.
func TestACredentialNeverReachesAToastOrTheScreen(t *testing.T) {
	m, be := nodesModel(t, fleetCaps)
	const pw = "hunter2-correct-horse"
	be.err = fmt.Errorf("400 bad request: sshPassword %q was rejected", pw)

	vals := &nodeFormVals{name: "box", kind: string(domain.NodeSSH), host: "10.0.0.2",
		sshUser: "mj", auth: "password", password: pw, ok: true}
	spec, path, err := vals.spec()
	if err != nil {
		t.Fatal(err)
	}
	if spec.SSHPassword != pw {
		t.Fatalf("password did not reach the spec")
	}
	cmd := m.createNodeCmd(spec, path)
	next, _ := m.Update(cmd())
	m = next.(Model)

	if !strings.Contains(m.toast.text, "add node") {
		t.Fatalf("the failure was not reported: %q", m.toast.text)
	}
	assertNoSecret(t, m, pw)
}

// The form's fields die with the form: a cancelled or completed registration
// leaves no credential behind on the model.
func TestClosingTheAddNodeFormDropsTheCredential(t *testing.T) {
	m, _ := nodesModel(t, fleetCaps)
	nm, _ := m.openAddNode()
	m = nm.(Model)
	m.nodeVals.password = "hunter2"
	m.closeAddNode()
	if m.nodeVals != nil || m.nodeForm != nil {
		t.Fatal("the form outlived its close")
	}
	assertNoSecret(t, m, "hunter2")
}

func assertNoSecret(t *testing.T, m Model, secret string) {
	t.Helper()
	if strings.Contains(m.toast.text, secret) {
		t.Fatalf("the toast leaks the credential: %q", m.toast.text)
	}
	if strings.Contains(m.View(), secret) {
		t.Fatal("the screen leaks the credential")
	}
	if m.nodeVals != nil && strings.Contains(m.nodeVals.password, secret) {
		t.Fatal("the credential is still on the model")
	}
}

// The nodes table is reachable from the keyboard and from the palette, and N
// comes back off it.
func TestNodesKeyAndPaletteReachTheSurface(t *testing.T) {
	m, _ := nodesModel(t, fleetCaps)
	m = press(m, "N")
	if m.bodyStage() != StageNodes {
		t.Fatalf("N did not open the nodes surface: %s", m.stage)
	}
	m = press(m, "N")
	if m.bodyStage() != StageTable {
		t.Fatalf("N did not come back off the nodes surface: %s", m.stage)
	}

	found := false
	for _, c := range m.buildPaletteCatalog() {
		if c.ID == "action:nodes" {
			found = true
		}
	}
	if !found {
		t.Fatal("the palette does not list the nodes surface")
	}
}

// Add node is a palette command only where it can work.
func TestPaletteGatesAddNodeOnMultiNode(t *testing.T) {
	has := func(m Model, id string) bool {
		for _, c := range m.buildPaletteCatalog() {
			if c.ID == id {
				return true
			}
		}
		return false
	}
	fleet, _ := nodesModel(t, fleetCaps)
	if !has(fleet, "action:node:add") {
		t.Fatal("fleet palette omits add node")
	}
	local, _ := nodesModel(t, localCaps)
	if has(local, "action:node:add") {
		t.Fatal("local palette offers add node, which local cannot serve")
	}
}

// A node list that arrives after the user has moved on belongs to nobody.
func TestStaleNodeListIsDropped(t *testing.T) {
	m, _ := nodesModel(t, fleetCaps)
	m = loadNodes(t, m)
	next, _ := m.Update(nodesLoadedMsg{seq: m.nodesSeq - 1,
		nodes: []domain.Node{{ID: "zzz", Name: "ghost"}}})
	m = next.(Model)
	if m.nodesTable.Len() != 2 {
		t.Fatalf("a stale list reached the table: %d rows", m.nodesTable.Len())
	}
}
