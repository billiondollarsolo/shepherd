// Package fleet is the orchestrator HTTP+WebSocket backend (fleet mode).
//
// Auth is interim cookie-jar based (T0.11 debt flag): FLOCK_TOKEN / token_file /
// password login populate flock_session cookies used on REST and WS upgrades.
// Prefer production tokens when U1 lands.
//
// WebSocket framing (T0.12) lives in status.go / pty.go / ws.go.
package fleet

import (
	"context"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
)

// SessionCookieName is the orchestrator session cookie (apps/orchestrator auth/cookie.ts).
const SessionCookieName = "flock_session"

// Client talks to a Flock orchestrator over HTTP + WebSocket.
type Client struct {
	base    *url.URL
	baseURL string
	http    *http.Client
	jar     http.CookieJar
	cookie  *fileCookieJar // non-nil when using file-backed jar

	mu     sync.Mutex
	closed bool
	user   User
	// watches cancels the live /ws/status subscriptions. Close hangs them up:
	// a replaced client whose sockets keep reading would go on pushing status
	// for a fleet the app is no longer connected to.
	watches []context.CancelFunc
}

// User is a subset of the orchestrator User schema (/api/auth/me, login).
type User struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	Role        string `json:"role"`
	IsActive    bool   `json:"isActive"`
}

// Auth holds credentials for Dial.
// Prefer Token (session cookie value) when available; else Username+Password login.
type Auth struct {
	Token    string // flock_session cookie value (FLOCK_TOKEN / token_file)
	Username string
	Password string
}

// Option configures New / Dial.
type Option func(*Client) error

// WithCookiePath enables load/save of session cookies (JSON, mode 0600).
// Empty path uses DefaultCookiePath(); "-" disables disk persistence.
func WithCookiePath(path string) Option {
	return func(c *Client) error {
		if c.base == nil {
			return fmt.Errorf("fleet: base URL required before cookie path")
		}
		if path == "" {
			path = DefaultCookiePath()
		}
		if path == "-" {
			// In-memory jar only.
			jar, err := cookiejar.New(nil)
			if err != nil {
				return err
			}
			c.jar = jar
			c.cookie = nil
			if c.http != nil {
				c.http.Jar = jar
			}
			return nil
		}
		fj, err := newFileCookieJar(c.base, path)
		if err != nil {
			return err
		}
		c.cookie = fj
		c.jar = fj
		if c.http != nil {
			c.http.Jar = fj
		}
		return nil
	}
}

// New builds a Client without authenticating (tests / manual cookie inject).
// Default jar is in-memory only; pass WithCookiePath(path) to persist cookies.
func New(baseURL string, opts ...Option) (*Client, error) {
	base, err := parseBaseURL(baseURL)
	if err != nil {
		return nil, err
	}
	origin := strings.TrimRight(base.String(), "/")
	c := &Client{
		base:    base,
		baseURL: origin,
	}
	for _, opt := range opts {
		if err := opt(c); err != nil {
			return nil, err
		}
	}
	if c.jar == nil {
		// Default: in-memory jar (no disk I/O).
		if err := WithCookiePath("-")(c); err != nil {
			return nil, err
		}
	}
	if c.http == nil {
		c.http = &http.Client{
			Timeout: 30 * time.Second,
			Jar:     c.jar,
		}
	} else if c.http.Jar == nil {
		c.http.Jar = c.jar
	} else {
		c.jar = c.http.Jar
	}
	return c, nil
}

// Dial constructs a Client, authenticates, and verifies with GET /api/auth/me.
func Dial(ctx context.Context, baseURL string, auth Auth, opts ...Option) (*Client, error) {
	// Prefer in-memory cookies in Dial when no WithCookiePath supplied by caller…
	// but dial.Open always passes WithCookiePath for persistence.
	c, err := New(baseURL, opts...)
	if err != nil {
		return nil, err
	}
	if auth.Token != "" {
		if err := c.SetSessionCookie(SessionCookieName, auth.Token); err != nil {
			_ = c.Close()
			return nil, err
		}
	} else if auth.Username != "" && auth.Password != "" {
		if err := c.Login(ctx, auth.Username, auth.Password); err != nil {
			_ = c.Close()
			return nil, err
		}
	} else {
		// Try existing cookie jar (persisted session).
		if user, err := c.Me(ctx); err == nil {
			c.user = user
			return c, nil
		}
		_ = c.Close()
		return nil, fmt.Errorf("fleet: no credentials (set FLOCK_TOKEN, token_file, or FLOCK_USER+FLOCK_PASSWORD)")
	}
	user, err := c.Me(ctx)
	if err != nil {
		_ = c.Close()
		return nil, fmt.Errorf("fleet: auth check failed: %w", err)
	}
	c.user = user
	return c, nil
}

