import { test } from 'node:test';
import assert from 'node:assert';

// Regression coverage for the MCP half of the 2026-09-15 silent-deploy bug:
// dailey_deploy did not forward repo_url, so a zip-bundle redeploy through MCP
// always rebuilt the project's stored git source and reported success. The tool
// must now (1) forward a supplied repo_url in the POST body, (2) omit it when
// absent, and (3) surface deploy-service's `mode` — warning when a zip:// source
// was requested but the deploy came back as git (the exact silent failure).

function makeFakeServer() {
  const handlers = new Map<string, (args: any) => Promise<{ content: Array<{ type: 'text'; text: string }> }>>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, h: (args: any) => any) => {
      handlers.set(name, h);
    },
  };
  return { server, getHandler: (name: string) => handlers.get(name)! };
}

// apiRequest mock that records calls and returns a mode driven by the body,
// mirroring deploy-service: a persisted zip:// source → mode 'zip-redeploy',
// otherwise 'git'.
function makeApiMock(opts: { forceMode?: string } = {}) {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  return {
    calls,
    namedExports: {
      apiRequest: async (method: string, path: string, body?: any) => {
        calls.push({ method, path, body });
        const mode = opts.forceMode
          ?? (typeof body?.repo_url === 'string' && body.repo_url.startsWith('zip://') ? 'zip-redeploy' : 'git');
        return { ok: true, status: 202, data: { build_id: 'bld_1', project: 'my-app', mode, status: 'building' } };
      },
      formatError: (res: any) => JSON.stringify(res),
      textResult: (text: string) => ({ content: [{ type: 'text' as const, text }] }),
      isValidProjectId: (id: string) => /^[0-9a-f-]{8,}$/i.test(id),
      invalidProjectIdResult: (id: string) => ({ content: [{ type: 'text' as const, text: `invalid project id: ${id}` }] }),
    },
  };
}

const PID = 'c0c0eaaf-25a4-11f1-9bf3-fa163e580ccd';

test('dailey_deploy omits repo_url for an ordinary git redeploy and surfaces mode', async (t) => {
  const mock = makeApiMock();
  t.mock.module('../src/api.js', { namedExports: mock.namedExports });

  const { registerProjectTools } = await import('../src/tools/projects.js?t=git');
  const { server, getHandler } = makeFakeServer();
  registerProjectTools(server as any);

  const result = await getHandler('dailey_deploy')({ project_id: PID });
  const text = result.content[0].text;

  const post = mock.calls.find((c) => c.path === '/deploys');
  assert.ok(post, 'must POST /deploys');
  assert.strictEqual(post!.body.project_id, PID);
  assert.strictEqual(post!.body.commit_sha, 'HEAD');
  assert.ok(!('repo_url' in post!.body), 'repo_url must be absent when not supplied');
  assert.match(text, /Source:\s+git/);
  assert.doesNotMatch(text, /⚠/, 'no warning on a plain git deploy');
});

test('dailey_deploy forwards a zip:// bundle source and reports zip-redeploy', async (t) => {
  const mock = makeApiMock();
  t.mock.module('../src/api.js', { namedExports: mock.namedExports });

  const { registerProjectTools } = await import('../src/tools/projects.js?t=zip');
  const { server, getHandler } = makeFakeServer();
  registerProjectTools(server as any);

  const bundle = `zip://deploy-bundles/${PID}/latest.zip`;
  const result = await getHandler('dailey_deploy')({ project_id: PID, repo_url: bundle });
  const text = result.content[0].text;

  const post = mock.calls.find((c) => c.path === '/deploys');
  assert.strictEqual(post!.body.repo_url, bundle, 'repo_url must be forwarded verbatim');
  assert.match(text, /Source:\s+zip-redeploy/);
  assert.doesNotMatch(text, /⚠/, 'no warning when the bundle was used');
});

test('dailey_deploy warns when a zip:// source was requested but the deploy came back git', async (t) => {
  // Platform refused/ignored the zip key (e.g. unchanged or cross-tenant) → mode git.
  const mock = makeApiMock({ forceMode: 'git' });
  t.mock.module('../src/api.js', { namedExports: mock.namedExports });

  const { registerProjectTools } = await import('../src/tools/projects.js?t=mismatch');
  const { server, getHandler } = makeFakeServer();
  registerProjectTools(server as any);

  const bundle = `zip://deploy-bundles/${PID}/latest.zip`;
  const result = await getHandler('dailey_deploy')({ project_id: PID, repo_url: bundle });
  const text = result.content[0].text;

  assert.match(text, /⚠/, 'must warn on zip-requested-but-git-built');
  assert.match(text, /was NOT used/);
});

test('dailey_deploy rejects a malformed project_id before calling the API', async (t) => {
  const mock = makeApiMock();
  t.mock.module('../src/api.js', { namedExports: mock.namedExports });

  const { registerProjectTools } = await import('../src/tools/projects.js?t=badid');
  const { server, getHandler } = makeFakeServer();
  registerProjectTools(server as any);

  const result = await getHandler('dailey_deploy')({ project_id: 'nope' });
  assert.match(result.content[0].text, /invalid project id/);
  assert.strictEqual(mock.calls.length, 0, 'must not hit the API on a bad id');
});
