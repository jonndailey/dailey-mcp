// Request-scoped identity for the remote (HTTP) entry. The stdio entry never
// enters this context, so api.ts falls through to its module-global/env logic
// there — stdio behavior is unchanged by construction.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestIdentity {
  token: string;
  /** Managed-account scope for THIS request only (X-Dailey-Account). */
  account?: string;
}

export const requestContext = new AsyncLocalStorage<RequestIdentity>();

/** True inside a hosted (HTTP) request; the stdio entry never sets the store. */
export function isHostedRequest(): boolean {
  return requestContext.getStore() !== undefined;
}

/** Answer for tools that read local paths, which on the hosted server would be
 *  the shared pod's own filesystem (security review 2026-10-15, H4). */
export const HOSTED_LOCAL_FILES_UNAVAILABLE = 'Not available on the hosted server. Use the local MCP or the CLI.';
