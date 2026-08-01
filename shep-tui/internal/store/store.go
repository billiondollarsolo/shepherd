// Package store holds pure session + pen state for the paddock (no Bubble Tea).
//
// The store is the single in-memory source of truth for the session snapshot,
// pen membership (max 4), active pen per project and session aliases. Pens
// persist to a JSON file for local restarts.
package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/config"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
)

// ErrPenNotFound is returned when a penID is unknown.
var ErrPenNotFound = errors.New("pen not found")

// Store is session + pen state for the paddock.
type Store struct {
	mu sync.RWMutex

	// sessions keyed by ID; order for Sessions() is sorted by ID for stability.
	sessions map[string]domain.Session

	// pens keyed by pen ID.
	pens map[string]domain.Pen

	// activePen: projectID → penID.
	activePen map[string]string

	// aliases: sessionID → display name chosen on this client. agentd has no
	// rename op, so an alias never leaves this machine.
	aliases map[string]string
}

// pensFile is the on-disk JSON shape for SavePens / LoadPens.
type pensFile struct {
	Pens   []penJSON         `json:"pens"`
	Active map[string]string `json:"active"` // projectID → penID
}

// aliasFile is the on-disk JSON shape for SaveAliases / LoadAliases.
type aliasFile struct {
	Aliases map[string]string `json:"aliases"` // sessionID → display name
}

type penJSON struct {
	ID         string   `json:"id"`
	ProjectID  string   `json:"project_id"`
	Name       string   `json:"name"`
	Layout     string   `json:"layout"`
	SessionIDs []string `json:"session_ids"`
}

// New returns an empty store.
func New() *Store {
	return &Store{
		sessions:  make(map[string]domain.Session),
		pens:      make(map[string]domain.Pen),
		activePen: make(map[string]string),
		aliases:   make(map[string]string),
	}
}

// SetAlias sets the display name for a session; an empty name clears it.
func (s *Store) SetAlias(sessionID, name string) {
	if sessionID == "" {
		return
	}
	name = strings.TrimSpace(name)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.aliases == nil {
		s.aliases = make(map[string]string)
	}
	if name == "" {
		delete(s.aliases, sessionID)
		return
	}
	s.aliases[sessionID] = name
}

// Aliases returns a copy of sessionID → display name.
func (s *Store) Aliases() map[string]string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]string, len(s.aliases))
	for k, v := range s.aliases {
		out[k] = v
	}
	return out
}

