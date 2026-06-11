/**
 * @flock/shared — domain types, the StatusEnum + transition helpers, and the
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
