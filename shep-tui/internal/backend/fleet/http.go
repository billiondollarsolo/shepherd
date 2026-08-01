package fleet

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
)

// Login POSTs /api/auth/login and stores the session cookie in the jar.
func (c *Client) Login(ctx context.Context, username, password string) error {
	body := map[string]string{
		"username": username,
		"password": password,
	}
	var out struct {
		User User `json:"user"`
	}
	if err := c.doJSON(ctx, http.MethodPost, "/api/auth/login", body, &out); err != nil {
		return err
	}
	if out.User.Username != "" || out.User.ID != "" {
		c.mu.Lock()
		c.user = out.User
		c.mu.Unlock()
	}
	if c.cookie != nil {
		if err := c.cookie.Save(); err != nil {
			return fmt.Errorf("save cookies after login: %w", err)
		}
	}
	return nil
}

// Me GETs /api/auth/me.
func (c *Client) Me(ctx context.Context) (User, error) {
	var out struct {
		User User `json:"user"`
	}
	if err := c.doJSON(ctx, http.MethodGet, "/api/auth/me", nil, &out); err != nil {
		return User{}, err
	}
	if out.User.ID == "" && out.User.Username == "" {
		return User{}, fmt.Errorf("empty user in /api/auth/me response")
	}
	c.mu.Lock()
	c.user = out.User
	c.mu.Unlock()
	return out.User, nil
}

// AuthStatus GETs public /api/auth/status (setupRequired probe).
func (c *Client) AuthStatus(ctx context.Context) (setupRequired bool, err error) {
	var out struct {
		SetupRequired bool `json:"setupRequired"`
	}
	if err := c.doJSON(ctx, http.MethodGet, "/api/auth/status", nil, &out); err != nil {
		return false, err
	}
	return out.SetupRequired, nil
}

// ListSessions implements backend.Backend via GET /api/sessions.
func (c *Client) ListSessions(ctx context.Context) ([]domain.Session, error) {
	var out struct {
		Sessions []wireSession `json:"sessions"`
	}
	if err := c.doJSON(ctx, http.MethodGet, "/api/sessions", nil, &out); err != nil {
		return nil, err
	}
	sessions := make([]domain.Session, 0, len(out.Sessions))
	for _, s := range out.Sessions {
		sessions = append(sessions, s.toDomain())
	}
	return sessions, nil
}

// ListProjects GETs /api/projects.
func (c *Client) ListProjects(ctx context.Context) ([]domain.Project, error) {
	var out struct {
		Projects []wireProject `json:"projects"`
	}
	if err := c.doJSON(ctx, http.MethodGet, "/api/projects", nil, &out); err != nil {
		return nil, err
	}
	projects := make([]domain.Project, 0, len(out.Projects))
	for _, p := range out.Projects {
		projects = append(projects, p.toDomain())
	}
	return projects, nil
}

// ListNodes GETs /api/nodes.
func (c *Client) ListNodes(ctx context.Context) ([]domain.Node, error) {
	var out struct {
		Nodes []wireNode `json:"nodes"`
	}
	if err := c.doJSON(ctx, http.MethodGet, "/api/nodes", nil, &out); err != nil {
		return nil, err
	}
	nodes := make([]domain.Node, 0, len(out.Nodes))
	for _, n := range out.Nodes {
		nodes = append(nodes, n.toDomain())
	}
	return nodes, nil
}

// CreateNode POSTs /api/nodes. The credential in spec is written to the request
// body and nowhere else: it is never held on the Client and never logged.
func (c *Client) CreateNode(ctx context.Context, spec backend.NodeSpec) (domain.Node, error) {
	if spec.Name == "" {
		return domain.Node{}, fmt.Errorf("CreateNode: name required")
	}
	if spec.Kind == "" {
		spec.Kind = domain.NodeLocal
	}
	if spec.Kind == domain.NodeSSH {
		if spec.Host == "" || spec.SSHUser == "" {
			return domain.Node{}, fmt.Errorf("CreateNode: host and ssh user are required for ssh nodes")
		}
		if spec.SSHAuthMethod == "password" {
			if spec.SSHPassword == "" {
				return domain.Node{}, fmt.Errorf("CreateNode: password required for password auth")
			}
		} else if spec.SSHPrivateKey == "" {
			return domain.Node{}, fmt.Errorf("CreateNode: private key required for key auth")
		}
	}
	body := createNodeBody{
		Name:          spec.Name,
		Kind:          string(spec.Kind),
		Host:          spec.Host,
		Port:          spec.Port,
		SSHUser:       spec.SSHUser,
		SSHAuthMethod: spec.SSHAuthMethod,
		SSHPrivateKey: spec.SSHPrivateKey,
		SSHPassphrase: spec.SSHPassphrase,
		SSHPassword:   spec.SSHPassword,
		Pool:          spec.Pool,
	}
	var out struct {
		Node wireNode `json:"node"`
	}
	if err := c.doJSON(ctx, http.MethodPost, "/api/nodes", body, &out); err != nil {
		return domain.Node{}, err
	}
	return out.Node.toDomain(), nil
}

// NodeStatus GETs /api/nodes/:id/status.
func (c *Client) NodeStatus(ctx context.Context, id string) (domain.ConnectionStatus, error) {
	if id == "" {
		return "", fmt.Errorf("NodeStatus: empty id")
	}
	var out struct {
		ConnectionStatus string `json:"connectionStatus"`
	}
	if err := c.doJSON(ctx, http.MethodGet, "/api/nodes/"+url.PathEscape(id)+"/status", nil, &out); err != nil {
		return "", err
	}
	return domain.ConnectionStatus(out.ConnectionStatus), nil
}

