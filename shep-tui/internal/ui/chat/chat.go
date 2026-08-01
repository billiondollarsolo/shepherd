// Package chat projects agent events into a simple timeline panel.
package chat

import (
	"fmt"
	"strings"
	"time"
)

// Known event kinds for the dual-surface chat panel.
const (
	KindAssistant = "assistant"
	KindUser      = "user"
	KindTool      = "tool"
	KindPlan      = "plan"
	KindSystem    = "system"
)

// Event is one projected chat/timeline item.
type Event struct {
	Kind string // assistant|user|tool|plan|system
	Text string
	At   time.Time
}

// Panel holds ordered events and a scroll offset (lines from the bottom).
// Scroll == 0 means stick to the latest events; positive Scroll peeks upward.
type Panel struct {
	Events []Event
	Scroll int
}

// Append adds an event to the timeline.
func (p *Panel) Append(e Event) {
	p.Events = append(p.Events, e)
}

// Clear removes all events and resets scroll.
func (p *Panel) Clear() {
	p.Events = nil
	p.Scroll = 0
}

// Lines returns up to max formatted timeline lines for display.
// When max <= 0, all lines are returned (subject to scroll window).
// Format: "[kind] text" (text may itself contain newlines → multiple lines).
func (p *Panel) Lines(max int) []string {
	all := make([]string, 0, len(p.Events))
	for _, e := range p.Events {
		kind := e.Kind
		if kind == "" {
			kind = KindSystem
		}
		text := e.Text
		if text == "" {
			all = append(all, fmt.Sprintf("[%s]", kind))
			continue
		}
		parts := strings.Split(text, "\n")
		for i, part := range parts {
			if i == 0 {
				all = append(all, fmt.Sprintf("[%s] %s", kind, part))
			} else {
				// Continuations keep visual alignment under the kind tag.
				all = append(all, "  "+part)
			}
		}
	}

	if len(all) == 0 {
		return nil
	}

	// Window from the bottom; Scroll peeks upward and is clamped.
	window := len(all)
	if max > 0 && max < window {
		window = max
	}
	maxScroll := len(all) - window
	if maxScroll < 0 {
		maxScroll = 0
	}
	scroll := p.Scroll
	if scroll < 0 {
		scroll = 0
	}
	if scroll > maxScroll {
		scroll = maxScroll
	}
	end := len(all) - scroll
	start := end - window
	if start < 0 {
		start = 0
	}
	out := make([]string, end-start)
	copy(out, all[start:end])
	return out
}
