// Package keybinds is the single source of truth for shep-tui key bindings.
//
// The app derives its bubbles/key map and its chord engine from a Map, help and
// docs are generated from the same Map, and users rebind through keybinds.toml.
// Nothing in the TUI may hardcode a key that is not here.
//
// Default() always binds DetachChord to ["ctrl+g", "g"]; Sanitize restores it if
// a rebind file drops it, because detach must always work (PRODUCT.md §2).
package keybinds

import (
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/BurntSushi/toml"
)

// Action is a named host/chrome action.
type Action string

const (
	ActionFocusNext    Action = "FocusNext"
	ActionFocusPrev    Action = "FocusPrev"
	ActionFocusPane1   Action = "FocusPane1"
	ActionFocusPane2   Action = "FocusPane2"
	ActionFocusPane3   Action = "FocusPane3"
	ActionFocusPane4   Action = "FocusPane4"
	ActionEnterInput   Action = "EnterInput"
	ActionActivate     Action = "Activate"
	ActionEsc          Action = "Esc"
	ActionQuit         Action = "Quit"
	ActionPalette      Action = "Palette"
	ActionLaunch       Action = "Launch"
	ActionRespond      Action = "Respond"
	ActionActions      Action = "Actions"
	ActionRename       Action = "Rename"
	ActionKill         Action = "Kill"
	ActionHelp         Action = "Help"
	ActionZen          Action = "Zen"
	ActionPens         Action = "Pens"
	ActionNodes        Action = "Nodes"
	ActionFilter       Action = "Filter"
	ActionShellDrawer  Action = "ShellDrawer"
	ActionFocusShell   Action = "FocusShell"
	ActionTreeUp       Action = "TreeUp"
	ActionTreeDown     Action = "TreeDown"
	ActionRegionPrev   Action = "RegionPrev"
	ActionRegionNext   Action = "RegionNext"
	ActionScrollUp     Action = "ScrollUp"
	ActionScrollDown   Action = "ScrollDown"
	ActionScrollTop    Action = "ScrollTop"
	ActionScrollBottom Action = "ScrollBottom"
	ActionRetry        Action = "Retry"
	ActionReconnect    Action = "Reconnect"
	ActionDetachChord  Action = "DetachChord"
	ActionDetachTmux   Action = "DetachTmux" // optional alt chord (tmux preset)
)

// allActions is the resolution order. Lookup and Resolve must iterate it and
// never the map: Go randomizes map iteration, so two actions sharing a sequence
// would resolve to a different action on every press.
var allActions = []Action{
	ActionFocusNext,
	ActionFocusPrev,
	ActionFocusPane1,
	ActionFocusPane2,
	ActionFocusPane3,
	ActionFocusPane4,
	ActionEnterInput,
	ActionActivate,
	ActionEsc,
	ActionQuit,
	ActionPalette,
	ActionLaunch,
	ActionRespond,
	ActionActions,
	ActionRename,
	ActionKill,
	ActionHelp,
	ActionZen,
	ActionPens,
	ActionNodes,
	ActionFilter,
	ActionShellDrawer,
	ActionFocusShell,
	ActionTreeUp,
	ActionTreeDown,
	ActionRegionPrev,
	ActionRegionNext,
	ActionScrollUp,
	ActionScrollDown,
	ActionScrollTop,
	ActionScrollBottom,
	ActionRetry,
	ActionReconnect,
	ActionDetachChord,
	ActionDetachTmux,
}

// Actions returns every known action in resolution order.
func Actions() []Action {
	return append([]Action(nil), allActions...)
}

var descriptions = map[Action]string{
	ActionFocusNext:    "next pane",
	ActionFocusPrev:    "prev pane",
	ActionFocusPane1:   "focus pane 1",
	ActionFocusPane2:   "focus pane 2",
	ActionFocusPane3:   "focus pane 3",
	ActionFocusPane4:   "focus pane 4",
	ActionEnterInput:   "PTY input mode",
	ActionActivate:     "select / activate",
	ActionEsc:          "close overlay / back",
	ActionQuit:         "quit",
	ActionPalette:      "command palette",
	ActionLaunch:       "launch agent",
	ActionRespond:      "respond bar",
	ActionActions:      "session actions",
	ActionRename:       "rename session",
	ActionKill:         "kill session",
	ActionHelp:         "help",
	ActionZen:          "zen maximize pane",
	ActionPens:         "pens (multi-pane grid)",
	ActionNodes:        "nodes (scope agents)",
	ActionFilter:       "filter the table",
	ActionShellDrawer:  "shell drawer",
	ActionFocusShell:   "focus shell drawer",
	ActionTreeUp:       "up · pane above",
	ActionTreeDown:     "down · pane below",
	ActionRegionPrev:   "pane left · prev region",
	ActionRegionNext:   "pane right · next region",
	ActionScrollUp:     "scroll up",
	ActionScrollDown:   "scroll down",
	ActionScrollTop:    "scroll to top",
	ActionScrollBottom: "scroll to bottom",
	ActionRetry:        "retry attach",
	ActionReconnect:    "reconnect backend",
	ActionDetachChord:  "detach from agent PTY",
	ActionDetachTmux:   "detach (tmux alternate)",
}

