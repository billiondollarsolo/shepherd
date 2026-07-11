package session

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// drain reads the subscription (replay + live) until `want` appears or timeout.
func drain(t *testing.T, sub *Subscription, want string, timeout time.Duration) string {
	t.Helper()
	var sb strings.Builder
	sb.Write(sub.Replay)
	if strings.Contains(sb.String(), want) {
		return sb.String()
	}
	deadline := time.After(timeout)
	for {
		select {
		case chunk, ok := <-sub.Output:
			if !ok {
				return sb.String()
			}
			sb.Write(chunk)
			if strings.Contains(sb.String(), want) {
				return sb.String()
			}
		case <-deadline:
			return sb.String()
		}
	}
}

func TestDefaultTermAndLocale(t *testing.T) {
	// Without TERM, bash smears its prompt on resize; the daemon must default it.
	s, err := Open(Spec{ID: "term1", Command: []string{"sh", "-c", "echo TERM=$TERM LANG=$LANG"}})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()
	out := drain(t, s.Subscribe(), "TERM=", 2*time.Second)
	if !strings.Contains(out, "TERM=xterm-256color") {
		t.Fatalf("expected TERM=xterm-256color, got %q", out)
	}
	if !strings.Contains(out, "LANG=") {
		t.Fatalf("expected LANG set, got %q", out)
	}
}

func TestCallerEnvOverridesTerm(t *testing.T) {
	s, err := Open(Spec{ID: "term2", Env: []string{"TERM=screen-256color"}, Command: []string{"sh", "-c", "echo TERM=$TERM"}})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()
	out := drain(t, s.Subscribe(), "TERM=", 2*time.Second)
	if !strings.Contains(out, "TERM=screen-256color") {
		t.Fatalf("caller TERM should win, got %q", out)
	}
}

func TestSessionOutput(t *testing.T) {
	s, err := Open(Spec{ID: "t1", Command: []string{"sh", "-c", "printf hello-pty"}})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()
	sub := s.Subscribe()
	defer sub.Close()
	got := drain(t, sub, "hello-pty", 3*time.Second)
	if !strings.Contains(got, "hello-pty") {
		t.Fatalf("want output to contain hello-pty, got %q", got)
	}
}

// T61: LastActivity is zero before any output and set after the PTY produces
// some — the signal the activity-status watcher reads for gemini.
func TestLastActivityTracksOutput(t *testing.T) {
	s, err := Open(Spec{ID: "act1", Command: []string{"sh", "-c", "printf hi"}})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()
	sub := s.Subscribe()
	defer sub.Close()
	drain(t, sub, "hi", 3*time.Second)
	if s.LastActivity().IsZero() {
		t.Fatalf("LastActivity still zero after output")
	}
}

func TestSessionInitialSize(t *testing.T) {
	// `stty size` prints "rows cols"; proves StartWithSize wired the PTY size.
	s, err := Open(Spec{ID: "t2", Cols: 120, Rows: 40, Command: []string{"sh", "-c", "stty size"}})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()
	sub := s.Subscribe()
	defer sub.Close()
	got := drain(t, sub, "40 120", 3*time.Second)
	if !strings.Contains(got, "40 120") {
		t.Fatalf("want PTY size 40 120, got %q", got)
	}
}

func TestSessionResize(t *testing.T) {
	s, err := Open(Spec{ID: "t3", Cols: 80, Rows: 24, Command: []string{"sh", "-c", "sleep 2"}})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()
	if err := s.Resize(132, 50); err != nil {
		t.Fatalf("resize: %v", err)
	}
}

func TestScrollbackReplay(t *testing.T) {
	// Output is produced BEFORE we subscribe → it must come back via the ring.
	s, err := Open(Spec{ID: "t4", Command: []string{"sh", "-c", "printf scrollback-data; sleep 1"}})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()
	time.Sleep(300 * time.Millisecond) // let it write before subscribing
	sub := s.Subscribe()
	defer sub.Close()
	if !strings.Contains(string(sub.Replay), "scrollback-data") {
		t.Fatalf("want scrollback replay to contain scrollback-data, got %q", string(sub.Replay))
	}
}