// ResolveAuth builds Auth from env + optional token file.
// Order: FLOCK_TOKEN, FLOCK_SESSION_COOKIE, tokenFile contents, FLOCK_USER/FLOCK_PASSWORD.
func ResolveAuth(tokenFile string) (Auth, error) {
	auth := Auth{
		Token:    firstNonEmpty(os.Getenv("FLOCK_TOKEN"), os.Getenv("FLOCK_SESSION_COOKIE")),
		Username: strings.TrimSpace(os.Getenv("FLOCK_USER")),
		Password: os.Getenv("FLOCK_PASSWORD"),
	}
	if auth.Token == "" && tokenFile != "" {
		b, err := os.ReadFile(tokenFile)
		if err != nil {
			return Auth{}, fmt.Errorf("read token_file %s: %w", tokenFile, err)
		}
		auth.Token = strings.TrimSpace(string(b))
	}
	return auth, nil
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if s := strings.TrimSpace(v); s != "" {
			return s
		}
	}
	return ""
}

// BaseURL returns the configured HTTP origin (no trailing slash).
func (c *Client) BaseURL() string { return c.baseURL }

// HTTP returns the underlying HTTP client (shared cookie jar).
func (c *Client) HTTP() *http.Client { return c.http }

// CookieJar returns the jar used for REST and WebSocket auth cookies.
func (c *Client) CookieJar() http.CookieJar { return c.jar }

// UserInfo returns the user cached from Dial/Login (may be zero before auth).
func (c *Client) UserInfo() User {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.user
}

// SetSessionCookie installs a session cookie for the orchestrator origin.
func (c *Client) SetSessionCookie(name, value string) error {
	if value == "" {
		return fmt.Errorf("empty session cookie value")
	}
	if name == "" {
		name = SessionCookieName
	}
	c.jar.SetCookies(c.base, []*http.Cookie{{
		Name:  name,
		Value: value,
		Path:  "/",
	}})
	if c.cookie != nil {
		_ = c.cookie.Save()
	}
	return nil
}

// cookieHeader builds a Cookie request header from the jar (for WS upgrades).
func (c *Client) cookieHeader() string {
	cookies := c.jar.Cookies(c.base)
	if len(cookies) == 0 {
		return ""
	}
	parts := make([]string, 0, len(cookies))
	for _, ck := range cookies {
		parts = append(parts, ck.Name+"="+ck.Value)
	}
	return strings.Join(parts, "; ")
}

// ListAudit is not yet wired to a fleet HTTP route (returns ErrNotSupported).
func (c *Client) ListAudit(ctx context.Context) ([]backend.AuditEntry, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}
	return nil, backend.ErrNotSupported
}

// Capabilities implements backend.Backend.
// Flags must match methods that succeed today — never advertise a surface that
// only returns ErrNotSupported (PRODUCT invariant: capability-gated honesty).
func (c *Client) Capabilities() backend.Caps {
	return backend.Caps{
		Mode:      "fleet",
		MultiNode: true, // node/project/session tree from REST
		Cost:      true, // /ws/status frames carry costUsd
		// Not wired on fleet yet (local-only or upstream missing):
		Launch:         false, // LaunchAgent / CreateShell → ErrNotSupported
		Git:            false, // no fleet git REST client; app uses LocalGit on cwd
		Files:          false, // no node FS API client
		Handoff:        false, // no session create to seed a handoff into
		ShellDrawer:    false, // CreateShell → ErrNotSupported
		Chat:           false, // no event stream API
		StructuredChat: false,
		Audit:          false, // ListAudit → ErrNotSupported
	}
}

// Close marks the client closed and hangs up its status watches. Open PTY
// streams must still be closed separately.
func (c *Client) Close() error {
	c.mu.Lock()
	watches := c.watches
	c.watches = nil
	c.closed = true
	c.mu.Unlock()
	for _, cancel := range watches {
		cancel()
	}
	return nil
}

// addWatch registers a status subscription's cancel with Close.
func (c *Client) addWatch(cancel context.CancelFunc) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.watches = append(c.watches, cancel)
}

func (c *Client) isClosed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

// CreateShell is not yet implemented (fleet session create HTTP).
func (c *Client) CreateShell(ctx context.Context, id, cwd string, cols, rows uint16) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	return backend.ErrNotSupported
}

// LaunchAgent is not yet implemented on fleet.
func (c *Client) LaunchAgent(ctx context.Context, id, kind, cwd string, command []string, cols, rows uint16) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	return backend.ErrNotSupported
}

func parseBaseURL(baseURL string) (*url.URL, error) {
	raw := strings.TrimSpace(baseURL)
	if raw == "" {
		return nil, fmt.Errorf("empty base URL")
	}
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("parse base URL: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("base URL scheme must be http or https, got %q", u.Scheme)
	}
	if u.Host == "" {
		return nil, fmt.Errorf("base URL missing host")
	}
	u.Path = ""
	u.RawPath = ""
	u.RawQuery = ""
	u.Fragment = ""
	return u, nil
}

// Compile-time check: Client implements Backend (methods split across files).
var _ backend.Backend = (*Client)(nil)
