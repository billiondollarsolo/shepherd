// Package gitpanel models a git status/diff panel and a local git executor.
package gitpanel

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// Service abstracts git operations for the panel (and tests).
type Service interface {
	Status(ctx context.Context, cwd string) (branch string, dirty int, ahead, behind int, err error)
	Diff(ctx context.Context, cwd string) (string, error)
	// StageAll stages all changes (git add -A).
	StageAll(ctx context.Context, cwd string) error
	// Commit creates a commit with message (requires staged changes).
	Commit(ctx context.Context, cwd, message string) error
	// Push pushes current branch to upstream (may fail if no remote).
	Push(ctx context.Context, cwd string) error
}

// LocalGit runs the system `git` binary in cwd via os/exec.
// When AllowedRoots is non-empty, cwd must resolve under one of those roots.
type LocalGit struct {
	// AllowedRoots, if set, restricts git to directories under these absolute paths.
	AllowedRoots []string
}

// Status reports current branch, dirty file count, and upstream ahead/behind.
func (g LocalGit) Status(ctx context.Context, cwd string) (branch string, dirty int, ahead, behind int, err error) {
	if err = g.checkRoot(cwd); err != nil {
		return "", 0, 0, 0, err
	}

	// Branch name (empty for detached HEAD → show short SHA via symbolic-ref failure path).
	out, err := g.run(ctx, cwd, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return "", 0, 0, 0, err
	}
	branch = strings.TrimSpace(out)
	if branch == "HEAD" {
		sha, shaErr := g.run(ctx, cwd, "rev-parse", "--short", "HEAD")
		if shaErr == nil {
			branch = "detached@" + strings.TrimSpace(sha)
		}
	}

	// Porcelain status: one line per dirty path (including untracked).
	st, err := g.run(ctx, cwd, "status", "--porcelain")
	if err != nil {
		return branch, 0, 0, 0, err
	}
	for _, line := range strings.Split(st, "\n") {
		if strings.TrimSpace(line) != "" {
			dirty++
		}
	}

	// Ahead/behind vs upstream when set.
	ab, abErr := g.run(ctx, cwd, "rev-list", "--left-right", "--count", "@{upstream}...HEAD")
	if abErr == nil {
		fields := strings.Fields(strings.TrimSpace(ab))
		// git prints: <behind> <ahead> for left-right count of A...B with A=upstream B=HEAD
		// actually: left = commits reachable from first (upstream) not second = behind?
		// `git rev-list --left-right --count @{upstream}...HEAD` → "<left> <right>"
		// left  = commits only on upstream  → we are behind by left
		// right = commits only on HEAD       → we are ahead by right
		if len(fields) == 2 {
			behind, _ = strconv.Atoi(fields[0])
			ahead, _ = strconv.Atoi(fields[1])
		}
	}

	return branch, dirty, ahead, behind, nil
}

// Diff returns unified diff of working tree + staged changes.
func (g LocalGit) Diff(ctx context.Context, cwd string) (string, error) {
	if err := g.checkRoot(cwd); err != nil {
		return "", err
	}
	// Include staged and unstaged; untracked content is not in `git diff`.
	out, err := g.run(ctx, cwd, "diff", "HEAD")
	if err != nil {
		// Fresh repo with no commits: fall back to unstaged + staged vs empty.
		out2, err2 := g.run(ctx, cwd, "diff")
		if err2 != nil {
			return "", err
		}
		return out2, nil
	}
	return out, nil
}

// StageAll runs git add -A.
func (g LocalGit) StageAll(ctx context.Context, cwd string) error {
	if err := g.checkRoot(cwd); err != nil {
		return err
	}
	_, err := g.run(ctx, cwd, "add", "-A")
	return err
}

// Commit runs git commit -m message.
func (g LocalGit) Commit(ctx context.Context, cwd, message string) error {
	if err := g.checkRoot(cwd); err != nil {
		return err
	}
	message = strings.TrimSpace(message)
	if message == "" {
		return fmt.Errorf("gitpanel: empty commit message")
	}
	_, err := g.run(ctx, cwd, "commit", "-m", message)
	return err
}

// Push runs git push.
func (g LocalGit) Push(ctx context.Context, cwd string) error {
	if err := g.checkRoot(cwd); err != nil {
		return err
	}
	_, err := g.run(ctx, cwd, "push")
	return err
}

// PRHint returns an honest command string for creating a PR when gh may be used.
// Does not run gh — caller displays or shells out.
func PRHint(cwd, title string) string {
	if title == "" {
		title = "PR from shep-tui"
	}
	return fmt.Sprintf("cd %s && gh pr create --fill # or: gh pr create --title %q", cwd, title)
}

// CommitLoop stages all + commits. Returns error if either step fails.
func CommitLoop(ctx context.Context, svc Service, cwd, message string) error {
	if err := svc.StageAll(ctx, cwd); err != nil {
		return err
	}
	return svc.Commit(ctx, cwd, message)
}

func (g LocalGit) checkRoot(cwd string) error {
	if len(g.AllowedRoots) == 0 {
		return nil
	}
	abs, err := filepath.Abs(cwd)
	if err != nil {
		return err
	}
	abs = filepath.Clean(abs)
	for _, root := range g.AllowedRoots {
		r, err := filepath.Abs(root)
		if err != nil {
			continue
		}
		r = filepath.Clean(r)
		if abs == r || strings.HasPrefix(abs, r+string(filepath.Separator)) {
			return nil
		}
	}
	return fmt.Errorf("gitpanel: cwd %q outside allowed roots", cwd)
}

func (g LocalGit) run(ctx context.Context, cwd string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = cwd
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", fmt.Errorf("git %s: %s", strings.Join(args, " "), msg)
	}
	return stdout.String(), nil
}

// Panel is the view model for status + diff lines.
type Panel struct {
	Branch    string
	Dirty     int
	Ahead     int
	Behind    int
	DiffLines []string
	Err       string
}

// Load populates the panel from svc for cwd.
func (p *Panel) Load(ctx context.Context, svc Service, cwd string) error {
	p.Err = ""
	p.DiffLines = nil
	branch, dirty, ahead, behind, err := svc.Status(ctx, cwd)
	if err != nil {
		p.Err = err.Error()
		return err
	}
	p.Branch = branch
	p.Dirty = dirty
	p.Ahead = ahead
	p.Behind = behind

	diff, err := svc.Diff(ctx, cwd)
	if err != nil {
		p.Err = err.Error()
		return err
	}
	if diff == "" {
		p.DiffLines = nil
		return nil
	}
	// Split preserving empty trailing? Trim final newline for stable lines.
	diff = strings.TrimSuffix(diff, "\n")
	p.DiffLines = strings.Split(diff, "\n")
	return nil
}
