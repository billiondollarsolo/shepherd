// Package compat documents and enforces minimum peer versions for shep-tui.
package compat

import (
	"fmt"
	"strconv"
	"strings"

	agentcompat "github.com/billiondollarsolo/flock/agentd/compatibility"
)

// CheckAgentd validates agentd protocol negotiation results.
// proto is the negotiated protocolVersion from the hello reply.
// daemonVersion is informational (semver-ish string); empty is allowed.
func CheckAgentd(protocol int, daemonVersion string, capabilities []string) error {
	policy := agentcompat.Current()
	if !containsInt(policy.SupportedProtocolVersions, protocol) {
		return fmt.Errorf(
			"agentd protocol %d is unsupported (accepted: %s); upgrade flock-agentd%s",
			protocol, joinInts(policy.SupportedProtocolVersions), versionSuffix(daemonVersion),
		)
	}
	comparison, ok := compareSemver(daemonVersion, policy.MinimumDaemonVersion)
	if !ok {
		return fmt.Errorf("agentd version %q is invalid; upgrade flock-agentd to >= %s",
			daemonVersion, policy.MinimumDaemonVersion)
	}
	if comparison < 0 {
		return fmt.Errorf("agentd %s is below supported minimum %s; upgrade flock-agentd",
			daemonVersion, policy.MinimumDaemonVersion)
	}
	available := make(map[string]struct{}, len(capabilities))
	for _, capability := range capabilities {
		available[capability] = struct{}{}
	}
	var missing []string
	for _, capability := range policy.RequiredCapabilities {
		if _, ok := available[capability]; !ok {
			missing = append(missing, capability)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("agentd is missing required capabilities %s; upgrade flock-agentd",
			strings.Join(missing, ", "))
	}
	return nil
}

func containsInt(values []int, wanted int) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func joinInts(values []int) string {
	parts := make([]string, len(values))
	for i, value := range values {
		parts[i] = strconv.Itoa(value)
	}
	return strings.Join(parts, ", ")
}

func compareSemver(left, right string) (int, bool) {
	a, aPre, ok := parseStrictSemver(left)
	if !ok {
		return 0, false
	}
	b, bPre, ok := parseStrictSemver(right)
	if !ok {
		return 0, false
	}
	for i := range a {
		if a[i] < b[i] {
			return -1, true
		}
		if a[i] > b[i] {
			return 1, true
		}
	}
	if aPre != bPre {
		if aPre {
			return -1, true
		}
		return 1, true
	}
	return 0, true
}

func parseStrictSemver(value string) ([3]int, bool, bool) {
	var out [3]int
	core := strings.SplitN(strings.TrimSpace(value), "+", 2)[0]
	partsWithPrerelease := strings.SplitN(core, "-", 2)
	core = partsWithPrerelease[0]
	prerelease := len(partsWithPrerelease) == 2 && partsWithPrerelease[1] != ""
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return out, false, false
	}
	for i, part := range parts {
		if part == "" || (len(part) > 1 && part[0] == '0') {
			return out, false, false
		}
		value, err := strconv.Atoi(part)
		if err != nil || value < 0 {
			return out, false, false
		}
		out[i] = value
	}
	return out, prerelease, true
}

func versionSuffix(v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return ""
	}
	return " (daemon " + v + ")"
}

func parseLeadingVersion(s string) (major, minor int, ok bool) {
	s = strings.TrimPrefix(s, "v")
	s = strings.TrimPrefix(s, "V")
	// Take first token (before space or +metadata).
	if i := strings.IndexAny(s, " \t+"); i >= 0 {
		s = s[:i]
	}
	parts := strings.Split(s, ".")
	if len(parts) == 0 || parts[0] == "" {
		return 0, 0, false
	}
	maj, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, 0, false
	}
	min := 0
	if len(parts) > 1 {
		// Strip non-numeric suffix from minor (e.g. "1-rc1").
		mp := parts[1]
		for j, r := range mp {
			if r < '0' || r > '9' {
				mp = mp[:j]
				break
			}
		}
		if mp != "" {
			min, _ = strconv.Atoi(mp)
		}
	}
	return maj, min, true
}