// CloseSession implements backend.Backend via DELETE /api/sessions/:id.
func (c *Client) CloseSession(ctx context.Context, id string) error {
	if id == "" {
		return fmt.Errorf("CloseSession: empty id")
	}
	return c.doJSON(ctx, http.MethodDelete, "/api/sessions/"+url.PathEscape(id), nil, nil)
}

func (c *Client) doJSON(ctx context.Context, method, path string, reqBody any, out any) error {
	if c.isClosed() {
		return fmt.Errorf("fleet client closed")
	}

	var bodyReader io.Reader
	if reqBody != nil {
		b, err := json.Marshal(reqBody)
		if err != nil {
			return err
		}
		bodyReader = bytes.NewReader(b)
	}

	u := c.baseURL + path
	req, err := http.NewRequestWithContext(ctx, method, u, bodyReader)
	if err != nil {
		return err
	}
	if reqBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")

	res, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("fleet: %s %s: %w", method, path, err)
	}
	defer res.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return fmt.Errorf("fleet: read body: %w", err)
	}

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return parseError(res.StatusCode, raw)
	}
	if out == nil || res.StatusCode == http.StatusNoContent || len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("fleet: decode %s %s: %w", method, path, err)
	}
	return nil
}

func parseError(status int, raw []byte) error {
	var env struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(raw, &env)
	fe := &FleetError{
		Status:  status,
		Code:    env.Error.Code,
		Message: env.Error.Message,
	}
	if fe.Message == "" && fe.Code == "" && len(raw) > 0 {
		msg := strings.TrimSpace(string(raw))
		if len(msg) > 200 {
			msg = msg[:200] + "…"
		}
		fe.Message = msg
	}
	if fe.Message == "" {
		fe.Message = http.StatusText(status)
	}
	return fe
}

type wireSession struct {
	ID              string `json:"id"`
	NodeID          string `json:"nodeId"`
	ProjectID       string `json:"projectId"`
	AgentType       string `json:"agentType"`
	WorkingDir      string `json:"workingDir"`
	Status          string `json:"status"`
	Note            string `json:"note"`
	Name            string `json:"name"`
	TmuxSessionName string `json:"tmuxSessionName"`
	Cwd             string `json:"cwd"`
}

func (s wireSession) toDomain() domain.Session {
	cwd := s.WorkingDir
	if cwd == "" {
		cwd = s.Cwd
	}
	name := s.TmuxSessionName
	if name == "" {
		name = s.Name
	}
	if name == "" {
		name = s.Note
	}
	if name == "" {
		name = s.ID
	}
	return domain.Session{
		ID:        s.ID,
		NodeID:    s.NodeID,
		ProjectID: s.ProjectID,
		Name:      name,
		AgentType: domain.AgentType(s.AgentType),
		Status:    domain.ParseStatus(s.Status),
		Cwd:       cwd,
	}
}

type wireProject struct {
	ID         string `json:"id"`
	NodeID     string `json:"nodeId"`
	Name       string `json:"name"`
	WorkingDir string `json:"workingDir"`
}

func (p wireProject) toDomain() domain.Project {
	return domain.Project{
		ID:     p.ID,
		NodeID: p.NodeID,
		Name:   p.Name,
		Cwd:    p.WorkingDir,
	}
}

type wireNode struct {
	ID               string  `json:"id"`
	Name             string  `json:"name"`
	Kind             string  `json:"kind"`
	Host             *string `json:"host"`
	Port             *int    `json:"port"`
	SSHUser          *string `json:"sshUser"`
	Pool             *string `json:"pool"`
	ConnectionStatus string  `json:"connectionStatus"`
	LastSeenAt       *string `json:"lastSeenAt"`
}

func (n wireNode) toDomain() domain.Node {
	node := domain.Node{
		ID:               n.ID,
		Name:             n.Name,
		Kind:             domain.NodeKind(n.Kind),
		Host:             deref(n.Host),
		SSHUser:          deref(n.SSHUser),
		Pool:             deref(n.Pool),
		ConnectionStatus: domain.ConnectionStatus(n.ConnectionStatus),
	}
	if n.Port != nil {
		node.Port = *n.Port
	}
	if seen := deref(n.LastSeenAt); seen != "" {
		if t, err := time.Parse(time.RFC3339, seen); err == nil {
			node.LastSeenAt = t
		}
	}
	return node
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// createNodeBody is the POST /api/nodes payload (shared CreateNodeRequest). The
// credential fields are omitempty: a node registered without one must not send a
// blank secret the orchestrator would reject as invalid.
type createNodeBody struct {
	Name          string `json:"name"`
	Kind          string `json:"kind"`
	Host          string `json:"host,omitempty"`
	Port          int    `json:"port,omitempty"`
	SSHUser       string `json:"sshUser,omitempty"`
	SSHAuthMethod string `json:"sshAuthMethod,omitempty"`
	SSHPrivateKey string `json:"sshPrivateKey,omitempty"`
	SSHPassphrase string `json:"sshPassphrase,omitempty"`
	SSHPassword   string `json:"sshPassword,omitempty"`
	Pool          string `json:"pool,omitempty"`
}
