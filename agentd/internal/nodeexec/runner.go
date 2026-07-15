// Package nodeexec implements bounded non-interactive commands as the fixed
// unprivileged runtime identity.
package nodeexec

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/billiondollarsolo/flock/agentd/internal/identity"
	"github.com/billiondollarsolo/flock/agentd/internal/runtimeprocess"
	"golang.org/x/sys/unix"
)

const (
	MaxArguments        = 256
	MaxArgumentBytes    = 64 << 10
	MaxEnvironment      = 256
	MaxEnvironmentBytes = 128 << 10
	MaxInputBytes       = 8 << 20
	DefaultOutputBytes  = 4 << 20
	MaxOutputBytes      = 6 << 20
	DefaultTimeout      = 30 * time.Second
	MaxTimeout          = 2 * time.Minute
)

// Request is the validated command contract received over exec_v1.
type Request struct {
	Command     []string
	Cwd         string
	Env         []string
	Input       string
	Timeout     time.Duration
	StdoutLimit int
	StderrLimit int
}

// Result is returned for both successful and non-zero command exits.
type Result struct {
	ExitCode        int
	Signal          string
	Stdout          string
	Stderr          string
	TimedOut        bool
	StdoutTruncated bool
	StderrTruncated bool
}

// Runner never accepts a caller-selected OS identity.
type Runner struct {
	runtime *identity.Runtime
}

func New(runtime *identity.Runtime) *Runner { return &Runner{runtime: runtime} }

// Run validates, starts, and reaps one command. Cancellation kills its entire
// process group so grandchildren cannot retain pipes or outlive the operation.
func (r *Runner) Run(parent context.Context, request Request) (Result, error) {
	request, err := normalize(request)
	if err != nil {
		return Result{}, err
	}

	ctx, cancel := context.WithTimeout(parent, request.Timeout)
	defer cancel()

	home := runtimeprocess.Home(r.runtime)
	if r.runtime != nil {
		request.Cwd, err = secureWorkingDirectory(home, request.Cwd)
		if err != nil {
			return Result{}, err
		}
	}
	command := exec.Command(runtimeprocess.ResolveExecutable(request.Command[0], home), request.Command[1:]...)
	command.Dir = request.Cwd
	if command.Dir == "" {
		command.Dir = home
	}
	command.Env = runtimeprocess.Environment(r.runtime, request.Env)
	command.Stdin = strings.NewReader(request.Input)
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if r.runtime != nil {
		r.runtime.Apply(command)
	}

	stdout := &cappedBuffer{limit: request.StdoutLimit}
	stderr := &cappedBuffer{limit: request.StderrLimit}
	command.Stdout = stdout
	command.Stderr = stderr

	if err := command.Start(); err != nil {
		return Result{}, fmt.Errorf("start command: %w", err)
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()

	timedOut := false
	select {
	case <-done:
	case <-ctx.Done():
		timedOut = parent.Err() == nil && ctx.Err() == context.DeadlineExceeded
		if command.Process != nil {
			_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
			_ = command.Process.Kill()
		}
		<-done
	}

	result := Result{
		ExitCode:        0,
		Stdout:          stdout.String(),
		Stderr:          stderr.String(),
		TimedOut:        timedOut,
		StdoutTruncated: stdout.truncated,
		StderrTruncated: stderr.truncated,
	}
	if state := command.ProcessState; state != nil {
		if wait, ok := state.Sys().(syscall.WaitStatus); ok {
			if wait.Signaled() {
				result.ExitCode = -1
				if name := unix.SignalName(wait.Signal()); name != "" {
					if strings.HasPrefix(name, "SIG") {
						result.Signal = name
					} else {
						result.Signal = "SIG" + name
					}
				}
			} else {
				result.ExitCode = wait.ExitStatus()
			}
		}
	}
	return result, nil
}

func secureWorkingDirectory(home, cwd string) (string, error) {
	if cwd == "" {
		cwd = home
	}
	root, err := filepath.EvalSymlinks(home)
	if err != nil {
		return "", fmt.Errorf("resolve runtime home: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(cwd)
	if err != nil {
		return "", fmt.Errorf("resolve exec working directory: %w", err)
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.IsDir() {
		return "", fmt.Errorf("exec working directory is not a directory")
	}
	relative, err := filepath.Rel(root, resolved)
	if err != nil || relative == ".." || filepath.IsAbs(relative) || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
		return "", fmt.Errorf("exec working directory is outside the runtime workspace root")
	}
	return filepath.Clean(resolved), nil
}

func normalize(request Request) (Request, error) {
	if len(request.Command) == 0 || len(request.Command) > MaxArguments {
		return request, fmt.Errorf("exec command must contain 1-%d arguments", MaxArguments)
	}
	argumentBytes := 0
	for _, argument := range request.Command {
		if strings.IndexByte(argument, 0) >= 0 {
			return request, fmt.Errorf("exec argument contains NUL")
		}
		argumentBytes += len(argument)
	}
	if argumentBytes > MaxArgumentBytes {
		return request, fmt.Errorf("exec arguments exceed %d bytes", MaxArgumentBytes)
	}
	if len(request.Env) > MaxEnvironment {
		return request, fmt.Errorf("exec environment exceeds %d entries", MaxEnvironment)
	}
	environmentBytes := 0
	for _, entry := range request.Env {
		index := strings.IndexByte(entry, '=')
		if index <= 0 || strings.IndexByte(entry, 0) >= 0 {
			return request, fmt.Errorf("exec environment entry is invalid")
		}
		environmentBytes += len(entry)
	}
	if environmentBytes > MaxEnvironmentBytes {
		return request, fmt.Errorf("exec environment exceeds %d bytes", MaxEnvironmentBytes)
	}
	if len(request.Input) > MaxInputBytes {
		return request, fmt.Errorf("exec input exceeds %d bytes", MaxInputBytes)
	}
	if strings.IndexByte(request.Cwd, 0) >= 0 {
		return request, fmt.Errorf("exec working directory contains NUL")
	}
	if request.Timeout <= 0 {
		request.Timeout = DefaultTimeout
	}
	if request.Timeout > MaxTimeout {
		return request, fmt.Errorf("exec timeout exceeds %s", MaxTimeout)
	}
	request.StdoutLimit = outputLimit(request.StdoutLimit)
	request.StderrLimit = outputLimit(request.StderrLimit)
	return request, nil
}

func outputLimit(limit int) int {
	if limit <= 0 {
		return DefaultOutputBytes
	}
	if limit > MaxOutputBytes {
		return MaxOutputBytes
	}
	return limit
}

type cappedBuffer struct {
	data      []byte
	limit     int
	truncated bool
}

func (buffer *cappedBuffer) Write(value []byte) (int, error) {
	original := len(value)
	remaining := buffer.limit - len(buffer.data)
	if remaining <= 0 {
		buffer.truncated = buffer.truncated || original > 0
		return original, nil
	}
	if len(value) > remaining {
		buffer.data = append(buffer.data, value[:remaining]...)
		buffer.truncated = true
		return original, nil
	}
	buffer.data = append(buffer.data, value...)
	return original, nil
}

func (buffer *cappedBuffer) String() string { return string(buffer.data) }

var _ io.Writer = (*cappedBuffer)(nil)
