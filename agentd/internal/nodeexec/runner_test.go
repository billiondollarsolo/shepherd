package nodeexec

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

func TestRunCapturesInputExitAndTruncation(t *testing.T) {
	result, err := New(nil).Run(context.Background(), Request{
		Command:     []string{"sh", "-c", "cat; printf err >&2; exit 7"},
		Input:       "abcdef",
		StdoutLimit: 3,
		StderrLimit: 16,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 7 || result.Stdout != "abc" || !result.StdoutTruncated || result.Stderr != "err" {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestRunStripsControlEnvironmentAndForcesHome(t *testing.T) {
	t.Setenv("FLOCK_AGENTD_SECRET", "do-not-leak")
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	result, err := New(nil).Run(context.Background(), Request{
		Command: []string{"sh", "-c", `printf '%s|%s' "${FLOCK_AGENTD_SECRET-unset}" "$HOME"`},
		Env:     []string{"FLOCK_AGENTD_SECRET=caller-leak", "HOME=/wrong"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Stdout != "unset|"+home {
		t.Fatalf("environment was not sanitized: %q", result.Stdout)
	}
}

func TestRunTimeoutKillsProcessGroup(t *testing.T) {
	result, err := New(nil).Run(context.Background(), Request{
		Command: []string{"sh", "-c", "sleep 30 & wait"},
		Timeout: 100 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.TimedOut || result.Signal != "SIGKILL" {
		t.Fatalf("timeout not reported: %+v", result)
	}
}

func TestRunRejectsMalformedOrOversizedRequests(t *testing.T) {
	tests := []Request{
		{},
		{Command: []string{"echo", "bad\x00arg"}},
		{Command: []string{"echo"}, Env: []string{"NOT_AN_ASSIGNMENT"}},
		{Command: []string{"echo"}, Input: strings.Repeat("x", MaxInputBytes+1)},
		{Command: []string{"echo"}, Timeout: MaxTimeout + time.Millisecond},
	}
	for _, request := range tests {
		if _, err := New(nil).Run(context.Background(), request); err == nil {
			t.Fatalf("invalid request accepted: %+v", request)
		}
	}
}

func TestSecureWorkingDirectoryRejectsMissingFilesAndSymlinkEscape(t *testing.T) {
	home := t.TempDir()
	inside := home + "/project"
	if err := os.Mkdir(inside, 0o700); err != nil {
		t.Fatal(err)
	}
	if got, err := secureWorkingDirectory(home, inside); err != nil || got != inside {
		t.Fatalf("inside directory rejected: %q %v", got, err)
	}
	outside := t.TempDir()
	if _, err := secureWorkingDirectory(home, outside); err == nil {
		t.Fatal("outside directory accepted")
	}
	if _, err := secureWorkingDirectory(home, home+"/missing"); err == nil {
		t.Fatal("missing directory accepted")
	}
	if err := os.Symlink(outside, home+"/escape"); err != nil {
		t.Fatal(err)
	}
	if _, err := secureWorkingDirectory(home, home+"/escape"); err == nil {
		t.Fatal("symlink escape accepted")
	}
}
