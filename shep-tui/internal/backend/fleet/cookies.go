package fleet

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// cookieFile is the on-disk JSON shape for interim session cookies.
// DEBT(U1): replace with token file once U1 ships production auth tokens.
type cookieFile struct {
	// Entries keyed by request origin (scheme://host[:port]).
	Origins map[string][]storedCookie `json:"origins"`
}

type storedCookie struct {
	Name     string    `json:"name"`
	Value    string    `json:"value"`
	Path     string    `json:"path,omitempty"`
	Domain   string    `json:"domain,omitempty"`
	Expires  time.Time `json:"expires,omitempty"`
	Secure   bool      `json:"secure,omitempty"`
	HTTPOnly bool      `json:"httpOnly,omitempty"`
}

// DefaultCookiePath is ~/.config/shep-tui/cookies.json (or SHEP_TUI_CONFIG_DIR).
// Honors legacy FLOCK_TUI_CONFIG_DIR and flock-tui config dir when present.
func DefaultCookiePath() string {
	if d := os.Getenv("SHEP_TUI_CONFIG_DIR"); d != "" {
		return filepath.Join(d, "cookies.json")
	}
	if d := os.Getenv("FLOCK_TUI_CONFIG_DIR"); d != "" {
		return filepath.Join(d, "cookies.json")
	}
	dir, err := configDirForCookies()
	if err != nil {
		return filepath.Join(os.TempDir(), "shep-tui-cookies.json")
	}
	return filepath.Join(dir, "cookies.json")
}

func configDirForCookies() (string, error) {
	var preferred string
	if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
		preferred = filepath.Join(xdg, "shep-tui")
	} else {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		preferred = filepath.Join(home, ".config", "shep-tui")
	}
	if st, err := os.Stat(preferred); err == nil && st.IsDir() {
		return preferred, nil
	}
	legacy := filepath.Join(filepath.Dir(preferred), "flock-tui")
	if st, err := os.Stat(legacy); err == nil && st.IsDir() {
		return legacy, nil
	}
	return preferred, nil
}

// fileCookieJar wraps a memory jar with load/save of cookies for one origin.
// Safe for concurrent use of the underlying jar; Save/Load serialize on mu.
type fileCookieJar struct {
	inner http.CookieJar
	path  string
	base  *url.URL
	mu    sync.Mutex
}

func newFileCookieJar(base *url.URL, path string) (*fileCookieJar, error) {
	inner, err := cookiejar.New(nil)
	if err != nil {
		return nil, err
	}
	j := &fileCookieJar{inner: inner, path: path, base: base}
	if path != "" {
		if err := j.load(); err != nil && !os.IsNotExist(err) {
			return nil, err
		}
	}
	return j, nil
}

func (j *fileCookieJar) SetCookies(u *url.URL, cookies []*http.Cookie) {
	j.inner.SetCookies(u, cookies)
}

func (j *fileCookieJar) Cookies(u *url.URL) []*http.Cookie {
	return j.inner.Cookies(u)
}

func (j *fileCookieJar) load() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	data, err := os.ReadFile(j.path)
	if err != nil {
		return err
	}
	var file cookieFile
	if err := json.Unmarshal(data, &file); err != nil {
		return fmt.Errorf("decode cookie file %s: %w", j.path, err)
	}
	if file.Origins == nil {
		return nil
	}
	origin := originKey(j.base)
	for _, sc := range file.Origins[origin] {
		c := &http.Cookie{
			Name:     sc.Name,
			Value:    sc.Value,
			Path:     sc.Path,
			Domain:   sc.Domain,
			Expires:  sc.Expires,
			Secure:   sc.Secure,
			HttpOnly: sc.HTTPOnly,
		}
		if c.Path == "" {
			c.Path = "/"
		}
		j.inner.SetCookies(j.base, []*http.Cookie{c})
	}
	return nil
}

// Save persists cookies for the client's base origin into path (mode 0600).
func (j *fileCookieJar) Save() error {
	if j.path == "" {
		return nil
	}
	j.mu.Lock()
	defer j.mu.Unlock()

	file := cookieFile{Origins: map[string][]storedCookie{}}
	// Preserve other origins if the file already exists.
	if data, err := os.ReadFile(j.path); err == nil {
		_ = json.Unmarshal(data, &file)
		if file.Origins == nil {
			file.Origins = map[string][]storedCookie{}
		}
	}

	origin := originKey(j.base)
	cookies := j.inner.Cookies(j.base)
	stored := make([]storedCookie, 0, len(cookies))
	for _, c := range cookies {
		if c == nil || c.Name == "" {
			continue
		}
		stored = append(stored, storedCookie{
			Name:     c.Name,
			Value:    c.Value,
			Path:     c.Path,
			Domain:   c.Domain,
			Expires:  c.Expires,
			Secure:   c.Secure,
			HTTPOnly: c.HttpOnly,
		})
	}
	file.Origins[origin] = stored

	if err := os.MkdirAll(filepath.Dir(j.path), 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	tmp := j.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, j.path)
}

func originKey(u *url.URL) string {
	if u == nil {
		return ""
	}
	return u.Scheme + "://" + u.Host
}
