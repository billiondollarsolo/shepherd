// Code generated from agentd/COMPATIBILITY.json; DO NOT EDIT.
// Regenerate with: go generate ./compatibility

// Package compatibility exposes the release-owned flock-agentd compatibility policy.
package compatibility

// Policy describes the daemon versions, protocols, and authenticated capabilities
// accepted by a Shepherd release.
type Policy struct {
	SchemaVersion             int
	MinimumDaemonVersion      string
	PreferredProtocolVersion  int
	SupportedProtocolVersions []int
	RequiredCapabilities      []string
	SupportMinorReleases      int
	SupportMinimumDays        int
}

// Current returns an independent copy of the generated release policy.
func Current() Policy {
	return Policy{
		SchemaVersion:             1,
		MinimumDaemonVersion:      "0.3.0",
		PreferredProtocolVersion:  2,
		SupportedProtocolVersions: []int{2},
		RequiredCapabilities:      []string{"pty", "resize", "scrollback", "status", "node-info"},
		SupportMinorReleases:      1,
		SupportMinimumDays:        90,
	}
}
