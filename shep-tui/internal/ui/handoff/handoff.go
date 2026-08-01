// Package handoff builds bootstrap context text for agent handoffs.
package handoff

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// BuildBootstrap produces a handoff prompt for a follow-on agent.
//
// fromAgent is the source agent/session label; summary is a short mission
// summary; lastN are recent transcript/log lines (oldest first). When the
// full text exceeds maxRunes (runes, not bytes), the lastN section is
// truncated from the oldest side and a marker is inserted. maxRunes <= 0
// means no limit.
func BuildBootstrap(fromAgent, summary string, lastN []string, maxRunes int) string {
	var b strings.Builder
	b.WriteString("## Agent handoff\n")
	if fromAgent != "" {
		b.WriteString(fmt.Sprintf("From: %s\n", fromAgent))
	}
	if summary != "" {
		b.WriteString(fmt.Sprintf("Summary: %s\n", summary))
	}
	if len(lastN) > 0 {
		b.WriteString("\n### Recent context\n")
		for _, line := range lastN {
			b.WriteString(line)
			if !strings.HasSuffix(line, "\n") {
				b.WriteByte('\n')
			}
		}
	}
	out := b.String()
	if maxRunes <= 0 || utf8.RuneCountInString(out) <= maxRunes {
		return out
	}
	return truncateRunes(out, maxRunes)
}

func truncateRunes(s string, max int) string {
	if max <= 0 {
		return ""
	}
	const marker = "\n…[truncated]…\n"
	markerRunes := utf8.RuneCountInString(marker)
	if max <= markerRunes {
		// Degenerate: just hard-cut the head of s.
		return string([]rune(s)[:max])
	}

	// Prefer keeping the head (handoff header + summary) and tail of context.
	rs := []rune(s)
	if len(rs) <= max {
		return s
	}

	// Keep prefix and suffix; drop middle.
	// Budget: prefix + marker + suffix = max
	keep := max - markerRunes
	// Weight prefix slightly more so "From/Summary" survive when possible.
	prefixN := keep * 2 / 3
	if prefixN < 1 {
		prefixN = 1
	}
	suffixN := keep - prefixN
	if suffixN < 1 {
		suffixN = 1
		prefixN = keep - 1
	}
	if prefixN+suffixN > keep {
		suffixN = keep - prefixN
	}
	prefix := string(rs[:prefixN])
	suffix := string(rs[len(rs)-suffixN:])
	return prefix + marker + suffix
}