func TestSessionUsesPrivateTemporaryDirectoryAndCleansIt(t *testing.T) {
	id := fmt.Sprintf("temp-%d", time.Now().UnixNano())
	s, err := Open(Spec{
		ID:      id,
		Command: []string{"sh", "-c", `printf 'TMP=%s\n' "$TMPDIR"; stat -c 'MODE=%a' "$TMPDIR"; sleep 5`},
	})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	out := drain(t, s.Subscribe(), "MODE=700", 2*time.Second)
	var tempDir string
	for _, line := range strings.Split(strings.ReplaceAll(out, "\r", ""), "\n") {
		if strings.HasPrefix(line, "TMP=") {
			tempDir = strings.TrimPrefix(line, "TMP=")
			break
		}
	}
	if tempDir == "" || !strings.Contains(tempDir, filepath.Join(".flock", "tmp", id)) {
		t.Fatalf("unexpected private TMPDIR in output: %q", out)
	}
	if !strings.Contains(out, "MODE=700") {
		t.Fatalf("private TMPDIR must be mode 0700: %q", out)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-s.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("session did not finalize")
	}
	if _, err := os.Stat(tempDir); !os.IsNotExist(err) {
		t.Fatalf("private TMPDIR was not removed: %v", err)
	}
}

// collect reads replay + live output for a fixed window and returns everything.
func collect(t *testing.T, sub *Subscription, d time.Duration) string {
	t.Helper()
	var sb strings.Builder
	sb.Write(sub.Replay)
	deadline := time.After(d)
	for {
		select {
		case chunk, ok := <-sub.Output:
			if !ok {
				return sb.String()
			}
			sb.Write(chunk)
		case <-deadline:
			return sb.String()
		}
	}
}

func TestDevSessionRestartsOnExit(t *testing.T) {
	// A dev process that prints a marker and exits should be respawned, so the
	// marker appears more than once and a restart banner is injected.
	s, err := Open(Spec{ID: "dev1", Kind: "dev", Command: []string{"sh", "-c", "printf dev-loop; exit 1"}})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()
	sub := s.Subscribe()
	defer sub.Close()
	out := collect(t, sub, 1500*time.Millisecond)
	if n := strings.Count(out, "dev-loop"); n < 2 {
		t.Fatalf("expected dev process to restart (marker >=2), saw %d in %q", n, out)
	}
	if !strings.Contains(out, "restarting") {
		t.Fatalf("expected a restart banner, got %q", out)
	}
}

func TestDevSessionPersistsAcrossRestartsUntilClose(t *testing.T) {
	// Unlike a normal session, a dev session must NOT be auto-removed when its
	// process exits — it stays registered (and supervised) until Close().
	m := NewManager()
	if _, err := m.Open(Spec{ID: "dev2", Kind: "dev", Command: []string{"sh", "-c", "exit 0"}}); err != nil {
		t.Fatalf("open: %v", err)
	}
	time.Sleep(700 * time.Millisecond) // exit(0) + at least one restart cycle
	if m.Get("dev2") == nil {
		t.Fatalf("dev session should persist across restarts")
	}
	m.Close("dev2")
	if m.Get("dev2") != nil {
		t.Fatalf("closed dev session should be removed from the registry")
	}
}

func TestDevSessionCloseEnds(t *testing.T) {
	s, err := Open(Spec{ID: "dev3", Kind: "dev", Command: []string{"sh", "-c", "sleep 30"}})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	s.Close()
	select {
	case <-s.Done():
	case <-time.After(3 * time.Second):
		t.Fatalf("Close() should end a dev session")
	}
}

func TestNonDevFinalizesOnExit(t *testing.T) {
	// A non-dev session ends for good on its first exit (no supervision).
	s, err := Open(Spec{ID: "nd1", Command: []string{"sh", "-c", "exit 0"}})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()
	select {
	case <-s.Done():
	case <-time.After(3 * time.Second):
		t.Fatalf("non-dev session should finalize on exit")
	}
	if ex, _ := s.Exited(); !ex {
		t.Fatalf("should report exited after the process ends")
	}
}

func TestResizeDedupSuppressesRedundantSigwinch(t *testing.T) {
	// A shell that prints on SIGWINCH. Resizing to the SAME size must NOT fire it
	// (the cause of bash reprinting its prompt on every reconnect); a real change
	// fires it exactly once.
	s, err := Open(Spec{
		ID:      "rz",
		Cols:    80,
		Rows:    24,
		Command: []string{"bash", "-c", `trap 'printf "WINCH "' WINCH; while :; do sleep 0.05; done`},
	})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()
	sub := s.Subscribe()
	defer sub.Close()
	time.Sleep(300 * time.Millisecond) // let bash install the trap

	_ = s.Resize(80, 24) // same as the open size → deduped, no SIGWINCH
	_ = s.Resize(80, 24) // still same → deduped
	time.Sleep(100 * time.Millisecond)
	_ = s.Resize(132, 43) // a real change → exactly one SIGWINCH

	out := collect(t, sub, 1200*time.Millisecond)
	if n := strings.Count(out, "WINCH"); n != 1 {
		t.Fatalf("expected exactly 1 SIGWINCH (only the changed resize), got %d in %q", n, out)
	}
}

