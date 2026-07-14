// Package listeners discovers bounded, safe metadata about node-local TCP
// listeners. It reads procfs directly and never invokes a shell or returns
// command arguments, environment variables, traffic, or established sockets.
package listeners

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/billiondollarsolo/flock/agentd/proto"
)

const (
	maxProcesses = 4096
	maxFDs       = 2048
	maxListeners = 256
	maxNameBytes = 128
	maxCwdBytes  = 1024
	scanBudget   = 750 * time.Millisecond
)

type socketInfo struct {
	address    string
	targetHost string
	port       int
}

// Snapshot scans Linux procfs and associates listener PIDs with known Shepherd
// session process trees. A non-empty reason means the snapshot is degraded.
func Snapshot(sessionRoots map[string]int) ([]proto.ListeningPort, string) {
	started := time.Now()
	sockets := make(map[string]socketInfo)
	var netErrors []string
	for _, source := range []struct {
		path   string
		family int
	}{{"/proc/net/tcp", 4}, {"/proc/net/tcp6", 6}} {
		file, err := os.Open(source.path)
		if err != nil {
			netErrors = append(netErrors, filepath.Base(source.path)+": "+err.Error())
			continue
		}
		parsed, err := parseProcNet(file, source.family)
		_ = file.Close()
		if err != nil {
			netErrors = append(netErrors, filepath.Base(source.path)+": "+err.Error())
			continue
		}
		for inode, info := range parsed {
			sockets[inode] = info
		}
	}
	if len(sockets) == 0 && len(netErrors) > 0 {
		return nil, strings.Join(netErrors, "; ")
	}

	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, "read procfs: " + err.Error()
	}
	parents := make(map[int]int, min(len(entries), maxProcesses))
	byPID := make(map[int][]proto.ListeningPort)
	permissionFailures := 0
	processes := 0
	for _, entry := range entries {
		if processes >= maxProcesses || time.Since(started) > scanBudget {
			break
		}
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid <= 0 || !entry.IsDir() {
			continue
		}
		processes++
		base := filepath.Join("/proc", entry.Name())
		ppid, name := processIdentity(base)
		parents[pid] = ppid
		fds, err := os.ReadDir(filepath.Join(base, "fd"))
		if err != nil {
			if os.IsPermission(err) {
				permissionFailures++
			}
			continue
		}
		cwd, _ := os.Readlink(filepath.Join(base, "cwd"))
		cwd = bounded(cwd, maxCwdBytes)
		for i, fd := range fds {
			if i >= maxFDs {
				break
			}
			target, err := os.Readlink(filepath.Join(base, "fd", fd.Name()))
			if err != nil || !strings.HasPrefix(target, "socket:[") || !strings.HasSuffix(target, "]") {
				continue
			}
			inode := strings.TrimSuffix(strings.TrimPrefix(target, "socket:["), "]")
			info, ok := sockets[inode]
			if !ok {
				continue
			}
			byPID[pid] = append(byPID[pid], proto.ListeningPort{
				ObservationKey: "tcp:" + info.targetHost + ":" + strconv.Itoa(info.port) + ":" + inode,
				Address:        info.address, TargetHost: info.targetHost, Port: info.port,
				PID: pid, Process: bounded(name, maxNameBytes), Cwd: cwd,
			})
			delete(sockets, inode)
		}
	}

	rootToSession := make(map[int]string, len(sessionRoots))
	for id, pid := range sessionRoots {
		if id != "" && pid > 0 {
			rootToSession[pid] = id
		}
	}
	result := make([]proto.ListeningPort, 0, min(len(byPID), maxListeners))
	for pid, found := range byPID {
		sessionID := owningSession(pid, parents, rootToSession)
		for _, item := range found {
			item.SessionID = sessionID
			result = append(result, item)
			if len(result) >= maxListeners {
				break
			}
		}
		if len(result) >= maxListeners {
			break
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Port != result[j].Port {
			return result[i].Port < result[j].Port
		}
		return result[i].PID < result[j].PID
	})
	reason := ""
	if time.Since(started) > scanBudget {
		reason = "listener discovery reached its scan-time bound"
	} else if len(result) >= maxListeners {
		reason = "listener discovery reached its record bound"
	} else if permissionFailures == processes && processes > 0 {
		reason = "listener process metadata is not readable"
	}
	return result, reason
}

func parseProcNet(reader io.Reader, family int) (map[string]socketInfo, error) {
	result := make(map[string]socketInfo)
	scanner := bufio.NewScanner(io.LimitReader(reader, 4<<20))
	scanner.Buffer(make([]byte, 64*1024), 256*1024)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 10 || fields[0] == "sl" || fields[3] != "0A" {
			continue
		}
		hostPort := strings.SplitN(fields[1], ":", 2)
		if len(hostPort) != 2 {
			continue
		}
		port64, err := strconv.ParseUint(hostPort[1], 16, 16)
		if err != nil || port64 < 1024 {
			continue
		}
		address, target, ok := procAddress(hostPort[0], family)
		if !ok {
			continue
		}
		inode := fields[9]
		if inode == "" || inode == "0" {
			continue
		}
		result[inode] = socketInfo{address: address, targetHost: target, port: int(port64)}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scan proc net: %w", err)
	}
	return result, nil
}

func procAddress(raw string, family int) (string, string, bool) {
	raw = strings.ToUpper(raw)
	if family == 4 {
		switch raw {
		case "00000000":
			return "0.0.0.0", "127.0.0.1", true
		case "0100007F":
			return "127.0.0.1", "127.0.0.1", true
		default:
			return "", "", false
		}
	}
	if family == 6 {
		switch raw {
		case "00000000000000000000000000000000":
			return "::", "::1", true
		case "00000000000000000000000001000000":
			return "::1", "::1", true
		default:
			return "", "", false
		}
	}
	return "", "", false
}

func processIdentity(base string) (int, string) {
	status, _ := os.ReadFile(filepath.Join(base, "status"))
	ppid := 0
	name := ""
	for _, line := range strings.Split(string(status), "\n") {
		if strings.HasPrefix(line, "Name:\t") {
			name = strings.TrimSpace(strings.TrimPrefix(line, "Name:\t"))
		} else if strings.HasPrefix(line, "PPid:\t") {
			ppid, _ = strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "PPid:\t")))
		}
	}
	return ppid, name
}

func owningSession(pid int, parents map[int]int, roots map[int]string) string {
	seen := make(map[int]struct{}, 32)
	for depth := 0; pid > 0 && depth < 128; depth++ {
		if id := roots[pid]; id != "" {
			return id
		}
		if _, exists := seen[pid]; exists {
			break
		}
		seen[pid] = struct{}{}
		pid = parents[pid]
	}
	return ""
}

func bounded(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}
