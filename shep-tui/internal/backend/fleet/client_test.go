package fleet

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
)

func TestLoginStoresCookie(t *testing.T) {
	var sawCookie bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/auth/login":
			http.SetCookie(w, &http.Cookie{
				Name:     "flock_session",
				Value:    "sess-abc",
				Path:     "/",
				HttpOnly: true,
			})
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"user": map[string]any{
					"id": "u1", "username": "mj", "role": "admin", "isActive": true,
				},
			})
		case r.Method == http.MethodGet && r.URL.Path == "/api/auth/me":
			c, err := r.Cookie("flock_session")
			if err != nil || c.Value != "sess-abc" {
				w.WriteHeader(http.StatusUnauthorized)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"error": map[string]string{"code": "unauthorized", "message": "Not signed in."},
				})
				return
			}
			sawCookie = true
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"user": map[string]any{
					"id": "u1", "username": "mj", "role": "admin", "isActive": true,
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)

	dir := t.TempDir()
	cookiePath := filepath.Join(dir, "cookies.json")
	c, err := New(srv.URL, WithCookiePath(cookiePath))
	if err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	if err := c.Login(ctx, "mj", "secret"); err != nil {
		t.Fatal(err)
	}

	me, err := c.Me(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if me.Username != "mj" {
		t.Fatalf("username = %q", me.Username)
	}
	if !sawCookie {
		t.Fatal("expected /me to receive flock_session cookie")
	}

	st, err := os.Stat(cookiePath)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("cookie file perm = %o, want 0600", st.Mode().Perm())
	}
	raw, err := os.ReadFile(cookiePath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "flock_session") || !strings.Contains(string(raw), "sess-abc") {
		t.Fatalf("cookie file missing session: %s", raw)
	}

	// New client loads cookies and can call /me without login.
	c2, err := New(srv.URL, WithCookiePath(cookiePath))
	if err != nil {
		t.Fatal(err)
	}
	me2, err := c2.Me(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if me2.Username != "mj" {
		t.Fatalf("reloaded me = %+v", me2)
	}
}

func TestErrorEnvelope401(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]string{
				"code":    "unauthorized",
				"message": "Not signed in.",
			},
		})
	}))
	t.Cleanup(srv.Close)

	c, err := New(srv.URL, WithCookiePath("-"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.Me(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
	fe, ok := err.(*FleetError)
	if !ok {
		t.Fatalf("err type %T: %v", err, err)
	}
	if fe.Status != 401 {
		t.Fatalf("status = %d", fe.Status)
	}
	if fe.Code != "unauthorized" {
		t.Fatalf("code = %q", fe.Code)
	}
	if fe.Message != "Not signed in." {
		t.Fatalf("message = %q", fe.Message)
	}
	if !strings.Contains(fe.Error(), "unauthorized") {
		t.Fatalf("Error() = %q", fe.Error())
	}
}

func TestListSessionsMapsFields(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/sessions" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"sessions": []map[string]any{
				{
					"id":              "11111111-1111-1111-1111-111111111111",
					"nodeId":          "22222222-2222-2222-2222-222222222222",
					"projectId":       "33333333-3333-3333-3333-333333333333",
					"agentType":       "claude-code",
					"tmuxSessionName": "flock-sess-1",
					"workingDir":      "/work/repo",
					"status":          "awaiting_input",
				},
				{
					"id":        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
					"nodeId":    "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
					"projectId": "cccccccc-cccc-cccc-cccc-cccccccccccc",
					"agentType": "terminal",
					"name":      "shell-1",
					"cwd":       "/tmp",
					"status":    "idle",
				},
			},
		})
	}))
	t.Cleanup(srv.Close)

	c, err := New(srv.URL, WithCookiePath("-"))
	if err != nil {
		t.Fatal(err)
	}
	sessions, err := c.ListSessions(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 2 {
		t.Fatalf("len = %d", len(sessions))
	}

	s0 := sessions[0]
	if s0.ID != "11111111-1111-1111-1111-111111111111" {
		t.Fatalf("id = %q", s0.ID)
	}
	if s0.NodeID != "22222222-2222-2222-2222-222222222222" {
		t.Fatalf("nodeId = %q", s0.NodeID)
	}
	if s0.ProjectID != "33333333-3333-3333-3333-333333333333" {
		t.Fatalf("projectId = %q", s0.ProjectID)
	}
	if s0.AgentType != domain.AgentClaudeCode {
		t.Fatalf("agentType = %q", s0.AgentType)
	}
	if s0.Name != "flock-sess-1" {
		t.Fatalf("name = %q", s0.Name)
	}
	if s0.Cwd != "/work/repo" {
		t.Fatalf("cwd = %q", s0.Cwd)
	}
	if s0.Status != domain.StatusAwaitingInput {
		t.Fatalf("status = %q", s0.Status)
	}

	s1 := sessions[1]
	if s1.Name != "shell-1" || s1.Cwd != "/tmp" {
		t.Fatalf("fallback mapping: %+v", s1)
	}
	if s1.Status != domain.StatusIdle {
		t.Fatalf("status = %q", s1.Status)
	}
}

