// Request-scoped identity for the remote (HTTP) entry. The stdio entry now
// also opens a short-lived store around each tool call so apiRequest can
// attach usage headers (tool name + transport) without changing token or
// account resolution.
import { AsyncLocalStorage } from 'node:async_hooks';

const TOOL_RE = /^[\w.-]{1,64}$/;

export interface RequestIdentity {
  token: string;
  /** Managed-account scope for THIS request only (X-Dailey-Account). */
  account?: string;
  /** Current MCP tool name only — never arguments. */
  tool?: string;
  /** How this MCP server is being spoken to. */
  transport?: 'stdio' | 'http';
}

export const requestContext = new AsyncLocalStorage<RequestIdentity>();

/** True inside a hosted (HTTP) request. Stdio tool calls may also have a
 *  store (for usage headers) but are not hosted, so local-file tools stay
 *  available on the desktop client. */
export function isHostedRequest(): boolean {
  const store = requestContext.getStore();
  // HTTP entry always has a store. Stdio tool calls also open a short-lived
  // store for usage headers, tagged transport: 'stdio', and are not hosted.
  // A store without a transport is treated as hosted so existing HTTP callers
  // and tests that only set { token } keep the local-file guard.
  if (!store) return false;
  return store.transport !== 'stdio';
}

/**
 * Accept a tool name for usage headers and logs. Exact match only: never
 * strip punctuation, so an arguments blob cannot collapse into the header.
 */
export function mcpToolName(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  const value = String(Array.isArray(raw) ? raw[0] : raw).trim();
  return TOOL_RE.test(value) ? value : undefined;
}

/** Answer for tools that read local paths, which on the hosted server would be
 *  the shared pod's own filesystem (security review 2026-10-15, H4). */
export const HOSTED_LOCAL_FILES_UNAVAILABLE = 'Not available on the hosted server. Use the local MCP or the CLI.';
