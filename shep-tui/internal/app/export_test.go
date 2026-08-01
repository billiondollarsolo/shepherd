package app

import "github.com/billiondollarsolo/shep-tui/internal/domain"

// Test helpers — exercise newModel seed path without starting Bubble Tea.

// NewModelForTest builds a Model via the shipped newModel path.
func NewModelForTest(opts Options) Model {
	return newModel(opts)
}

func (m Model) NPanes() int { return m.nPanes }

func (m Model) SessionCount() int { return len(m.sessions) }

// PenSessionIDs is the pen's membership as the panes hold it — every slot, not
// only the ones the stage is currently showing.
func (m Model) PenSessionIDs() []string {
	out := make([]string, 0, domain.MaxPenSessions)
	for i := 0; i < domain.MaxPenSessions; i++ {
		if m.panes[i].SessionID != "" {
			out = append(out, m.panes[i].SessionID)
		}
	}
	return out
}

func (m Model) CapsMode() string    { return m.caps.Mode }
func (m Model) ProfileName() string { return m.profile }
func (m Model) PensPath() string    { return m.pensPath }

// SavePensForTest forces pen save (same path as quit).
func (m *Model) SavePensForTest() { m.savePensIfConfigured() }