func TestManagerReusesSessionId(t *testing.T) {
	m := NewManager()
	a, err := m.Open(Spec{ID: "dup", Command: []string{"sh", "-c", "sleep 2"}})
	if err != nil {
		t.Fatalf("open a: %v", err)
	}
	b, err := m.Open(Spec{ID: "dup", Command: []string{"sh", "-c", "sleep 2"}})
	if err != nil {
		t.Fatalf("open b: %v", err)
	}
	if a != b {
		t.Fatalf("same id should return the same session (reconnect), got distinct")
	}
	m.CloseAll()
}

// --- alternate-screen detection + reattach repaint (htop garble fix) ----------

func TestUpdateAltStateTransitions(t *testing.T) {
	cases := []struct {
		name   string
		chunks []string
		want   bool
	}{
		{"enter", []string{"hello\x1b[?1049hTUI"}, true},
		{"enter then exit", []string{"\x1b[?1049happ\x1b[?1049lback"}, false},
		{"legacy 47 enter", []string{"\x1b[?47h"}, true},
		{"no sequences keeps state false", []string{"just text"}, false},
		{"last toggle wins", []string{"\x1b[?1049l\x1b[?1049h"}, true},
		// switch sequence split across two chunks must still be detected
		{"boundary split enter", []string{"text\x1b[?10", "49htui"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := &Session{}
			for _, c := range tc.chunks {
				s.updateAltState([]byte(c))
			}
			if s.inAlt != tc.want {
				t.Fatalf("inAlt = %v, want %v", s.inAlt, tc.want)
			}
		})
	}
}

// In the alternate screen, Subscribe must NOT replay the (garbled) ring; it sends
// a clean alt-buffer reset so the program can repaint itself on reattach.
func TestSubscribeAltScreenReplaysCleanResetNotRing(t *testing.T) {
	s := &Session{ring: newRing(defaultScrollbackBytes), subs: map[int]chan []byte{}}
	s.ring.write([]byte("OLD GARBLED FRAME BYTES"))
	s.inAlt = true

	sub := s.Subscribe()
	defer sub.Close()
	got := string(sub.Replay)
	if strings.Contains(got, "OLD GARBLED") {
		t.Fatalf("alt-screen replay must not include raw ring history, got %q", got)
	}
	if !strings.Contains(got, "\x1b[?1049h") {
		t.Fatalf("alt-screen replay must enter the alt buffer, got %q", got)
	}
}

// After a program LEAVES the alternate screen (e.g. quit htop), the stale alt
// frames must be dropped from the scrollback ring so a later NORMAL-screen reattach
// doesn't replay them as garbage (the "garbled htop on reattach" bug).
func TestBroadcastDropsStaleAltFramesOnExit(t *testing.T) {
	s := &Session{ring: newRing(defaultScrollbackBytes), subs: map[int]chan []byte{}}
	s.broadcast([]byte("\x1b[?1049h"))                    // enter alt screen
	s.broadcast([]byte("GARBLED HTOP FRAME BYTES"))       // alt-screen redraws
	s.broadcast([]byte("\x1b[?1049lback at the shell$ ")) // exit alt + normal output
	if s.inAlt {
		t.Fatal("expected inAlt=false after alt-exit")
	}
	sub := s.Subscribe()
	defer sub.Close()
	got := string(sub.Replay)
	if strings.Contains(got, "GARBLED HTOP") {
		t.Fatalf("post-alt-exit replay must drop stale alt frames, got %q", got)
	}
	if !strings.Contains(got, "back at the shell$") {
		t.Fatalf("post-alt-exit replay must keep normal output after the exit, got %q", got)
	}
}

// In the normal screen, Subscribe replays the scrollback ring unchanged.
func TestSubscribeNormalScreenReplaysRing(t *testing.T) {
	s := &Session{ring: newRing(defaultScrollbackBytes), subs: map[int]chan []byte{}}
	s.ring.write([]byte("flock@host:~$ ls\r\n"))

	sub := s.Subscribe()
	defer sub.Close()
	if got := string(sub.Replay); !strings.Contains(got, "flock@host:~$ ls") {
		t.Fatalf("normal-screen replay should be the scrollback ring, got %q", got)
	}
}

// --- scoped hook-config seeding (US-19 / T1) ---------------------------------

func TestSeedScopedConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	// Fake the node user's real config (credentials base to copy in).
	if err := os.MkdirAll(filepath.Join(home, ".claude"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".claude", "creds.json"), []byte(`{"token":"x"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	spec := Spec{
		ID:               "seed-test-1",
		ConfigDirEnv:     "CLAUDE_CONFIG_DIR",
		ConfigBaseSubdir: ".claude",
		ConfigFiles: map[string]string{
			"settings.json": `{"hooks":"sh __FLOCK_CONFIG_DIR__/flock-hook.sh"}`,
			"flock-hook.sh": "#!/bin/sh\nexec curl @-\n",
		},
	}
	dir, env, err := seedScopedConfig(spec)
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	defer os.RemoveAll(dir)

	if env != "CLAUDE_CONFIG_DIR="+dir {
		t.Fatalf("env entry = %q, want CLAUDE_CONFIG_DIR=%s", env, dir)
	}
	// Base credentials copied in.
	if b, err := os.ReadFile(filepath.Join(dir, "creds.json")); err != nil || string(b) != `{"token":"x"}` {
		t.Fatalf("creds base not copied: %v %q", err, b)
	}
	// Placeholder substituted with the real dir.
	settings, err := os.ReadFile(filepath.Join(dir, "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(settings), "__FLOCK_CONFIG_DIR__") {
		t.Fatalf("placeholder not substituted: %s", settings)
	}
	if !strings.Contains(string(settings), dir) {
		t.Fatalf("scoped dir not in settings: %s", settings)
	}
	// Forwarder script is executable.
	fi, err := os.Stat(filepath.Join(dir, "flock-hook.sh"))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm()&0o100 == 0 {
		t.Fatalf("flock-hook.sh not executable: %v", fi.Mode())
	}
}

func TestSeedScopedConfigNoop(t *testing.T) {
	dir, env, err := seedScopedConfig(Spec{ID: "x"}) // no ConfigDirEnv
	if err != nil || dir != "" || env != "" {
		t.Fatalf("expected no-op, got dir=%q env=%q err=%v", dir, env, err)
	}
}

func TestSeedScopedConfigMergesUserSettings(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, ".claude"), 0o700); err != nil {
		t.Fatal(err)
	}
	// User's real settings.json: a model pref + their own SessionStart hook.
	userSettings := `{"model":"opus","hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo mine"}]}]}}`
	if err := os.WriteFile(filepath.Join(home, ".claude", "settings.json"), []byte(userSettings), 0o600); err != nil {
		t.Fatal(err)
	}
	flock := `{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"sh __FLOCK_CONFIG_DIR__/flock-hook.sh"}]}],"Stop":[{"hooks":[{"type":"command","command":"sh __FLOCK_CONFIG_DIR__/flock-hook.sh"}]}]}}`
	dir, _, err := seedScopedConfig(Spec{ID: "merge-1", ConfigDirEnv: "CLAUDE_CONFIG_DIR", ConfigBaseSubdir: ".claude", ConfigFiles: map[string]string{"settings.json": flock}})
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	b, _ := os.ReadFile(filepath.Join(dir, "settings.json"))
	s := string(b)
	if !strings.Contains(s, `"model"`) || !strings.Contains(s, "opus") {
		t.Fatalf("user model pref lost: %s", s)
	}
	if !strings.Contains(s, "echo mine") {
		t.Fatalf("user's own SessionStart hook lost: %s", s)
	}
	if !strings.Contains(s, "flock-hook.sh") {
		t.Fatalf("flock hook not added: %s", s)
	}
	if !strings.Contains(s, `"Stop"`) {
		t.Fatalf("flock Stop hook not added: %s", s)
	}
}

// Regression for the daemon-crashing race (audit C1): a blocking send racing
// finalize()'s close() → "send on closed channel" panic. The fan-out is now
// non-blocking AND under s.mu (mutually exclusive with close), so a slow
// subscriber neither blocks the pump nor crashes the daemon.
func TestBroadcastNonBlockingAndFinalizeRaceSafe(t *testing.T) {
	s := &Session{
		ring: newRing(defaultScrollbackBytes),
		subs: map[int]chan []byte{},
		done: make(chan struct{}),
	}
	_ = s.Subscribe() // a subscriber we never drain → its buffer fills

	// 1) Flooding far past the 256 buffer must NOT block (non-blocking send drops).
	done := make(chan struct{})
	go func() {
		for i := 0; i < 100000; i++ {
			s.broadcast([]byte("x"))
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("broadcast blocked on an undrained subscriber (backpressure regression)")
	}
	if s.DroppedOutputBytes() == 0 {
		t.Fatal("expected dropped live output to increment the diagnostic counter")
	}

	// 2) Hammer broadcast concurrently while finalize() closes the channels — the
	// exact race that used to panic. Must complete cleanly.
	stop := make(chan struct{})
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
					s.broadcast([]byte("y"))
				}
			}
		}()
	}
	time.Sleep(50 * time.Millisecond)
	s.finalize() // close under lock while broadcasts race it
	close(stop)
	wg.Wait()
}
