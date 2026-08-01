// Package screendetect implements Herdr-compatible TOML screen-manifest matching
// for coding-agent status (master improvement plan H1.2 / D3).
//
// Adapted rule content originates from Herdr (Apache-2.0); see docs/herdr-attribution.md.
package screendetect

import (
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/BurntSushi/toml"
)

//go:embed manifests/*.toml
var bundledFS embed.FS

const DefaultKnownAgentIdleFallback = "default_known_agent_idle_fallback"
// EngineVersion is the matcher feature level; manifests with higher min_engine_version are skipped.
const EngineVersion = 3

// Detection states from screen manifests (mapped to Shepherd wire by MapToWire).
const (
	StateIdle    = "idle"
	StateWorking = "working"
	StateBlocked = "blocked"
	StateUnknown = "unknown"
)

// Input is the evidence fed to the engine.
type Input struct {
	Screen      string
	OSCTitle    string
	OSCProgress string
	Agent       string // e.g. "claude", "codex"
}

// Result is the engine classification.
type Result struct {
	State              string
	SkipStateUpdate    bool
	VisibleIdle        bool
	VisibleBlocker     bool
	VisibleWorking     bool
	MatchedRuleID      string
	MatchedPriority    int
	MatchedRegion      string
	FallbackReason     string
	ManifestVersion    string
	ManifestSource     string
	EvaluatedRuleCount int
}

// Explain is a richer diagnostic view.
type Explain struct {
	Agent              string  `json:"agent"`
	State              string  `json:"state"`
	SkipStateUpdate    bool    `json:"skipStateUpdate"`
	VisibleIdle        bool    `json:"visibleIdle"`
	VisibleBlocker     bool    `json:"visibleBlocker"`
	VisibleWorking     bool    `json:"visibleWorking"`
	MatchedRuleID      string  `json:"matchedRuleId,omitempty"`
	MatchedPriority    int     `json:"matchedPriority,omitempty"`
	MatchedRegion      string  `json:"matchedRegion,omitempty"`
	FallbackReason     string  `json:"fallbackReason,omitempty"`
	ManifestVersion    string  `json:"manifestVersion,omitempty"`
	ManifestSource     string  `json:"manifestSource,omitempty"`
	EvaluatedRuleCount int     `json:"evaluatedRuleCount"`
	ScreenPreview      string  `json:"screenPreview,omitempty"`
	OSCTitle           string  `json:"oscTitle,omitempty"`
}

// MapToWire maps screen states to Shepherd wire Status values.
func MapToWire(state string) string {
	switch state {
	case StateWorking:
		return "running"
	case StateBlocked:
		return "awaiting_input"
	case StateIdle:
		return "idle"
	case StateUnknown:
		return "" // leave unchanged
	default:
		return ""
	}
}

type manifestFile struct {
	ID               string `toml:"id"`
	Version          string `toml:"version"`
	MinEngineVersion int    `toml:"min_engine_version"`
	Rules            []rule `toml:"rules"`
}

type rule struct {
	ID             string   `toml:"id"`
	State          string   `toml:"state"`
	Priority       int      `toml:"priority"`
	Region         string   `toml:"region"`
	SkipStateUpdate bool    `toml:"skip_state_update"`
	VisibleIdle    bool     `toml:"visible_idle"`
	VisibleBlocker bool     `toml:"visible_blocker"`
	VisibleWorking bool     `toml:"visible_working"`
	Contains       []string `toml:"contains"`
	// Regex and LineRegex may be string or array of strings in TOML.
	Regex     any `toml:"regex"`
	LineRegex any `toml:"line_regex"`
	Any       []gate `toml:"any"`
	All       []gate `toml:"all"`
	Not       []gate `toml:"not"`
}

type gate struct {
	Contains  []string `toml:"contains"`
	Regex     any      `toml:"regex"`
	LineRegex any      `toml:"line_regex"`
	Any       []gate   `toml:"any"`
	All       []gate   `toml:"all"`
	Not       []gate   `toml:"not"`
}

type compiledManifest struct {
	id      string
	version string
	source  string
	rules   []compiledRule
}

type compiledRule struct {
	id             string
	state          string
	priority       int
	region         string
	skip           bool
	visibleIdle    bool
	visibleBlocker bool
	visibleWorking bool
	match          func(regionText string) bool
}

// Engine holds loaded manifests.
type Engine struct {
	mu        sync.RWMutex
	byAgent   map[string]*compiledManifest
	overrideDir string
}

// NewEngine loads bundled manifests and optional override directory.
func NewEngine(overrideDir string) (*Engine, error) {
	e := &Engine{byAgent: make(map[string]*compiledManifest), overrideDir: overrideDir}
	if err := e.reload(); err != nil {
		return nil, err
	}
	return e, nil
}