// Description is the help text for an action.
func Description(a Action) string {
	return descriptions[a]
}

// Map maps actions to their alternate key sequences.
//
// Each inner slice is one sequence: a single key ({"tab"}) or an ordered chord
// ({"ctrl+g", "g"}). The outer slice holds alternates, so Quit can be q *or*
// ctrl+c without either one shadowing the other.
type Map map[Action][][]string

// Default is the product default chrome map (docs/KEYBINDS.md is generated from it).
//
// ShellDrawer carries a chord alternate because ctrl+j is LF: in PTY input mode
// that key belongs to the agent, so the chord is the only shell-drawer bind that
// surface may intercept.
func Default() Map {
	return Map{
		ActionFocusNext:    {{"tab"}},
		ActionFocusPrev:    {{"shift+tab"}},
		ActionFocusPane1:   {{"1"}},
		ActionFocusPane2:   {{"2"}},
		ActionFocusPane3:   {{"3"}},
		ActionFocusPane4:   {{"4"}},
		ActionEnterInput:   {{"i"}},
		ActionActivate:     {{"enter"}},
		ActionEsc:          {{"esc"}},
		ActionQuit:         {{"q"}, {"ctrl+c"}},
		ActionPalette:      {{"ctrl+k"}},
		ActionLaunch:       {{"n"}},
		ActionRespond:      {{"R"}},
		ActionActions:      {{"a"}},
		ActionRename:       {{"r"}},
		ActionKill:         {{"x"}},
		ActionHelp:         {{"?"}},
		ActionZen:          {{"z"}},
		ActionPens:         {{"p"}},
		ActionNodes:        {{"N"}},
		ActionFilter:       {{"/"}},
		ActionShellDrawer:  {{"ctrl+j"}, {"ctrl+g", "j"}},
		ActionFocusShell:   {{"s"}},
		ActionTreeUp:       {{"k"}, {"up"}},
		ActionTreeDown:     {{"j"}, {"down"}},
		ActionRegionPrev:   {{"h"}, {"left"}, {"["}},
		ActionRegionNext:   {{"l"}, {"right"}, {"]"}},
		ActionScrollUp:     {{"pgup"}, {"ctrl+u"}},
		ActionScrollDown:   {{"pgdown"}, {"ctrl+d"}},
		ActionScrollTop:    {{"g", "g"}},
		ActionScrollBottom: {{"G"}},
		ActionRetry:        {{"t"}},
		ActionReconnect:    {{"ctrl+r"}},
		ActionDetachChord:  {{"ctrl+g", "g"}},
	}
}

// Vim leans on ctrl+w window chords and keeps detach as ctrl+g, g.
func Vim() Map {
	m := Default()
	m[ActionFocusNext] = [][]string{{"ctrl+w", "w"}}
	// Not ctrl+w W: shift-chords are awkward to type and easy to mis-normalize.
	m[ActionFocusPrev] = [][]string{{"ctrl+w", "p"}}
	m[ActionPalette] = [][]string{{":"}, {"ctrl+k"}}
	return m
}

// Tmux uses a ctrl+b prefix while still listing the product DetachChord.
func Tmux() Map {
	m := Default()
	m[ActionFocusNext] = [][]string{{"ctrl+b", "n"}}
	m[ActionFocusPrev] = [][]string{{"ctrl+b", "p"}}
	m[ActionPalette] = [][]string{{"ctrl+b", ":"}, {"ctrl+k"}}
	m[ActionDetachTmux] = [][]string{{"ctrl+b", "d"}}
	return m
}

// Preset returns a named base map ("vim" / "tmux"); anything else is Default.
func Preset(name string) Map {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "vim":
		return Vim()
	case "tmux":
		return Tmux()
	default:
		return Default()
	}
}

// Sequences returns every sequence bound to action.
func (m Map) Sequences(action Action) [][]string {
	if m == nil {
		return nil
	}
	out := make([][]string, 0, len(m[action]))
	for _, seq := range m[action] {
		out = append(out, append([]string(nil), seq...))
	}
	return out
}

