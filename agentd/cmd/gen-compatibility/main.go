// Command gen-compatibility renders COMPATIBILITY.json into the Go release
// policy consumed by every Go agentd client.
//
// The JSON stays the single source of truth: its path is baked into the
// orchestrator image, the release workflow and the docs, so it cannot move into
// the package for a go:embed. Generating from it — and asserting no drift in
// compatibility's tests — is what keeps the Go copy honest.
//
// Run via `go generate ./compatibility`.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"go/format"
	"os"
)

const (
	sourcePath = "../COMPATIBILITY.json"
	outputPath = "policy_gen.go"
)

type policyJSON struct {
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

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "gen-compatibility: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	raw, err := os.ReadFile(sourcePath)
	if err != nil {
		return err
	}
	var policy policyJSON
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&policy); err != nil {
		return fmt.Errorf("decode %s: %w", sourcePath, err)
	}
	source, err := format.Source(render(policy))
	if err != nil {
		return err
	}
	return os.WriteFile(outputPath, source, 0o644)
}

func render(p policyJSON) []byte {
	var b bytes.Buffer
	fmt.Fprint(&b, "// Code generated from agentd/COMPATIBILITY.json; DO NOT EDIT.\n")
	fmt.Fprint(&b, "// Regenerate with: go generate ./compatibility\n\n")
	fmt.Fprint(&b, "// Package compatibility exposes the release-owned flock-agentd compatibility policy.\n")
	fmt.Fprint(&b, "package compatibility\n\n")
	fmt.Fprint(&b, "// Policy describes the daemon versions, protocols, and authenticated capabilities\n")
	fmt.Fprint(&b, "// accepted by a Flock release.\n")
	fmt.Fprint(&b, "type Policy struct {\n")
	fmt.Fprint(&b, "\tSchemaVersion             int\n")
	fmt.Fprint(&b, "\tMinimumDaemonVersion      string\n")
	fmt.Fprint(&b, "\tPreferredProtocolVersion  int\n")
	fmt.Fprint(&b, "\tSupportedProtocolVersions []int\n")
	fmt.Fprint(&b, "\tRequiredCapabilities      []string\n")
	fmt.Fprint(&b, "\tSupportMinorReleases      int\n")
	fmt.Fprint(&b, "\tSupportMinimumDays        int\n")
	fmt.Fprint(&b, "}\n\n")
	fmt.Fprint(&b, "// Current returns an independent copy of the generated release policy.\n")
	fmt.Fprint(&b, "func Current() Policy {\n")
	fmt.Fprint(&b, "\treturn Policy{\n")
	fmt.Fprintf(&b, "\t\tSchemaVersion:             %d,\n", p.SchemaVersion)
	fmt.Fprintf(&b, "\t\tMinimumDaemonVersion:      %q,\n", p.MinimumDaemonVersion)
	fmt.Fprintf(&b, "\t\tPreferredProtocolVersion:  %d,\n", p.PreferredProtocolVersion)
	fmt.Fprintf(&b, "\t\tSupportedProtocolVersions: %#v,\n", p.SupportedProtocolVersions)
	fmt.Fprintf(&b, "\t\tRequiredCapabilities:      %#v,\n", p.RequiredCapabilities)
	fmt.Fprintf(&b, "\t\tSupportMinorReleases:      %d,\n", p.SupportWindow.MinorReleases)
	fmt.Fprintf(&b, "\t\tSupportMinimumDays:        %d,\n", p.SupportWindow.MinimumDays)
	fmt.Fprint(&b, "\t}\n")
	fmt.Fprint(&b, "}\n")
	return b.Bytes()
}
