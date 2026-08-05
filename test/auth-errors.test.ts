import { test } from 'node:test';
import assert from 'node:assert';

/**
 * REGRESSION — 2026-08-04.
 *
 * A customer's agent tried to file a support ticket while their CLI was logged
 * in and `dailey whoami` worked. It got back:
 *
 *   { error_code: "DAILEY_AUTH_REQUIRED",
 *     message: "Not authenticated",
 *     remediation: "Run `dailey auth setup` in your terminal" }
 *
 * That advice was wrong. There is exactly ONE credential store: `dailey login`
 * and `dailey auth setup` both call setToken(), writing the same `token` key in
 * the same config file this server reads. The user was told to redo what they
 * had already done, gave up, and emailed support by hand — defeating the point
 * of having a support tool at all.
 *
 * Two things these tests hold:
 *   401 and 403 must never share a message. One means "fix your credential",
 *   the other means "your credential is fine, you may not do this".
 *   And the remediation must never claim the two commands differ.
 */

// authError is pure: whether a credential exists is an argument, not something
// read from this machine's disk. The first draft of these tests read the real
// CLI token and passed or failed on whoever ran them.
const { authError, formatError } = await import('../src/api.js');

test('401 with no credential says so, and does not imply two sign-ins', () => {
  const out = authError(401, false);
  assert.equal(out.error_code, 'DAILEY_AUTH_REQUIRED');
  assert.match(out.message, /No Dailey credential/i);
  assert.match(out.remediation, /dailey login/, 'must mention the command people actually run');
  assert.match(out.remediation, /same credential/i, 'must say the two commands are equivalent');
});

test('401 WITH a credential reports expiry, not absence', () => {
  const out = authError(401, true);
  assert.equal(out.error_code, 'DAILEY_AUTH_EXPIRED');
  assert.match(out.message, /rejected|expired/i);
  assert.doesNotMatch(out.message, /No Dailey credential/i,
    'saying "not authenticated" to someone holding a token is what caused the incident');
});

test('REGRESSION: 403 must NOT tell you to re-authenticate', () => {
  const out = authError(403, true, 'plan does not permit this');
  assert.equal(out.error_code, 'DAILEY_FORBIDDEN');
  assert.match(out.message, /signed in/i, 'a 403 means the credential worked');
  assert.match(out.remediation, /will not help/i, 'must say re-authenticating is pointless');
  assert.doesNotMatch(out.remediation, /dailey auth setup/,
    're-auth advice on a 403 is what sent the customer in circles');
});

test('403 surfaces the server’s own reason when it gives one', () => {
  const out = authError(403, true, 'manager grant required');
  assert.match(out.message, /manager grant required/);
});

test('401 and 403 never produce the same error_code', () => {
  const a = authError(401, true), b = authError(403, true);
  assert.notEqual(a.error_code, b.error_code);
  assert.notEqual(a.remediation, b.remediation);
});

test('other statuses are untouched', () => {
  const out = formatError({ ok: false, status: 500, data: { error: 'boom' } } as any);
  assert.match(out, /Error \(500\)/);
  assert.doesNotMatch(out, /DAILEY_AUTH/);
});
