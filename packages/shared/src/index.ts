/**
 * @flock/shared — domain types and policy, the StatusEnum + transition helpers, and the
 * zod-validated REST/WS contracts (spec §6, §7, §8). Imported by BOTH apps;
 * no domain type or contract is ever duplicated outside this package.
 */
export * from './status.js';
export * from './agentEvents.js';
export * from './domain.js';
export * from './contracts.js';
export * from './hooks.js';
export * from './secrets.js';
export * from './browser-layerb.js';
export * from './browser-input.js';
export * from './screencast-controls.js';
export * from './shell-nav.js';
export * from './display-status.js';
export * from './project-layout.js';
export * from './project-pens.js';
export * from './launcher-presets.js';
export * from './stage-scope.js';
export * from './user-preferences.js';
export * from './backup.js';
export * from './diagnostics.js';