// Reload re-reads overrides and bundled manifests (H4.1).
func (e *Engine) Reload() error {
	return e.reload()
}

func (e *Engine) reload() error {
	next := make(map[string]*compiledManifest)
	entries, err := bundledFS.ReadDir("manifests")
	if err != nil {
		return err
	}
	for _, ent := range entries {
		if ent.IsDir() || !strings.HasSuffix(ent.Name(), ".toml") {
			continue
		}
		data, err := bundledFS.ReadFile("manifests/" + ent.Name())
		if err != nil {
			return err
		}
		// strip first-line attribution comments for parse
		cm, err := compileManifest(data, "bundled:"+ent.Name())
		if err != nil {
			// Skip incompatible/broken bundled files; do not fail daemon start.
			continue
		}
		next[cm.id] = cm
	}
	if e.overrideDir != "" {
		if dirs, err := os.ReadDir(e.overrideDir); err == nil {
			for _, ent := range dirs {
				if ent.IsDir() || !strings.HasSuffix(ent.Name(), ".toml") {
					continue
				}
				path := filepath.Join(e.overrideDir, ent.Name())
				data, err := os.ReadFile(path)
				if err != nil {
					continue
				}
				cm, err := compileManifest(data, "override:"+path)
				if err != nil {
					// invalid override ignored with best-effort (Herdr behavior)
					continue
				}
				next[cm.id] = cm
			}
		}
	}
	e.mu.Lock()
	e.byAgent = next
	e.mu.Unlock()
	return nil
}

