package gitpanel

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

type fakeService struct {
	branch       string
	dirty        int
	ahead        int
	behind       int
	statusErr    error
	diff         string
	diffErr      error
	statusCalled bool
	diffCalled   bool
	lastCwd      string
	staged       bool
	committed    string
	pushed       bool
	stageErr     error
	commitErr    error
	pushErr      error
}

func (f *fakeService) Status(ctx context.Context, cwd string) (string, int, int, int, error) {
	f.statusCalled = true
	f.lastCwd = cwd
	return f.branch, f.dirty, f.ahead, f.behind, f.statusErr
}

func (f *fakeService) Diff(ctx context.Context, cwd string) (string, error) {
	f.diffCalled = true
	f.lastCwd = cwd
	return f.diff, f.diffErr
}

func (f *fakeService) StageAll(ctx context.Context, cwd string) error {
	f.lastCwd = cwd
	if f.stageErr != nil {
		return f.stageErr
	}
	f.staged = true
	return nil
}

func (f *fakeService) Commit(ctx context.Context, cwd, message string) error {
	f.lastCwd = cwd
	if f.commitErr != nil {
		return f.commitErr
	}
	f.committed = message
	return nil
}

func (f *fakeService) Push(ctx context.Context, cwd string) error {
	f.lastCwd = cwd
	if f.pushErr != nil {
		return f.pushErr
	}
	f.pushed = true
	return nil
}

func TestPanelLoadFake(t *testing.T) {
	svc := &fakeService{
		branch: "main",
		dirty:  3,
		ahead:  1,
		behind: 2,
		diff:   "diff --git a/x b/x\n+hello\n",
	}
	var p Panel
	if err := p.Load(context.Background(), svc, "/tmp/proj"); err != nil {
		t.Fatal(err)
	}
	if p.Branch != "main" || p.Dirty != 3 || p.Ahead != 1 || p.Behind != 2 {
		t.Fatalf("panel meta: %#v", p)
	}
	if len(p.DiffLines) != 2 || p.DiffLines[1] != "+hello" {
		t.Fatalf("diff lines: %#v", p.DiffLines)
	}
	if p.Err != "" {
		t.Fatalf("err: %s", p.Err)
	}
}

func TestPanelLoadStatusError(t *testing.T) {
	svc := &fakeService{statusErr: errors.New("no repo")}
	var p Panel
	err := p.Load(context.Background(), svc, "/x")
	if err == nil {
		t.Fatal("expected error")
	}
	if p.Err != "no repo" {
		t.Fatalf("p.Err = %q", p.Err)
	}
	if svc.diffCalled {
		t.Fatal("diff should not run after status error")
	}
}

func TestPanelLoadDiffError(t *testing.T) {
	svc := &fakeService{branch: "main", diffErr: errors.New("diff fail")}
	var p Panel
	err := p.Load(context.Background(), svc, "/x")
	if err == nil {
		t.Fatal("expected error")
	}
	if p.Branch != "main" {
		t.Fatalf("branch should still be set, got %q", p.Branch)
	}
	if p.Err != "diff fail" {
		t.Fatalf("p.Err = %q", p.Err)
	}
}

func TestPanelLoadEmptyDiff(t *testing.T) {
	svc := &fakeService{branch: "main", diff: ""}
	var p Panel
	if err := p.Load(context.Background(), svc, "/x"); err != nil {
		t.Fatal(err)
	}
	if p.DiffLines != nil {
		t.Fatalf("want nil DiffLines, got %#v", p.DiffLines)
	}
}

func TestLocalGitAllowedRoots(t *testing.T) {
	g := LocalGit{AllowedRoots: []string{"/home/proj"}}
	_, _, _, _, err := g.Status(context.Background(), "/etc")
	if err == nil || !strings.Contains(err.Error(), "outside allowed") {
		t.Fatalf("expected root error, got %v", err)
	}
	_, err = g.Diff(context.Background(), "/tmp")
	if err == nil || !strings.Contains(err.Error(), "outside allowed") {
		t.Fatalf("expected root error on Diff, got %v", err)
	}
}

func TestLocalGitLive(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=test",
			"GIT_AUTHOR_EMAIL=test@example.com",
			"GIT_COMMITTER_NAME=test",
			"GIT_COMMITTER_EMAIL=test@example.com",
		)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-b", "main")
	run("config", "user.email", "test@example.com")
	run("config", "user.name", "test")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "a.txt")
	run("commit", "-m", "init")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("two\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	g := LocalGit{AllowedRoots: []string{dir}}
	branch, dirty, ahead, behind, err := g.Status(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if branch != "main" {
		t.Fatalf("branch = %q", branch)
	}
	if dirty < 1 {
		t.Fatalf("dirty = %d, want >= 1", dirty)
	}
	_ = ahead
	_ = behind

	diff, err := g.Diff(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(diff, "two") {
		t.Fatalf("diff missing content: %q", diff)
	}

	var p Panel
	if err := p.Load(context.Background(), g, dir); err != nil {
		t.Fatal(err)
	}
	if p.Branch != "main" || p.Dirty < 1 || len(p.DiffLines) == 0 {
		t.Fatalf("loaded panel: %#v", p)
	}
}

func TestCommitLoop(t *testing.T) {
	svc := &fakeService{}
	if err := CommitLoop(context.Background(), svc, "/repo", "msg"); err != nil {
		t.Fatal(err)
	}
	if !svc.staged || svc.committed != "msg" {
		t.Fatalf("staged=%v committed=%q", svc.staged, svc.committed)
	}
}

func TestPRHint(t *testing.T) {
	h := PRHint("/tmp/r", "hello")
	if !strings.Contains(h, "gh pr create") || !strings.Contains(h, "/tmp/r") {
		t.Fatal(h)
	}
}

func TestCommitLoopStageError(t *testing.T) {
	svc := &fakeService{stageErr: errors.New("stage fail")}
	if err := CommitLoop(context.Background(), svc, "/r", "m"); err == nil {
		t.Fatal("expected error")
	}
}
