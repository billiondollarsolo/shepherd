// Statusline messages: leveled, and they go away on their own.
package app

import (
	"fmt"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// toastLevel separates "theme: flock-light" from "spawn: connection refused".
type toastLevel int

const (
	toastInfo toastLevel = iota
	toastOK
	toastErr
)

// ttl is how long the message stays up. A failure is worth re-reading; an
// acknowledgement is not.
func (l toastLevel) ttl() time.Duration {
	if l == toastErr {
		return 6 * time.Second
	}
	return 3 * time.Second
}

// toast is the ephemeral statusline message. seq is bumped on every set, so the
// expiry timer of a message that has since been replaced is ignored.
type toast struct {
	text  string
	level toastLevel
	seq   int
}

// toastExpiredMsg dismisses the toast raised under seq.
type toastExpiredMsg struct{ seq int }

func (m *Model) notify(text string)    { m.setToast(text, toastInfo) }
func (m *Model) notifyOK(text string)  { m.setToast(text, toastOK) }
func (m *Model) notifyErr(text string) { m.setToast(text, toastErr) }

func (m *Model) notifyErrf(format string, a ...any) {
	m.setToast(fmt.Sprintf(format, a...), toastErr)
}

func (m *Model) setToast(text string, level toastLevel) {
	m.toast.seq++
	m.toast.text = text
	m.toast.level = level
}

// clearToast dismisses the message on demand (esc).
func (m *Model) clearToast() {
	m.toast.seq++
	m.toast.text = ""
	m.toast.level = toastInfo
}

// toastExpiryCmd schedules the dismissal of a message raised during this update.
// Update is its only caller: a handler that had to remember to return the timer
// itself is a handler that will one day leave a message on screen forever.
func (m Model) toastExpiryCmd(beforeSeq int) tea.Cmd {
	if m.toast.seq == beforeSeq || m.toast.text == "" {
		return nil
	}
	seq := m.toast.seq
	ttl := m.toast.level.ttl()
	return tea.Tick(ttl, func(time.Time) tea.Msg { return toastExpiredMsg{seq: seq} })
}

func (m Model) toastView() string {
	if m.toast.text == "" {
		return ""
	}
	th := m.th()
	switch m.toast.level {
	case toastErr:
		return lipgloss.NewStyle().Foreground(th.Error).Bold(true).Render("✗ " + m.toast.text)
	case toastOK:
		return lipgloss.NewStyle().Foreground(th.Idle).Render("✓ " + m.toast.text)
	}
	return m.toast.text
}