func TestListProjectsAndNodes(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/projects":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"projects": []map[string]any{
					{"id": "p1", "nodeId": "n1", "name": "app", "workingDir": "/src"},
				},
			})
		case "/api/nodes":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"nodes": []map[string]any{
					{"id": "n1", "name": "local", "kind": "local", "connectionStatus": "connected"},
					{"id": "n2", "name": "box", "kind": "ssh", "connectionStatus": "disconnected"},
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)

	c, err := New(srv.URL, WithCookiePath("-"))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	projects, err := c.ListProjects(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(projects) != 1 || projects[0].Cwd != "/src" || projects[0].Name != "app" {
		t.Fatalf("projects = %+v", projects)
	}
	nodes, err := c.ListNodes(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(nodes) != 2 {
		t.Fatalf("nodes = %+v", nodes)
	}
	if !nodes[0].Online() || nodes[1].Online() {
		t.Fatalf("online flags: %+v", nodes)
	}
	if nodes[1].Kind != domain.NodeSSH {
		t.Fatalf("kind = %q", nodes[1].Kind)
	}
}

func TestAuthStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/auth/status" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]bool{"setupRequired": true})
	}))
	t.Cleanup(srv.Close)

	c, err := New(srv.URL, WithCookiePath("-"))
	if err != nil {
		t.Fatal(err)
	}
	need, err := c.AuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !need {
		t.Fatal("expected setupRequired true")
	}
}

func TestLoginBadCredentials(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]string{"code": "invalid_credentials", "message": "Invalid username or password."},
		})
	}))
	t.Cleanup(srv.Close)

	c, err := New(srv.URL, WithCookiePath("-"))
	if err != nil {
		t.Fatal(err)
	}
	err = c.Login(context.Background(), "x", "y")
	fe, ok := err.(*FleetError)
	if !ok {
		t.Fatalf("got %T %v", err, err)
	}
	if fe.Code != "invalid_credentials" {
		t.Fatalf("code = %q", fe.Code)
	}
}

func TestNewValidatesBase(t *testing.T) {
	if _, err := New(""); err == nil {
		t.Fatal("expected error")
	}
	if _, err := New("ftp://x"); err == nil {
		t.Fatal("expected scheme error")
	}
	c, err := New("https://flock.example/", WithCookiePath("-"))
	if err != nil {
		t.Fatal(err)
	}
	if c.BaseURL() != "https://flock.example" {
		t.Fatalf("base = %q", c.BaseURL())
	}
	if c.CookieJar() == nil || c.HTTP() == nil {
		t.Fatal("expected jar and http client")
	}
	caps := c.Capabilities()
	if caps.Mode != "fleet" || !caps.MultiNode {
		t.Fatalf("caps = %#v", caps)
	}
}

func TestSetSessionCookie(t *testing.T) {
	c, err := New("http://127.0.0.1:3000", WithCookiePath("-"))
	if err != nil {
		t.Fatal(err)
	}
	if err := c.SetSessionCookie("", "secret-token"); err != nil {
		t.Fatal(err)
	}
	cookies := c.CookieJar().Cookies(c.base)
	if len(cookies) != 1 || cookies[0].Name != "flock_session" || cookies[0].Value != "secret-token" {
		t.Fatalf("cookies = %#v", cookies)
	}
}

func TestDialWithToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/auth/me" {
			http.NotFound(w, r)
			return
		}
		ck, err := r.Cookie("flock_session")
		if err != nil || ck.Value != "tok-1" {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error": map[string]string{"code": "unauthorized", "message": "no"},
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"user": map[string]any{"id": "u", "username": "op", "role": "admin"},
		})
	}))
	t.Cleanup(srv.Close)

	ctx := context.Background()
	c, err := Dial(ctx, srv.URL, Auth{Token: "tok-1"}, WithCookiePath("-"))
	if err != nil {
		t.Fatal(err)
	}
	if c.UserInfo().Username != "op" {
		t.Fatalf("user = %+v", c.UserInfo())
	}
}

func TestDefaultCookiePathUsesConfigDir(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("SHEP_TUI_CONFIG_DIR", dir)
	got := DefaultCookiePath()
	if got != filepath.Join(dir, "cookies.json") {
		t.Fatalf("path = %q", got)
	}
}

func TestClientTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
		w.WriteHeader(200)
	}))
	t.Cleanup(srv.Close)

	c, err := New(srv.URL, WithCookiePath("-"))
	if err != nil {
		t.Fatal(err)
	}
	c.HTTP().Timeout = 5 * time.Millisecond
	err = c.Login(context.Background(), "a", "b")
	if err == nil {
		t.Fatal("expected timeout error")
	}
	if _, ok := err.(*FleetError); ok {
		t.Fatalf("should not be FleetError: %v", err)
	}
}

// The node list carries the whole shape, not a bool: host, ssh user, pool, the
// connection status and when the node was last seen.
func TestListNodesParsesTheFullShape(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/nodes" || r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"nodes": []map[string]any{
				{
					"id": "n1", "name": "orchestrator", "kind": "local",
					"host": nil, "port": nil, "sshUser": nil, "pool": nil,
					"connectionStatus": "connected", "lastSeenAt": "2026-07-01T10:00:00Z",
				},
				{
					"id": "n2", "name": "box", "kind": "ssh",
					"host": "10.0.0.2", "port": 2222, "sshUser": "mj", "pool": "gpu",
					"connectionStatus": "error", "lastSeenAt": nil,
				},
			},
		})
	}))
	t.Cleanup(srv.Close)

	c, err := New(srv.URL, WithCookiePath("-"))
	if err != nil {
		t.Fatal(err)
	}
	nodes, err := c.ListNodes(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(nodes) != 2 {
		t.Fatalf("nodes = %+v", nodes)
	}
	if nodes[0].Host != "" || nodes[0].Port != 0 || !nodes[0].Online() {
		t.Fatalf("local node = %+v", nodes[0])
	}
	if nodes[0].LastSeenAt.IsZero() {
		t.Fatalf("lastSeenAt not parsed: %+v", nodes[0])
	}
	n := nodes[1]
	if n.Host != "10.0.0.2" || n.Port != 2222 || n.SSHUser != "mj" || n.Pool != "gpu" {
		t.Fatalf("ssh node = %+v", n)
	}
	if n.ConnectionStatus != domain.NodeErrored || n.Online() {
		t.Fatalf("status = %q", n.ConnectionStatus)
	}
	if !n.LastSeenAt.IsZero() {
		t.Fatalf("null lastSeenAt became %v", n.LastSeenAt)
	}
}

func TestCreateNodePostsTheRegistration(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/nodes" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Error(err)
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"node": map[string]any{
				"id": "n9", "name": "box", "kind": "ssh", "host": "10.0.0.2",
				"port": 22, "sshUser": "mj", "pool": nil,
				"connectionStatus": "connecting", "lastSeenAt": nil,
			},
		})
	}))
	t.Cleanup(srv.Close)

	c, err := New(srv.URL, WithCookiePath("-"))
	if err != nil {
		t.Fatal(err)
	}
	node, err := c.CreateNode(context.Background(), backend.NodeSpec{
		Name: "box", Kind: domain.NodeSSH, Host: "10.0.0.2", Port: 22,
		SSHUser: "mj", SSHAuthMethod: "key", SSHPrivateKey: "PRIVATE-KEY-BYTES",
	})
	if err != nil {
		t.Fatal(err)
	}
	if node.ID != "n9" || node.Kind != domain.NodeSSH || node.ConnectionStatus != domain.NodeConnecting {
		t.Fatalf("node = %+v", node)
	}
	for k, want := range map[string]any{
		"name": "box", "kind": "ssh", "host": "10.0.0.2", "port": float64(22),
		"sshUser": "mj", "sshAuthMethod": "key", "sshPrivateKey": "PRIVATE-KEY-BYTES",
	} {
		if got[k] != want {
			t.Errorf("body[%s] = %v, want %v", k, got[k], want)
		}
	}
	if _, ok := got["sshPassword"]; ok {
		t.Error("an unset password was sent as an empty string")
	}
}

// An ssh node with no credential is refused before anything is sent: the
// orchestrator would reject it, and a half-registered node is worse than none.
func TestCreateNodeRefusesIncompleteSSH(t *testing.T) {
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(srv.Close)

	c, err := New(srv.URL, WithCookiePath("-"))
	if err != nil {
		t.Fatal(err)
	}
	for _, spec := range []backend.NodeSpec{
		{Name: "box", Kind: domain.NodeSSH, SSHUser: "mj", SSHPrivateKey: "k"},
		{Name: "box", Kind: domain.NodeSSH, Host: "h", SSHPrivateKey: "k"},
		{Name: "box", Kind: domain.NodeSSH, Host: "h", SSHUser: "mj"},
		{Name: "box", Kind: domain.NodeSSH, Host: "h", SSHUser: "mj", SSHAuthMethod: "password"},
	} {
		if _, err := c.CreateNode(context.Background(), spec); err == nil {
			t.Fatalf("CreateNode(%+v) was accepted", spec)
		}
	}
	if calls != 0 {
		t.Fatalf("%d incomplete registrations reached the server", calls)
	}
}
