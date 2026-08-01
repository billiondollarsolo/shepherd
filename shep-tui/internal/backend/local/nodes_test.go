package local

import (
	"context"
	"errors"
	"net"
	"testing"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
	"github.com/billiondollarsolo/flock/agentd/proto"
)

// agentd is one machine: the node list is itself, and never a second row
// invented to make a table look like a fleet.
func TestListNodesIsTheOneNodeWeHandshookWith(t *testing.T) {
	c := &Client{nodeID: "node-alpha"}
	nodes, err := c.ListNodes(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(nodes) != 1 {
		t.Fatalf("nodes = %+v", nodes)
	}
	n := nodes[0]
	if n.ID != "node-alpha" || n.Name != "node-alpha" {
		t.Fatalf("node identity = %+v", n)
	}
	if n.Kind != domain.NodeLocal || n.ConnectionStatus != domain.NodeConnected {
		t.Fatalf("node = %+v", n)
	}
}

func TestCreateNodeIsNotSupportedLocally(t *testing.T) {
	c := &Client{nodeID: "node-alpha"}
	if _, err := c.CreateNode(context.Background(), backend.NodeSpec{
		Name: "box", Kind: domain.NodeSSH, Host: "h", SSHUser: "mj", SSHPrivateKey: "k",
	}); !errors.Is(err, backend.ErrNotSupported) {
		t.Fatalf("CreateNode err = %v, want ErrNotSupported", err)
	}
}

// Every local session lives on the node this client handshook with. Without the
// id on the session, scoping the table to the node shows an empty table.
func TestListSessionsCarryTheNodeID(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	c := &Client{
		conn:         clientConn,
		dataHandlers: make(map[string]func([]byte)),
		statusCh:     make(chan backend.StatusUpdate, 1),
		nodeID:       "node-alpha",
	}
	go c.readLoop()
	t.Cleanup(func() { _ = c.Close() })

	go func() {
		defer serverConn.Close()
		_, payload, err := proto.ReadFrame(serverConn)
		if err != nil {
			return
		}
		ctrl, err := proto.DecodeControl(payload)
		if err != nil || ctrl.Op != "list" {
			return
		}
		_ = proto.WriteControl(serverConn, proto.Control{
			Op: "sessions",
			Sessions: []proto.SessionInfo{
				{ID: "s1", Kind: "claude-code", Cwd: "/src"},
			},
		})
		<-make(chan struct{})
	}()

	sessions, err := c.ListSessions(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 || sessions[0].NodeID != "node-alpha" {
		t.Fatalf("sessions = %+v", sessions)
	}
}
