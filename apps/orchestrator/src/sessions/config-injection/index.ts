/**
 * Native hook config injection (US-19). Agentd merges narrowly scoped Shepherd hook
 * files into the runtime user's agent config; the callbacks remain inert without
 * a per-session Shepherd token environment.
 */
export * from './hook-templates.js';
export * from './config-injection.js';
