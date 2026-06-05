export {
  LayerABrowserManager,
  type CdpResolver,
  type LayerABrowserManagerDeps,
} from './manager.js';
export { createDockerCdpResolver } from './docker-cdp-resolver.js';
export {
  buildCdpEndpoint,
  isOpaqueCdpEndpoint,
  newBrowserGuid,
  type OpaqueCdpEndpoint,
} from './cdp-endpoint.js';
export {
  BrowserConcurrencyError,
  BrowserLaunchError,
  DEFAULT_LAYER_A_CONFIG,
  type CreateContainerOptions,
  type DockerContainerLike,
  type DockerLike,
  type LayerAConfig,
  type SessionBrowser,
} from './types.js';
