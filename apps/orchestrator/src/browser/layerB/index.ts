/**
 * Layer B — agent-driving via injected opaque CDP endpoint (US-26, FR-B2).
 *
 * Re-exports the env-injection helpers so session-create can wire Layer B via a
 * single import path (`../browser/layerB/index.js`), matching the auth/sessions/
 * hooks module layout.
 */
export {
  buildLayerBSessionEnv,
  opaqueCdpEndpointForSession,
  doNotLaunchBrowserInstruction,
  LAYER_B_MECHANISM,
  type LayerBSession,
} from './inject-cdp-endpoint.js';
