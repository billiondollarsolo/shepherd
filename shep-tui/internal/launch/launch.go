// Package launch builds agent session commands for standalone paddock launch (E1/E10/E14).
package launch

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Agent is a first-class launcher id (wizard + CLI).
type Agent string

const (
	AgentClaude   Agent = "claude"
	AgentCodex    Agent = "codex"
	AgentOpenCode Agent = "opencode"
	AgentGemini   Agent = "gemini"
	AgentGrok     Agent = "grok"
	AgentShell    Agent = "shell"
	AgentCustom   Agent = "custom"
)

// KnownAgents is the ordered wizard list.
var KnownAgents = []Agent{
	AgentClaude, AgentCodex, AgentOpenCode, AgentGemini, AgentGrok, AgentShell,
}

// Spec is a launch request (wizard or CLI).
type Spec struct {
	Agent Agent
	Cwd   string
	// SessionID optional; generated if empty.
	SessionID string
	// Extra args after the agent binary (or full custom argv when Agent=custom).
	Args []string
	// CustomCommand used when Agent=custom (argv[0] is binary).
	CustomCommand []string
	Cols, Rows    uint16
}

// Result is the resolved open payload for agentd.
type Result struct {
	ID      string
	Kind    string // agent | shell
	Cwd     string
	Command []string
	Cols    uint16
	Rows    uint16
}

// Build resolves Spec into an agentd open Result.
func Build(s Spec) (Result, error) {
	cwd := strings.TrimSpace(s.Cwd)
	if cwd == "" {
		var err error
		cwd, err = os.Getwd()
		if err != nil {
			home, _ := os.UserHomeDir()
			cwd = home
		}
	}
	abs, err := filepath.Abs(cwd)
	if err == nil {
		cwd = abs
	}

	id := strings.TrimSpace(s.SessionID)
	if id == "" {
		id = fmt.Sprintf("%s-%d", s.Agent, time.Now().UnixNano()%1_000_000_000)
	}

	cols, rows := s.Cols, s.Rows
	if cols == 0 {
		cols = 80
	}
	if rows == 0 {
		rows = 24
	}

	cmd, kind, err := commandFor(s)
	if err != nil {
		return Result{}, err
	}
	return Result{
		ID:      id,
		Kind:    kind,
		Cwd:     cwd,
		Command: cmd,
		Cols:    cols,
		Rows:    rows,
	}, nil
}

func commandFor(s Spec) (cmd []string, kind string, err error) {
	kind = "agent"
	switch s.Agent {
	case AgentClaude:
		cmd = []string{"claude"}
	case AgentCodex:
		cmd = []string{"codex"}
	case AgentOpenCode:
		cmd = []string{"opencode"}
	case AgentGemini:
		cmd = []string{"gemini"}
	case AgentGrok:
		cmd = []string{"grok"}
	case AgentShell:
		kind = "shell"
		shell := os.Getenv("SHELL")
		if shell == "" {
			shell = "/bin/sh"
		}
		// login-ish interactive shell
		if filepath.Base(shell) == "bash" || strings.HasSuffix(shell, "/bash") {
			cmd = []string{shell, "-l"}
		} else {
			cmd = []string{shell}
		}
	case AgentCustom:
		if len(s.CustomCommand) == 0 {
			return nil, "", fmt.Errorf("launch: custom agent requires CustomCommand")
		}
		cmd = append([]string(nil), s.CustomCommand...)
	default:
		return nil, "", fmt.Errorf("launch: unknown agent %q", s.Agent)
	}
	if len(s.Args) > 0 && s.Agent != AgentCustom {
		cmd = append(cmd, s.Args...)
	}
	return cmd, kind, nil
}

// ParseAgent maps CLI/user strings to Agent.
func ParseAgent(s string) (Agent, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	switch s {
	case "claude", "claude-code", "claude_code":
		return AgentClaude, nil
	case "codex":
		return AgentCodex, nil
	case "opencode", "open-code":
		return AgentOpenCode, nil
	case "gemini":
		return AgentGemini, nil
	case "grok":
		return AgentGrok, nil
	case "shell", "bash", "sh":
		return AgentShell, nil
	case "custom":
		return AgentCustom, nil
	default:
		return "", fmt.Errorf("unknown agent %q (want claude|codex|opencode|gemini|grok|shell)", s)
	}
}