// SaveAliases writes the alias map to path as JSON.
func (s *Store) SaveAliases(path string) error {
	data, err := json.MarshalIndent(aliasFile{Aliases: s.Aliases()}, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return config.WriteFileAtomic(path, data, 0o600)
}

// LoadAliases replaces the alias map from a file written by SaveAliases.
// Missing file returns nil (no aliases). Malformed JSON returns an error.
func (s *Store) LoadAliases(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var af aliasFile
	if err := json.Unmarshal(data, &af); err != nil {
		return fmt.Errorf("load aliases: %w", err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.aliases = make(map[string]string, len(af.Aliases))
	for id, name := range af.Aliases {
		if id == "" || name == "" {
			continue
		}
		s.aliases[id] = name
	}
	return nil
}

// SeedSessions replaces the full session map with the given snapshot.
// Existing sessions not in the snapshot are dropped. Pens are left unchanged.
func (s *Store) SeedSessions(list []domain.Session) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessions = make(map[string]domain.Session, len(list))
	for _, sess := range list {
		if sess.ID == "" {
			continue
		}
		s.sessions[sess.ID] = sess
	}
}

// ApplyStatus updates status and telemetry for an existing session.
// Unknown session IDs are ignored (status frames can race list seeds).
func (s *Store) ApplyStatus(u backend.StatusUpdate) {
	if u.SessionID == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[u.SessionID]
	if !ok {
		return
	}
	if u.Status != "" {
		sess.Status = u.Status
	}
	// Telemetry: always apply the provided struct (zero values clear fields).
	sess.Telemetry = u.Telemetry
	s.sessions[u.SessionID] = sess
}

// Sessions returns all sessions sorted by ID (stable, not attention-ranked).
func (s *Store) Sessions() []domain.Session {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]domain.Session, 0, len(s.sessions))
	for _, sess := range s.sessions {
		out = append(out, sess)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Get returns a session by ID.
func (s *Store) Get(id string) (domain.Session, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	sess, ok := s.sessions[id]
	return sess, ok
}

// SetPen upserts a pen and marks it active for projectID.
// pen.ProjectID is set to projectID. SessionIDs longer than MaxPenSessions are truncated.
func (s *Store) SetPen(projectID string, pen domain.Pen) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if pen.ID == "" {
		return
	}
	pen.ProjectID = projectID
	if len(pen.SessionIDs) > domain.MaxPenSessions {
		pen.SessionIDs = append([]string(nil), pen.SessionIDs[:domain.MaxPenSessions]...)
	} else {
		pen.SessionIDs = append([]string(nil), pen.SessionIDs...)
	}
	s.pens[pen.ID] = pen
	if projectID != "" {
		s.activePen[projectID] = pen.ID
	}
}

// ActivePen returns the active pen for projectID, or a zero Pen if none.
func (s *Store) ActivePen(projectID string) domain.Pen {
	s.mu.RLock()
	defer s.mu.RUnlock()
	id, ok := s.activePen[projectID]
	if !ok {
		return domain.Pen{}
	}
	p, ok := s.pens[id]
	if !ok {
		return domain.Pen{}
	}
	// Defensive copy of session IDs.
	p.SessionIDs = append([]string(nil), p.SessionIDs...)
	return p
}

// Pen returns a pen by ID.
func (s *Store) Pen(penID string) (domain.Pen, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, ok := s.pens[penID]
	if !ok {
		return domain.Pen{}, false
	}
	p.SessionIDs = append([]string(nil), p.SessionIDs...)
	return p, true
}

// Pens returns all pens sorted by ID.
func (s *Store) Pens() []domain.Pen {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]domain.Pen, 0, len(s.pens))
	for _, p := range s.pens {
		p.SessionIDs = append([]string(nil), p.SessionIDs...)
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// CreatePen creates a named pen for projectID and makes it active.
// id is used if non-empty; otherwise derived from name.
func (s *Store) CreatePen(projectID, id, name string, layout domain.PenLayout) (domain.Pen, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return domain.Pen{}, fmt.Errorf("pen name required")
	}
	if id == "" {
		id = slugID(name)
	}
	if layout == "" {
		layout = domain.PenLayoutCols
	}
	if projectID == "" {
		projectID = "(default)"
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.pens[id]; exists {
		return domain.Pen{}, fmt.Errorf("pen %q already exists", id)
	}
	p := domain.Pen{
		ID:         id,
		ProjectID:  projectID,
		Name:       name,
		Layout:     layout,
		SessionIDs: nil,
	}
	s.pens[id] = p
	s.activePen[projectID] = id
	return p, nil
}

// SwitchActivePen sets the active pen for projectID.
func (s *Store) SwitchActivePen(projectID, penID string) error {
	if projectID == "" {
		projectID = "(default)"
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.pens[penID]
	if !ok {
		return ErrPenNotFound
	}
	if p.ProjectID != "" && p.ProjectID != projectID {
		// still allow switch but keep pen's project
		projectID = p.ProjectID
	}
	s.activePen[projectID] = penID
	return nil
}

// SetPenLayout updates layout for an existing pen.
func (s *Store) SetPenLayout(penID string, layout domain.PenLayout) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.pens[penID]
	if !ok {
		return ErrPenNotFound
	}
	p.Layout = layout
	s.pens[penID] = p
	return nil
}

func slugID(name string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(name) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		} else if r == ' ' || r == '-' || r == '_' {
			b.WriteByte('-')
		}
	}
	s := strings.Trim(b.String(), "-")
	if s == "" {
		s = "pen"
	}
	return s
}

// SavePens writes pens + active-pen map to path as JSON.
func (s *Store) SavePens(path string) error {
	s.mu.RLock()
	pf := pensFile{
		Pens:   make([]penJSON, 0, len(s.pens)),
		Active: make(map[string]string, len(s.activePen)),
	}
	for _, p := range s.pens {
		pf.Pens = append(pf.Pens, penJSON{
			ID:         p.ID,
			ProjectID:  p.ProjectID,
			Name:       p.Name,
			Layout:     string(p.Layout),
			SessionIDs: append([]string(nil), p.SessionIDs...),
		})
	}
	for k, v := range s.activePen {
		pf.Active[k] = v
	}
	s.mu.RUnlock()

	sort.Slice(pf.Pens, func(i, j int) bool { return pf.Pens[i].ID < pf.Pens[j].ID })

	data, err := json.MarshalIndent(pf, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')

	return config.WriteFileAtomic(path, data, 0o600)
}

// LoadPens replaces pens + active map from a JSON file written by SavePens.
// Missing file returns nil (empty pens). Malformed JSON returns an error.
func (s *Store) LoadPens(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var pf pensFile
	if err := json.Unmarshal(data, &pf); err != nil {
		return fmt.Errorf("load pens: %w", err)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.pens = make(map[string]domain.Pen, len(pf.Pens))
	s.activePen = make(map[string]string, len(pf.Active))
	for _, pj := range pf.Pens {
		if pj.ID == "" {
			continue
		}
		ids := pj.SessionIDs
		if ids == nil {
			ids = []string{}
		}
		if len(ids) > domain.MaxPenSessions {
			ids = ids[:domain.MaxPenSessions]
		}
		s.pens[pj.ID] = domain.Pen{
			ID:         pj.ID,
			ProjectID:  pj.ProjectID,
			Name:       pj.Name,
			Layout:     domain.PenLayout(pj.Layout),
			SessionIDs: append([]string(nil), ids...),
		}
	}
	for k, v := range pf.Active {
		s.activePen[k] = v
	}
	return nil
}
