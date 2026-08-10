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
