// Package metrics collects host resource metrics (CPU, memory, disk, load,
// uptime) and detects which coding-agent CLIs are installed on the node. It is
// Linux-only (reads /proc + statfs) — Flock nodes are Linux. CPU percentage needs
// two samples over an interval, so Start() runs a background sampler that keeps a
// cached value; Snapshot() returns the latest without blocking.
package metrics

import (
	"bufio"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"flock-agentd/internal/agentpath"
	"flock-agentd/internal/sandbox"
)

// AgentInfo is a coding-agent CLI detected on the node.
type AgentInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Path    string `json:"path"`
}

// NodeInfo is a point-in-time host snapshot (bytes for memory/disk).
type NodeInfo struct {
	Hostname   string      `json:"hostname"`
	OS         string      `json:"os"`
	Kernel     string      `json:"kernel"`
	Cores      int         `json:"cores"`
	UptimeSec  int64       `json:"uptimeSec"`
	Load1      float64     `json:"load1"`
	Load5      float64     `json:"load5"`
	Load15     float64     `json:"load15"`
	CPUPercent float64     `json:"cpuPercent"`
	MemTotal   uint64      `json:"memTotal"`
	MemUsed    uint64      `json:"memUsed"`
	DiskTotal  uint64      `json:"diskTotal"`
	DiskUsed   uint64      `json:"diskUsed"`
	Agents     []AgentInfo `json:"agents"`
	// T17: whether this node can enforce the autonomous-mode Landlock FS sandbox.
	// The orchestrator uses it to confine autonomous sessions (or warn when it can't).
	SandboxAvailable bool `json:"sandboxAvailable"`
}

var (
	mu         sync.Mutex
	cpuPercent float64
	lastTotal  uint64
	lastIdle   uint64

	startOnce  sync.Once
	agentMu    sync.Mutex
	agentCache []AgentInfo
	agentHome  string
)

// SetAgentHome points CLI detection at the fixed runtime identity rather than
// the root daemon's home. Call once before Start.
func SetAgentHome(home string) {
	agentMu.Lock()
	agentHome = home
	agentMu.Unlock()
}

// knownAgents are the coding-agent CLIs we probe for on the node. T20: dropped
// "aider" (not launchable/integrated — advertising it implied breadth we don't
// deliver). "gemini" stays: it's now a launchable agent type.
var knownAgents = []string{"claude", "codex", "opencode", "gemini", "grok"}

// agentRescan is how often the background loop re-detects installed agents, so an
// agent installed AFTER the daemon started shows up without a restart.
const agentRescan = 30 * time.Second

// Start launches the background samplers once (idempotent): a 2s CPU sampler and
// a periodic agent re-scan. Snapshot() also calls it.
func Start() {
	startOnce.Do(func() {
		readCPU()       // prime the CPU deltas
		refreshAgents() // initial agent detection (so the first Snapshot has it)
		go func() {
			cpuTick := time.NewTicker(2 * time.Second)
			scan := time.NewTicker(agentRescan)
			defer cpuTick.Stop()
			defer scan.Stop()
			for {
				select {
				case <-cpuTick.C:
					sampleCPU()
				case <-scan.C:
					refreshAgents()
				}
			}
		}()
	})
}

// hostStatic holds the host-identity fields that never change for the daemon's
// lifetime; read once (Snapshot runs on every nodeInfo poll, so re-reading
// /etc/os-release + /proc + hostname each time was pure waste).
type hostStaticInfo struct {
	hostname string
	os       string
	kernel   string
	cores    int
}

var hostStatic = sync.OnceValue(func() hostStaticInfo {
	h, _ := os.Hostname()
	return hostStaticInfo{
		hostname: h,
		os:       osPretty(),
		kernel:   readTrim("/proc/sys/kernel/osrelease"),
		cores:    runtime.NumCPU(),
	}
})

// Landlock support can't change at runtime → probe once.
var sandboxAvail = sync.OnceValue(sandbox.Available)

// Snapshot returns the current host metrics + detected agents.
func Snapshot() NodeInfo {
	Start()
	mu.Lock()
	cpu := cpuPercent
	mu.Unlock()
	st := hostStatic()
	memTotal, memUsed := memInfo()
	diskTotal, diskUsed := diskInfo("/")
	l1, l5, l15 := loadAvg()
	return NodeInfo{
		Hostname:         st.hostname,
		OS:               st.os,
		Kernel:           st.kernel,
		Cores:            st.cores,
		UptimeSec:        uptimeSec(),
		Load1:            l1,
		Load5:            l5,
		Load15:           l15,
		CPUPercent:       cpu,
		MemTotal:         memTotal,
		MemUsed:          memUsed,
		DiskTotal:        diskTotal,
		DiskUsed:         diskUsed,
		Agents:           cachedAgents(),
		SandboxAvailable: sandboxAvail(),
	}
}

// --- CPU (/proc/stat aggregate line) ----------------------------------------

func cpuTotals() (total, idle uint64) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	if sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) >= 5 && fields[0] == "cpu" {
			for i, s := range fields[1:] {
				v, _ := strconv.ParseUint(s, 10, 64)
				total += v
				if i == 3 || i == 4 { // idle + iowait
					idle += v
				}
			}
		}
	}
	return
}

func readCPU() { lastTotal, lastIdle = cpuTotals() }

func sampleCPU() {
	total, idle := cpuTotals()
	dt := total - lastTotal
	di := idle - lastIdle
	lastTotal, lastIdle = total, idle
	if dt == 0 {
		return
	}
	p := (1 - float64(di)/float64(dt)) * 100
	if p < 0 {
		p = 0
	}
	mu.Lock()
	cpuPercent = p
	mu.Unlock()
}

