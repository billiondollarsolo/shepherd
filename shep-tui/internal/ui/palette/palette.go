// Package palette is a pure fuzzy command palette model (no Bubble Tea).
//
// Matching is case-insensitive and scored in bands: prefix hits beat substring
// hits, which beat subsequence ("fuzzy") hits, so ranking stays predictable
// while "gc" still finds "Git commit". Cursor navigation and selection are
// independent of any Run callbacks (optional for tests).
package palette

import (
	"sort"
	"strings"
)

// Command is one palette entry.
type Command struct {
	ID    string
	Title string
	Group string
	// Run is optional; palette model never invokes it — callers do after Selected().
	Run func()
}

// Palette holds query, items, filtered results, and cursor.
type Palette struct {
	Query    string
	Items    []Command
	Filtered []Command
	Cursor   int
}

// New returns an empty palette.
func New() *Palette {
	return &Palette{}
}

// SetItems replaces the command list and re-filters with the current query.
func (p *Palette) SetItems(items []Command) {
	p.Items = append([]Command(nil), items...)
	p.Filter(p.Query)
}

// Filter applies query against Items and rebuilds Filtered + clamps cursor.
// Empty query shows all items in original order (stable).
func (p *Palette) Filter(query string) {
	p.Query = query
	if len(p.Items) == 0 {
		p.Filtered = nil
		p.Cursor = 0
		return
	}
	if strings.TrimSpace(query) == "" {
		p.Filtered = append([]Command(nil), p.Items...)
		p.clampCursor()
		return
	}

	type scored struct {
		cmd   Command
		score int
		idx   int // original index for stable tie-break
	}
	q := strings.ToLower(query)
	var hits []scored
	for i, cmd := range p.Items {
		s := matchScore(cmd, q)
		if s < 0 {
			continue
		}
		hits = append(hits, scored{cmd: cmd, score: s, idx: i})
	}
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].score != hits[j].score {
			return hits[i].score > hits[j].score // higher better
		}
		return hits[i].idx < hits[j].idx
	})
	p.Filtered = make([]Command, len(hits))
	for i, h := range hits {
		p.Filtered[i] = h.cmd
	}
	p.clampCursor()
}

// matchScore returns a non-negative score if cmd matches q (lowercased query),
// or -1 if no match.
//
// Scoring (higher = better):
//   - exact title prefix: 300 + leftover bonus
//   - exact id prefix: 250
//   - title substring: 100 + position bonus (earlier better)
//   - id substring: 80
//   - group substring: 40
//   - title subsequence: 20 + match quality (word starts, streaks)
//   - id subsequence: 10 + match quality
func matchScore(cmd Command, q string) int {
	title := strings.ToLower(cmd.Title)
	id := strings.ToLower(cmd.ID)
	group := strings.ToLower(cmd.Group)

	best := -1
	if strings.HasPrefix(title, q) {
		// Prefer shorter remaining tail (tighter match).
		best = max(best, 300+(100-min(100, len(title)-len(q))))
	}
	if strings.HasPrefix(id, q) {
		best = max(best, 250+(100-min(100, len(id)-len(q))))
	}
	if i := strings.Index(title, q); i >= 0 {
		// Earlier occurrence scores higher.
		best = max(best, 100+(50-min(50, i)))
	}
	if i := strings.Index(id, q); i >= 0 {
		best = max(best, 80+(40-min(40, i)))
	}
	if strings.Contains(group, q) {
		best = max(best, 40)
	}
	if best >= 0 {
		return best
	}
	// Subsequence tiers sit below every substring band, so adding them cannot
	// re-rank the hits the substring bands already found.
	if s, ok := subsequenceScore(title, q); ok {
		best = max(best, 20+s)
	}
	if s, ok := subsequenceScore(id, q); ok {
		best = max(best, 10+s)
	}
	return best
}

// subsequenceScore matches q's runes in order anywhere in s ("gc" → "Git
// commit"), rewarding runes that land on a word boundary or continue a streak.
// The score is capped below the width of one band so tiers never overlap.
func subsequenceScore(s, q string) (int, bool) {
	if q == "" {
		return 0, false
	}
	src := []rune(s)
	score := 0
	i := 0
	prevMatched := false
	for _, qr := range q {
		found := false
		for ; i < len(src); i++ {
			if src[i] != qr {
				prevMatched = false
				continue
			}
			switch {
			case i == 0 || isWordBreak(src[i-1]):
				score += 3
			case prevMatched:
				score += 2
			default:
				score++
			}
			prevMatched = true
			found = true
			i++
			break
		}
		if !found {
			return 0, false
		}
	}
	return min(score, 9), true
}

func isWordBreak(r rune) bool {
	switch r {
	case ' ', '-', '_', ':', '/', '.', '·':
		return true
	}
	return false
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func (p *Palette) clampCursor() {
	if len(p.Filtered) == 0 {
		p.Cursor = 0
		return
	}
	if p.Cursor < 0 {
		p.Cursor = 0
	}
	if p.Cursor >= len(p.Filtered) {
		p.Cursor = len(p.Filtered) - 1
	}
}

// Move shifts the selection by delta (negative = up). Clamped.
func (p *Palette) Move(delta int) {
	if len(p.Filtered) == 0 {
		p.Cursor = 0
		return
	}
	p.Cursor += delta
	p.clampCursor()
}

// Selected returns the command under the cursor.
func (p *Palette) Selected() (Command, bool) {
	if len(p.Filtered) == 0 || p.Cursor < 0 || p.Cursor >= len(p.Filtered) {
		return Command{}, false
	}
	return p.Filtered[p.Cursor], true
}
