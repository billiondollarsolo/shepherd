/**
 * Native hook config injection (US-19). Agentd merges narrowly scoped Flock hook
 * files into the runtime user's agent config; the callbacks remain inert without
 * a per-session Flock token environment.
 */
export * from './hook-templates.js';
export * from './config-injection.js';
