/** Parse user-entered KEY=VALUE lines; comments and malformed rows are ignored. */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const value = line.trim();
    if (!value || value.startsWith('#')) continue;
    const separator = value.indexOf('=');
    if (separator <= 0) continue;
    const key = value.slice(0, separator).trim();
    if (key) out[key] = value.slice(separator + 1).trim();
  }
  return out;
}

export function formatEnvText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}