// Sequence returns the primary (first) sequence bound to action, or nil.
func (m Map) Sequence(action Action) []string {
	seqs := m.Sequences(action)
	if len(seqs) == 0 {
		return nil
	}
	return seqs[0]
}

// Resolve matches a complete key sequence (chord) against every action.
func (m Map) Resolve(keys []string) (Action, bool) {
	return m.ResolveIn(keys, allActions...)
}

// ResolveIn matches a complete key sequence against actions only. Surfaces that
// must not swallow chrome chords (PTY input mode) resolve against a subset.
func (m Map) ResolveIn(keys []string, actions ...Action) (Action, bool) {
	norm := normalizeSeq(keys)
	if m == nil || len(norm) == 0 {
		return "", false
	}
	for _, action := range actions {
		for _, seq := range m[action] {
			if seqEqual(normalizeSeq(seq), norm) {
				return action, true
			}
		}
	}
	return "", false
}

// IsPrefix reports whether keys is a strict prefix of some bound sequence, i.e.
// whether one more key could complete a chord.
func (m Map) IsPrefix(keys []string) bool {
	return m.PrefixOf(keys, allActions...)
}

// PrefixOf reports whether keys is a strict prefix of a sequence bound to one
// of actions.
func (m Map) PrefixOf(keys []string, actions ...Action) bool {
	norm := normalizeSeq(keys)
	if m == nil || len(norm) == 0 {
		return false
	}
	for _, action := range actions {
		for _, seq := range m[action] {
			if len(seq) <= len(norm) {
				continue
			}
			if seqEqual(normalizeSeq(seq[:len(norm)]), norm) {
				return true
			}
		}
	}
	return false
}

// Merge returns a copy of base with over entries replacing/adding actions.
// Empty override sequences remove the action from the result.
func Merge(base, over Map) Map {
	out := make(Map, len(base)+len(over))
	for k, v := range base {
		out[k] = cloneSeqs(v)
	}
	for k, v := range over {
		if len(v) == 0 {
			delete(out, k)
			continue
		}
		out[k] = cloneSeqs(v)
	}
	return out
}

// Validate reports every problem in the map: unknown actions, empty or
// structurally invalid sequences, and the same chord bound to two actions.
// A conflicting map is never silently accepted — it would resolve differently
// on every press.
func (m Map) Validate() []error {
	var errs []error
	seen := map[string]Action{}
	known := map[Action]bool{}
	for _, a := range allActions {
		known[a] = true
	}

	unknown := make([]string, 0)
	for action := range m {
		if !known[action] {
			unknown = append(unknown, string(action))
		}
	}
	sort.Strings(unknown)
	for _, name := range unknown {
		errs = append(errs, fmt.Errorf("unknown action %q", name))
	}

	for _, action := range allActions {
		seqs, ok := m[action]
		if !ok {
			continue
		}
		if len(seqs) == 0 {
			errs = append(errs, fmt.Errorf("%s: no key sequence", action))
			continue
		}
		for _, seq := range seqs {
			if len(seq) == 0 {
				errs = append(errs, fmt.Errorf("%s: empty key sequence", action))
				continue
			}
			bad := false
			for _, k := range seq {
				if !validKey(k) {
					errs = append(errs, fmt.Errorf("%s: invalid key %q", action, k))
					bad = true
				}
			}
			if bad {
				continue
			}
			id := strings.Join(normalizeSeq(seq), " ")
			if other, dup := seen[id]; dup {
				errs = append(errs, fmt.Errorf("%s: %q already bound to %s", action, FormatChord(seq), other))
				continue
			}
			seen[id] = action
		}
	}
	return errs
}

// Sanitize force-restores the detach chord: a user who unbinds it would have no
// way back out of a full-screen agent.
func (m Map) Sanitize() {
	if m == nil {
		return
	}
	if len(m[ActionDetachChord]) == 0 {
		m[ActionDetachChord] = [][]string{{"ctrl+g", "g"}}
	}
}

// fileRoot is the TOML shape for LoadTOML.
//
// Example:
//
//	preset = "vim"
//
//	[keybinds]
//	Quit = ["x"]                    # one sequence
//	Palette = [["ctrl+k"], ["/"]]   # alternates
//	DetachChord = ["ctrl+g", "g"]   # a chord
type fileRoot struct {
	Preset   string         `toml:"preset"`
	Keybinds map[string]any `toml:"keybinds"`
	Binds    map[string]any `toml:"binds"`
}