// Agents returns loaded agent ids.
func (e *Engine) Agents() []string {
	e.mu.RLock()
	defer e.mu.RUnlock()
	out := make([]string, 0, len(e.byAgent))
	for k := range e.byAgent {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Detect classifies a screen for the given agent.
func (e *Engine) Detect(in Input) Result {
	e.mu.RLock()
	cm := e.byAgent[in.Agent]
	e.mu.RUnlock()
	if cm == nil {
		return Result{State: StateUnknown, FallbackReason: "no_manifest"}
	}
	// sort rules by priority desc
	rules := append([]compiledRule(nil), cm.rules...)
	sort.SliceStable(rules, func(i, j int) bool {
		return rules[i].priority > rules[j].priority
	})
	evaluated := 0
	for _, r := range rules {
		regionText := regionExtract(r.region, in)
		evaluated++
		if !r.match(regionText) {
			continue
		}
		res := Result{
			State:              r.state,
			SkipStateUpdate:    r.skip,
			VisibleIdle:        r.visibleIdle,
			VisibleBlocker:     r.visibleBlocker,
			VisibleWorking:     r.visibleWorking,
			MatchedRuleID:      r.id,
			MatchedPriority:    r.priority,
			MatchedRegion:      r.region,
			ManifestVersion:    cm.version,
			ManifestSource:     cm.source,
			EvaluatedRuleCount: evaluated,
		}
		return res
	}
	// known agent, no rule → idle fallback (strict blocked policy)
	return Result{
		State:              StateIdle,
		FallbackReason:     DefaultKnownAgentIdleFallback,
		ManifestVersion:    cm.version,
		ManifestSource:     cm.source,
		EvaluatedRuleCount: evaluated,
	}
}

// Explain returns diagnostic details.
func (e *Engine) Explain(in Input) Explain {
	r := e.Detect(in)
	preview := in.Screen
	if len(preview) > 500 {
		preview = preview[len(preview)-500:]
	}
	return Explain{
		Agent:              in.Agent,
		State:              r.State,
		SkipStateUpdate:    r.SkipStateUpdate,
		VisibleIdle:        r.VisibleIdle,
		VisibleBlocker:     r.VisibleBlocker,
		VisibleWorking:     r.VisibleWorking,
		MatchedRuleID:      r.MatchedRuleID,
		MatchedPriority:    r.MatchedPriority,
		MatchedRegion:      r.MatchedRegion,
		FallbackReason:     r.FallbackReason,
		ManifestVersion:    r.ManifestVersion,
		ManifestSource:     r.ManifestSource,
		EvaluatedRuleCount: r.EvaluatedRuleCount,
		ScreenPreview:      preview,
		OSCTitle:           in.OSCTitle,
	}
}

func compileManifest(data []byte, source string) (*compiledManifest, error) {
	// Drop leading # comment lines so BurntSushi/toml can parse.
	text := string(data)
	var lines []string
	for _, line := range strings.Split(text, "\n") {
		trim := strings.TrimSpace(line)
		if strings.HasPrefix(trim, "#") {
			continue
		}
		lines = append(lines, line)
	}
	text = strings.Join(lines, "\n")
	var mf manifestFile
	if _, err := toml.Decode(text, &mf); err != nil {
		return nil, err
	}
	if mf.ID == "" {
		return nil, fmt.Errorf("manifest missing id")
	}
	if mf.MinEngineVersion > EngineVersion {
		return nil, fmt.Errorf("skip: manifest requires engine %d > %d", mf.MinEngineVersion, EngineVersion)
	}
	cm := &compiledManifest{id: mf.ID, version: mf.Version, source: source}
	for _, r := range mf.Rules {
		cr, err := compileRule(r)
		if err != nil {
			// Skip rules with engine-incompatible regex (Rust vs RE2); keep rest of manifest.
			continue
		}
		cm.rules = append(cm.rules, cr)
	}
	return cm, nil
}

func compileRule(r rule) (compiledRule, error) {
	cr := compiledRule{
		id:             r.ID,
		state:          r.State,
		priority:       r.Priority,
		region:         r.Region,
		skip:           r.SkipStateUpdate,
		visibleIdle:    r.VisibleIdle,
		visibleBlocker: r.VisibleBlocker,
		visibleWorking: r.VisibleWorking,
	}
	if cr.region == "" {
		cr.region = "whole_recent"
	}
	// Build matcher from top-level fields as an implicit ALL of present conditions.
	var parts []func(string) bool
	if len(r.Contains) > 0 {
		need := append([]string(nil), r.Contains...)
		parts = append(parts, func(s string) bool {
			for _, c := range need {
				if !strings.Contains(s, c) {
					return false
				}
			}
			return true
		})
	}
	if rs := asStringSlice(r.Regex); len(rs) > 0 {
		regs, err := compileRegexes(rs)
		if err != nil {
			return cr, err
		}
		parts = append(parts, func(s string) bool {
			for _, re := range regs {
				if re.MatchString(s) {
					return true
				}
			}
			return false
		})
	}
	if rs := asStringSlice(r.LineRegex); len(rs) > 0 {
		regs, err := compileRegexes(rs)
		if err != nil {
			return cr, err
		}
		parts = append(parts, func(s string) bool {
			for _, line := range strings.Split(s, "\n") {
				for _, re := range regs {
					if re.MatchString(line) {
						return true
					}
				}
			}
			return false
		})
	}
	if len(r.Any) > 0 {
		gates, err := compileGates(r.Any)
		if err != nil {
			return cr, err
		}
		parts = append(parts, func(s string) bool {
			for _, g := range gates {
				if g(s) {
					return true
				}
			}
			return false
		})
	}
	if len(r.All) > 0 {
		gates, err := compileGates(r.All)
		if err != nil {
			return cr, err
		}
		parts = append(parts, func(s string) bool {
			for _, g := range gates {
				if !g(s) {
					return false
				}
			}
			return true
		})
	}
	if len(r.Not) > 0 {
		gates, err := compileGates(r.Not)
		if err != nil {
			return cr, err
		}
		parts = append(parts, func(s string) bool {
			for _, g := range gates {
				if g(s) {
					return false
				}
			}
			return true
		})
	}
	if len(parts) == 0 {
		// always match (should be rare)
		cr.match = func(string) bool { return true }
	} else {
		cr.match = func(s string) bool {
			for _, p := range parts {
				if !p(s) {
					return false
				}
			}
			return true
		}
	}
	return cr, nil
}

func compileGates(gs []gate) ([]func(string) bool, error) {
	out := make([]func(string) bool, 0, len(gs))
	for _, g := range gs {
		fn, err := compileGate(g)
		if err != nil {
			return nil, err
		}
		out = append(out, fn)
	}
	return out, nil
}

func compileGate(g gate) (func(string) bool, error) {
	var parts []func(string) bool
	if len(g.Contains) > 0 {
		need := append([]string(nil), g.Contains...)
		parts = append(parts, func(s string) bool {
			for _, c := range need {
				if !strings.Contains(s, c) {
					return false
				}
			}
			return true
		})
	}
	if rs := asStringSlice(g.Regex); len(rs) > 0 {
		regs, err := compileRegexes(rs)
		if err != nil {
			return nil, err
		}
		parts = append(parts, func(s string) bool {
			for _, re := range regs {
				if re.MatchString(s) {
					return true
				}
			}
			return false
		})
	}
	if rs := asStringSlice(g.LineRegex); len(rs) > 0 {
		regs, err := compileRegexes(rs)
		if err != nil {
			return nil, err
		}
		parts = append(parts, func(s string) bool {
			for _, line := range strings.Split(s, "\n") {
				for _, re := range regs {
					if re.MatchString(line) {
						return true
					}
				}
			}
			return false
		})
	}
	if len(g.Any) > 0 {
		inner, err := compileGates(g.Any)
		if err != nil {
			return nil, err
		}
		parts = append(parts, func(s string) bool {
			for _, f := range inner {
				if f(s) {
					return true
				}
			}
			return false
		})
	}
	if len(g.All) > 0 {
		inner, err := compileGates(g.All)
		if err != nil {
			return nil, err
		}
		parts = append(parts, func(s string) bool {
			for _, f := range inner {
				if !f(s) {
					return false
				}
			}
			return true
		})
	}
	if len(g.Not) > 0 {
		inner, err := compileGates(g.Not)
		if err != nil {
			return nil, err
		}
		parts = append(parts, func(s string) bool {
			for _, f := range inner {
				if f(s) {
					return false
				}
			}
			return true
		})
	}
	if len(parts) == 0 {
		return func(string) bool { return true }, nil
	}
	return func(s string) bool {
		for _, p := range parts {
			if !p(s) {
				return false
			}
		}
		return true
	}, nil
}

func asStringSlice(v any) []string {
	switch t := v.(type) {
	case nil:
		return nil
	case string:
		if t == "" {
			return nil
		}
		return []string{t}
	case []string:
		return t
	case []any:
		out := make([]string, 0, len(t))
		for _, x := range t {
			if s, ok := x.(string); ok {
				out = append(out, s)
			}
		}
		return out
	default:
		return nil
	}
}

func compileRegexes(patterns []string) ([]*regexp.Regexp, error) {
	out := make([]*regexp.Regexp, 0, len(patterns))
	for _, p := range patterns {
		// Normalize a few Rust-regex-isms that appear in Herdr manifests.
		p = normalizeRegex(p)
		re, err := regexp.Compile("(?m)" + p)
		if err != nil {
			continue
		}
		out = append(out, re)
	}
	if len(out) == 0 && len(patterns) > 0 {
		return nil, fmt.Errorf("no valid regex among %v", patterns)
	}
	return out, nil
}

func normalizeRegex(p string) string {
	// \x{2800}-\x{28FF} braille → Go \x{2800}
	// \p{Alphabetic} not in RE2 — drop class to \w
	p = strings.ReplaceAll(p, `\p{Alphabetic}`, `\w`)
	// Herdr \x{HHHH} is already valid in Go RE2
	return p
}

func regionExtract(region string, in Input) string {
	r := strings.TrimSpace(region)
	switch {
	case r == "osc_title":
		return in.OSCTitle
	case r == "osc_progress":
		return in.OSCProgress
	case r == "whole_recent", r == "", r == "whole":
		return in.Screen
	case strings.HasPrefix(r, "bottom_non_empty_lines("):
		n := parseParenInt(r, 5)
		return bottomNonEmpty(in.Screen, n)
	case r == "after_last_horizontal_rule":
		return afterLastHR(in.Screen)
	case r == "after_last_prompt_marker":
		return afterLastPrompt(in.Screen)
	case r == "prompt_box_body":
		return bottomNonEmpty(in.Screen, 8)
	default:
		return in.Screen
	}
}

func parseParenInt(s string, def int) int {
	i := strings.IndexByte(s, '(')
	j := strings.IndexByte(s, ')')
	if i < 0 || j <= i {
		return def
	}
	var n int
	_, err := fmt.Sscanf(s[i+1:j], "%d", &n)
	if err != nil || n <= 0 {
		return def
	}
	return n
}

func bottomNonEmpty(screen string, n int) string {
	lines := strings.Split(screen, "\n")
	var nonEmpty []string
	for _, l := range lines {
		if strings.TrimSpace(l) != "" {
			nonEmpty = append(nonEmpty, l)
		}
	}
	if len(nonEmpty) > n {
		nonEmpty = nonEmpty[len(nonEmpty)-n:]
	}
	return strings.Join(nonEmpty, "\n")
}

func afterLastHR(screen string) string {
	// horizontal rules often ─── or ---
	idx := strings.LastIndex(screen, "──")
	if idx < 0 {
		idx = strings.LastIndex(screen, "---")
	}
	if idx < 0 {
		return screen
	}
	return screen[idx:]
}

func afterLastPrompt(screen string) string {
	markers := []string{"❯", "›", "> "}
	last := -1
	for _, m := range markers {
		if i := strings.LastIndex(screen, m); i > last {
			last = i
		}
	}
	if last < 0 {
		return screen
	}
	return screen[last:]
}

// EnabledFromEnv reports whether screendetect should apply.
// Default is ON when env is unset/empty (product default after fixture gate).
// Explicit kill-switch: 0, false, off, no, disable, disabled.
// Explicit enable: 1, true, on, yes (same as default).
func EnabledFromEnv(env string) bool {
	switch strings.ToLower(strings.TrimSpace(env)) {
	case "0", "false", "off", "no", "disable", "disabled":
		return false
	default:
		// empty and all other values enable (default-on)
		return true
	}
}
