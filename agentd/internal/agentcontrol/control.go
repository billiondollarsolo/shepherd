// Package agentcontrol implements pure helpers for agent automation ops (H2.1)
// and project-scoped automation token checks used on the orchestrator (D12).
package agentcontrol

import (
	"regexp"
	"strings"
	"time"
)

// Key sequences for logical key names (Herdr-like).
var keyMap = map[string]string{
	"enter":     "\r",
	"return":    "\r",
	"esc":       "\x1b",
	"escape":    "\x1b",
	"tab":       "\t",
	"up":        "\x1b[A",
	"down":      "\x1b[B",
	"right":     "\x1b[C",
	"left":      "\x1b[D",
	"ctrl+c":    "\x03",
	"ctrl+d":    "\x04",
	"ctrl+z":    "\x1a",
	"ctrl+l":    "\x0c",
	"backspace": "\x7f",
	"space":     " ",
}

// EncodeKeys converts logical key names to terminal bytes. All keys are
// validated before any bytes are produced (fail closed).
func EncodeKeys(keys []string) (string, error) {
	var b strings.Builder
	for _, k := range keys {
		name := strings.ToLower(strings.TrimSpace(k))
		if name == "" {
			continue
		}
		if seq, ok := keyMap[name]; ok {
			b.WriteString(seq)
			continue
		}
		// single printable rune
		if len(name) == 1 {
			b.WriteString(name)
			continue
		}
		return "", errInvalidKey(name)
	}
	return b.String(), nil
}

type keyError string

func (e keyError) Error() string { return string(e) }

func errInvalidKey(k string) error {
	return keyError("invalid key: " + k)
}

// PromptPayload builds text + enter, with optional bracketed paste.
func PromptPayload(text string, bracketedPaste bool) string {
	if bracketedPaste {
		return "\x1b[200~" + text + "\x1b[201~\r"
	}
	return text + "\r"
}

// WaitMatch checks whether current status is in the until set.
func WaitMatch(current string, until []string) bool {
	if len(until) == 0 {
		// Herdr defaults: idle, done, blocked → wire idle, done, awaiting_input
		until = []string{"idle", "done", "awaiting_input"}
	}
	cur := strings.TrimSpace(current)
	for _, u := range until {
		if normalizeWait(u) == normalizeWait(cur) {
			return true
		}
	}
	return false
}

func normalizeWait(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	switch s {
	case "blocked", "needs_you", "needs-you":
		return "awaiting_input"
	case "working":
		return "running"
	default:
		return s
	}
}

// OutputMatch finds a line matching substring or regex in text.
func OutputMatch(text string, substr string, regex string) (matchedLine string, ok bool) {
	if regex != "" {
		re, err := regexp.Compile(regex)
		if err != nil {
			return "", false
		}
		for _, line := range strings.Split(text, "\n") {
			if re.MatchString(line) {
				return line, true
			}
		}
		return "", false
	}
	if substr == "" {
		return "", false
	}
	for _, line := range strings.Split(text, "\n") {
		if strings.Contains(line, substr) {
			return line, true
		}
	}
	// also allow full-text contains
	if strings.Contains(text, substr) {
		return substr, true
	}
	return "", false
}

// PromptStallDeadline is Herdr-like 5s lifecycle change requirement.
const PromptStallDefault = 5 * time.Second

// TokenScope describes a project-scoped automation token (D12).
type TokenScope struct {
	ProjectID string
	SessionID string // minting session
}

// AuthzAction is a control action for automation.
type AuthzAction string

const (
	ActionList   AuthzAction = "list"
	ActionPrompt AuthzAction = "prompt"
	ActionWait   AuthzAction = "wait"
	ActionRead   AuthzAction = "read"
	ActionKeys   AuthzAction = "keys"
	ActionCreate AuthzAction = "create"
	ActionAdmin  AuthzAction = "admin"
)

// Allow reports whether the token may perform action on targetProject.
// Same project only; admin always denied for automation tokens.
func (t TokenScope) Allow(action AuthzAction, targetProjectID string) bool {
	if t.ProjectID == "" || targetProjectID == "" {
		return false
	}
	if action == ActionAdmin {
		return false
	}
	return t.ProjectID == targetProjectID
}

// ControlCredentialEnvVars must never appear in agent environments.
var ControlCredentialEnvVars = []string{
	"FLOCK_AGENTD_SECRET",
	"FLOCK_AGENTD_CREDENTIAL",
	"AGENTD_CONTROL_SECRET",
	"FLOCK_MASTER_KEY",
	"FLOCK_NODE_CREDENTIAL",
}

// EnvHasControlCredential reports whether env list (KEY=VAL) leaks control secrets.
func EnvHasControlCredential(env []string) bool {
	for _, e := range env {
		key := e
		if i := strings.IndexByte(e, '='); i >= 0 {
			key = e[:i]
		}
		for _, banned := range ControlCredentialEnvVars {
			if strings.EqualFold(key, banned) {
				return true
			}
		}
	}
	return false
}