// --- memory (/proc/meminfo) -------------------------------------------------

func memInfo() (total, used uint64) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return
	}
	defer f.Close()
	var memTotal, memAvail uint64
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, "MemTotal:"):
			memTotal = parseMeminfoKB(line)
		case strings.HasPrefix(line, "MemAvailable:"):
			memAvail = parseMeminfoKB(line)
		}
	}
	total = memTotal * 1024
	if memTotal >= memAvail {
		used = (memTotal - memAvail) * 1024
	}
	return
}

func parseMeminfoKB(line string) uint64 {
	fields := strings.Fields(line) // ["MemTotal:", "16384000", "kB"]
	if len(fields) < 2 {
		return 0
	}
	v, _ := strconv.ParseUint(fields[1], 10, 64)
	return v
}

// --- disk (statfs) ----------------------------------------------------------

func diskInfo(path string) (total, used uint64) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return
	}
	bs := uint64(st.Bsize)
	total = st.Blocks * bs
	free := st.Bavail * bs
	if total >= free {
		used = total - free
	}
	return
}

// --- load + uptime ----------------------------------------------------------

func loadAvg() (l1, l5, l15 float64) {
	fields := strings.Fields(readTrim("/proc/loadavg"))
	if len(fields) >= 3 {
		l1, _ = strconv.ParseFloat(fields[0], 64)
		l5, _ = strconv.ParseFloat(fields[1], 64)
		l15, _ = strconv.ParseFloat(fields[2], 64)
	}
	return
}

func uptimeSec() int64 {
	fields := strings.Fields(readTrim("/proc/uptime"))
	if len(fields) >= 1 {
		f, _ := strconv.ParseFloat(fields[0], 64)
		return int64(f)
	}
	return 0
}

// --- os name + agent detection ----------------------------------------------

func osPretty() string {
	f, err := os.Open("/etc/os-release")
	if err != nil {
		return runtime.GOOS
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "PRETTY_NAME=") {
			return strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), `"`)
		}
	}
	return runtime.GOOS
}

// cachedAgents returns the most recent detection result (refreshed every
// agentRescan by the background loop). No copy: refreshAgents REPLACES the slice
// wholesale (never mutates it in place), so a returned reference is an immutable
// snapshot even if a rescan swaps the slice afterward.
func cachedAgents() []AgentInfo {
	agentMu.Lock()
	defer agentMu.Unlock()
	return agentCache
}

// refreshAgents re-detects installed agent CLIs and updates the cache. Detection
// checks PATH AND a set of common install dirs (so an agent like opencode in
// /usr/local/bin is found even when the daemon's own PATH is minimal).
func refreshAgents() {
	var found []AgentInfo
	for _, name := range knownAgents {
		if path := resolveAgent(name); path != "" {
			found = append(found, AgentInfo{Name: name, Version: agentVersion(path), Path: path})
		}
	}
	agentMu.Lock()
	agentCache = found
	agentMu.Unlock()
}

// resolveAgent returns the path to an agent CLI, checking PATH first then common
// install locations; "" if not installed.
func resolveAgent(name string) string {
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	// LookPath misses installs outside the daemon's (often minimal) $PATH — npm /
	// version-manager dirs. Search the shared agent-install dirs (FIX: gemini
	// detection; same source of truth the spawn PATH augments — see agentpath).
	agentMu.Lock()
	home := agentHome
	agentMu.Unlock()
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	for _, dir := range agentpath.BinDirs(home) {
		if c := filepath.Join(dir, name); isExecutable(c) {
			return c
		}
	}
	return ""
}

func isExecutable(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && !fi.IsDir() && fi.Mode()&0o111 != 0
}

// agentVersion runs `<path> --version` (by absolute path, so PATH is irrelevant).
func agentVersion(path string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, "--version").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(strings.SplitN(string(out), "\n", 2)[0])
}

// ProcRSSBytes returns a process's resident set size (physical memory) in bytes,
// or 0 if unreadable. Reads /proc/<pid>/statm (field 2 = resident pages) × the
// page size — a single cheap read, no sampling. Lets a supervisor see WHICH
// session is eating a node's RAM (per-session attribution, not just host total).
func ProcRSSBytes(pid int) uint64 {
	if pid <= 0 {
		return 0
	}
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/statm")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(b))
	if len(fields) < 2 {
		return 0
	}
	pages, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return 0
	}
	return pages * uint64(os.Getpagesize())
}

// ProcCPUJiffies returns a process's cumulative CPU time (utime+stime, in clock
// ticks) from /proc/<pid>/stat, or 0 if unreadable. Take two samples + the host
// TotalCPUJiffies() delta to derive a CPU %.
func ProcCPUJiffies(pid int) uint64 {
	if pid <= 0 {
		return 0
	}
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return 0
	}
	// The (comm) field can contain spaces/parens, so index AFTER the last ')':
	// proc(5) utime=field 14, stime=field 15 → indices 11/12 of the post-')' split.
	s := string(b)
	rp := strings.LastIndexByte(s, ')')
	if rp < 0 || rp+2 >= len(s) {
		return 0
	}
	fields := strings.Fields(s[rp+2:])
	if len(fields) < 13 {
		return 0
	}
	utime, _ := strconv.ParseUint(fields[11], 10, 64)
	stime, _ := strconv.ParseUint(fields[12], 10, 64)
	return utime + stime
}

// TotalCPUJiffies returns the host's total CPU time (all states) in clock ticks.
func TotalCPUJiffies() uint64 {
	total, _ := cpuTotals()
	return total
}

func readTrim(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}
