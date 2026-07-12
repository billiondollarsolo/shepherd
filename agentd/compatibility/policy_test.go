package compatibility

import (
	"bytes"
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

//go:generate go run ../cmd/gen-compatibility

// TestPolicyMatchesCompatibilityJSON is the enforcement behind policy_gen.go's
// "DO NOT EDIT" header. COMPATIBILITY.json is the release-owned contract and the
// Go policy is a copy of it — and an unenforced copy of a contract is exactly how
// the v1→v2 protocol break reached a client. Editing the JSON without running
// `go generate ./compatibility` fails here rather than in production.
func TestPolicyMatchesCompatibilityJSON(t *testing.T) {
	raw, err := os.ReadFile("../COMPATIBILITY.json")
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		SchemaVersion             int      `json:"schemaVersion"`
		MinimumDaemonVersion      string   `json:"minimumDaemonVersion"`
		PreferredProtocolVersion  int      `json:"preferredProtocolVersion"`
		SupportedProtocolVersions []int    `json:"supportedProtocolVersions"`
		RequiredCapabilities      []string `json:"requiredCapabilities"`
		SupportWindow             struct {
			MinorReleases int `json:"minorReleases"`
			MinimumDays   int `json:"minimumDays"`
		} `json:"supportWindow"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&file); err != nil {
		t.Fatalf("decode COMPATIBILITY.json: %v", err)
	}

	want := Policy{
		SchemaVersion:             file.SchemaVersion,
		MinimumDaemonVersion:      file.MinimumDaemonVersion,
		PreferredProtocolVersion:  file.PreferredProtocolVersion,
		SupportedProtocolVersions: file.SupportedProtocolVersions,
		RequiredCapabilities:      file.RequiredCapabilities,
		SupportMinorReleases:      file.SupportWindow.MinorReleases,
		SupportMinimumDays:        file.SupportWindow.MinimumDays,
	}
	if got := Current(); !reflect.DeepEqual(got, want) {
		t.Fatalf("policy_gen.go is stale — run `go generate ./compatibility`\n got: %+v\nwant: %+v", got, want)
	}
}

// The policy the daemon ships must be internally coherent, or a client can
// negotiate a protocol the release does not actually accept.
func TestPolicyIsSelfConsistent(t *testing.T) {
	p := Current()
	if len(p.SupportedProtocolVersions) == 0 {
		t.Fatal("no supported protocol versions")
	}
	found := false
	for _, v := range p.SupportedProtocolVersions {
		if v == p.PreferredProtocolVersion {
			found = true
		}
	}
	if !found {
		t.Errorf("preferred protocol %d is not in supported %v",
			p.PreferredProtocolVersion, p.SupportedProtocolVersions)
	}
	if len(p.RequiredCapabilities) == 0 {
		t.Error("no required capabilities")
	}
	if p.MinimumDaemonVersion == "" {
		t.Error("no minimum daemon version")
	}
}
