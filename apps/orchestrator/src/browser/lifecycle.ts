import type { SessionBrowser } from './layerA/index.js';

/** Least-privilege lifecycle seam shared by direct development and the production worker. */
export interface BrowserLifecycle {
  get(sessionId: string): SessionBrowser | undefined;
  launch(sessionId: string): Promise<SessionBrowser>;
  stop(sessionId: string): Promise<boolean>;
  reap(): Promise<string[]>;
  stopAll(): Promise<void>;
}
