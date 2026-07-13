import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'agentd/COMPATIBILITY.json'), 'utf8'));
const quote = (value) => JSON.stringify(value);
const ints = (values) => values.join(', ');
const strings = (values) => values.map(quote).join(', ');
const generated = `// Code generated from agentd/COMPATIBILITY.json; DO NOT EDIT.
// Regenerate with: go generate ./compatibility

// Package compatibility exposes the release-owned flock-agentd compatibility policy.
package compatibility

// Policy describes the daemon versions, protocols, and authenticated capabilities
// accepted by a Shepherd release.
type Policy struct {
\tSchemaVersion             int
\tMinimumDaemonVersion      string
\tPreferredProtocolVersion  int
\tSupportedProtocolVersions []int
\tRequiredCapabilities      []string
\tSupportMinorReleases      int
\tSupportMinimumDays        int
}

// Current returns an independent copy of the generated release policy.
func Current() Policy {
\treturn Policy{
\t\tSchemaVersion:             ${manifest.schemaVersion},
\t\tMinimumDaemonVersion:      ${quote(manifest.minimumDaemonVersion)},
\t\tPreferredProtocolVersion:  ${manifest.preferredProtocolVersion},
\t\tSupportedProtocolVersions: []int{${ints(manifest.supportedProtocolVersions)}},
\t\tRequiredCapabilities:      []string{${strings(manifest.requiredCapabilities)}},
\t\tSupportMinorReleases:      ${manifest.supportWindow.minorReleases},
\t\tSupportMinimumDays:        ${manifest.supportWindow.minimumDays},
\t}
}
`;
const destination = resolve(root, 'agentd/compatibility/policy_gen.go');
if (process.argv.includes('--check')) {
  if (readFileSync(destination, 'utf8') !== generated) {
    throw new Error('agentd/compatibility/policy_gen.go is stale; run pnpm agentd:compatibility');
  }
} else {
  writeFileSync(destination, generated);
}