// LoadTOML merges keybind overrides from path over base (nil base = Default).
// A missing file is not an error — it is the common case.
func LoadTOML(path string, base Map) (Map, error) {
	if base == nil {
		base = Default()
	}
	if path == "" {
		return base, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return base, nil
		}
		return nil, err
	}
	var root fileRoot
	if err := toml.Unmarshal(data, &root); err != nil {
		return nil, fmt.Errorf("keybinds toml: %w", err)
	}
	if root.Preset != "" {
		base = Preset(root.Preset)
	}
	over := make(Map)
	for _, src := range []map[string]any{root.Keybinds, root.Binds} {
		for name, raw := range src {
			seqs, err := toSequences(raw)
			if err != nil {
				return nil, fmt.Errorf("keybinds toml: %s: %w", name, err)
			}
			over[Action(name)] = seqs
		}
	}
	out := Merge(base, over)
	out.Sanitize()
	if errs := out.Validate(); len(errs) > 0 {
		msgs := make([]string, len(errs))
		for i, e := range errs {
			msgs[i] = e.Error()
		}
		return nil, fmt.Errorf("keybinds %s: %s", path, strings.Join(msgs, "; "))
	}
	return out, nil
}

// toSequences accepts both TOML shapes: a flat array of keys is one sequence,
// an array of arrays is a list of alternates.
func toSequences(raw any) ([][]string, error) {
	arr, ok := raw.([]any)
	if !ok {
		return nil, fmt.Errorf("want an array of keys")
	}
	var flat []string
	var seqs [][]string
	for _, elem := range arr {
		switch v := elem.(type) {
		case string:
			flat = append(flat, v)
		case []any:
			seq := make([]string, 0, len(v))
			for _, k := range v {
				s, ok := k.(string)
				if !ok {
					return nil, fmt.Errorf("want a key string, got %T", k)
				}
				seq = append(seq, s)
			}
			seqs = append(seqs, seq)
		default:
			return nil, fmt.Errorf("want a key string or a sequence, got %T", elem)
		}
	}
	if len(flat) > 0 && len(seqs) > 0 {
		return nil, fmt.Errorf("mixes keys and sequences")
	}
	if len(flat) > 0 {
		return [][]string{flat}, nil
	}
	return seqs, nil
}

// FormatChord joins one sequence for help text ("ctrl+g then g").
func FormatChord(seq []string) string {
	if len(seq) == 0 {
		return ""
	}
	if len(seq) == 1 {
		return seq[0]
	}
	return strings.Join(seq, " then ")
}

// FormatSequences joins alternates for help text ("q / ctrl+c").
func FormatSequences(seqs [][]string) string {
	out := make([]string, 0, len(seqs))
	for _, seq := range seqs {
		if s := FormatChord(seq); s != "" {
			out = append(out, s)
		}
	}
	return strings.Join(out, " / ")
}

// MarkdownTable renders actions as the docs keybind table. docs/KEYBINDS.md is
// generated from this, so a rebind can never drift from what ships.
func MarkdownTable(m Map, actions []Action) string {
	var b strings.Builder
	b.WriteString("| Bind | Action |\n| --- | --- |\n")
	for _, a := range actions {
		seqs := m.Sequences(a)
		if len(seqs) == 0 {
			continue
		}
		chords := make([]string, 0, len(seqs))
		for _, seq := range seqs {
			chords = append(chords, "`"+FormatChord(seq)+"`")
		}
		b.WriteString("| " + strings.Join(chords, " / ") + " | " + Description(a) + " |\n")
	}
	return b.String()
}

func cloneSeqs(seqs [][]string) [][]string {
	out := make([][]string, 0, len(seqs))
	for _, seq := range seqs {
		out = append(out, append([]string(nil), seq...))
	}
	return out
}

func seqEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func normalizeSeq(seq []string) []string {
	out := make([]string, 0, len(seq))
	for _, k := range seq {
		n := normalizeKey(k)
		if n == "" {
			return nil
		}
		out = append(out, n)
	}
	return out
}

func validKey(k string) bool {
	n := normalizeKey(k)
	if n == "" {
		return false
	}
	return !strings.HasPrefix(n, "+") && !strings.HasSuffix(n, "+")
}

func normalizeKey(k string) string {
	k = strings.ReplaceAll(strings.TrimSpace(k), " ", "")
	if len([]rune(k)) == 1 {
		// A bare rune keeps its case: "R" (respond) and "r" (retry) are
		// different keys, and lowercasing them collides two actions.
		return k
	}
	k = strings.ToLower(k)
	// Accept both "ctrl+g" and "ctrl-g".
	k = strings.ReplaceAll(k, "ctrl-", "ctrl+")
	k = strings.ReplaceAll(k, "shift-", "shift+")
	k = strings.ReplaceAll(k, "alt-", "alt+")
	return k
}
