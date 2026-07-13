import { test } from 'node:test';
import assert from 'node:assert';

// Minimal fake McpServer: registerWordPressLiveEditTools calls
// server.tool(name, description, schema, handler) three times — capture the
// handler for each tool by name.
function makeFakeServer() {
  const handlers = new Map<string, (args: any) => Promise<{ content: Array<{ type: 'text'; text: string }> }>>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, h: (args: any) => any) => {
      handlers.set(name, h);
    },
  };
  return { server, getHandler: (name: string) => handlers.get(name)! };
}

const IDENTITY = {
  project_id: 'proj_wp1',
  slug: 'my-blog',
  domain: 'my-blog.dailey.cloud',
  env: 'prod',
  db_name: 'wp_myblog',
  namespace: 'cust-abc',
};

// Shared active-account state + a router that mimics the two-phase server:
// a mutating POST without confirm_token returns a preview envelope; the same
// POST WITH confirm_token executes.
function makeApiMock() {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  let active: string | undefined;
  return {
    calls,
    namedExports: {
      apiRequest: async (method: string, path: string, body?: any) => {
        calls.push({ method, path, body });

        // read-only routes
        if (path.endsWith('/wp/files/list')) {
          return { ok: true, status: 200, data: { path: body?.path ?? '/', entries: [{ name: 'style.css', type: 'file', size: 12, path: '/style.css' }] } };
        }
        if (path.endsWith('/wp/files/read')) {
          return { ok: true, status: 200, data: { path: body.path, encoding: 'utf8', content: 'body{}', size: 6 } };
        }
        if (path.endsWith('/wp/media/list')) {
          return { ok: true, status: 200, data: { path: body?.path ?? '/', entries: [] } };
        }

        // mutating routes — two-phase
        const mutating = ['/wp/files/write', '/wp/files/delete', '/wp/media/upload', '/wp/cli'];
        if (mutating.some((m) => path.endsWith(m))) {
          const isCliRead = path.endsWith('/wp/cli') && !body?.allow_write;
          if (isCliRead) {
            return { ok: true, status: 200, data: { stdout: 'https://my-blog.dailey.cloud', stderr: '', exit_code: 0, write: false } };
          }
          if (!body?.confirm_token) {
            return { ok: true, status: 200, data: { preview: true, confirm_token: 'tok_abc123', identity: IDENTITY, change: { op: path } } };
          }
          // executed
          return { ok: true, status: 200, data: { ok: true, path: body.path, snapshot_id: 'snap_1', confirm_token_used: body.confirm_token } };
        }

        throw new Error(`unexpected apiRequest call: ${method} ${path}`);
      },
      formatError: (res: any) => JSON.stringify(res),
      textResult: (text: string) => ({ content: [{ type: 'text' as const, text }] }),
      jsonResult: (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }),
      getActiveAccount: () => active,
      setActiveAccount: (v: string | undefined) => { active = v && v.trim() ? v.trim() : undefined; },
    },
  };
}

test('dailey_wp_files list posts to /wp/files/list and surfaces active_account', async (t) => {
  const mock = makeApiMock();
  t.mock.module('../src/api.js', { namedExports: mock.namedExports });

  const { registerWordPressLiveEditTools } = await import('../src/tools/wordpress-live-edit.js?t=files-list');
  const { server, getHandler } = makeFakeServer();
  registerWordPressLiveEditTools(server as any);

  const result = await getHandler('dailey_wp_files')({ project: 'proj_wp1', action: 'list', account: 'acme' });
  const parsed = JSON.parse(result.content[0].text);

  assert.strictEqual(mock.calls[0].path, '/projects/proj_wp1/wp/files/list');
  assert.strictEqual(mock.calls[0].method, 'POST');
  assert.strictEqual(parsed.active_account, 'acme');
  assert.strictEqual(parsed.entries[0].name, 'style.css');
});

test('dailey_wp_files write is two-phase: preview (no token) then execute (with token)', async (t) => {
  const mock = makeApiMock();
  t.mock.module('../src/api.js', { namedExports: mock.namedExports });

  const { registerWordPressLiveEditTools } = await import('../src/tools/wordpress-live-edit.js?t=files-write');
  const { server, getHandler } = makeFakeServer();
  registerWordPressLiveEditTools(server as any);

  // Phase 1 — no confirm_token → preview with identity echo + token, no mutation.
  const preview = await getHandler('dailey_wp_files')({ project: 'proj_wp1', action: 'write', path: '/style.css', content: 'body{color:red}' });
  const text = preview.content[0].text;
  assert.match(text, /PREVIEW ONLY/);
  assert.match(text, /my-blog\.dailey\.cloud/, 'echoes domain');
  assert.match(text, /wp_myblog/, 'echoes db_name');
  assert.match(text, /confirm_token: tok_abc123/);
  const writeCall = mock.calls.find((c) => c.path.endsWith('/wp/files/write'));
  assert.strictEqual(writeCall!.body.confirm_token, undefined, 'phase 1 must NOT send a confirm_token');

  // Phase 2 — relay the real token → executes.
  const executed = await getHandler('dailey_wp_files')({ project: 'proj_wp1', action: 'write', path: '/style.css', content: 'body{color:red}', confirm_token: 'tok_abc123' });
  const parsed = JSON.parse(executed.content[0].text);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.snapshot_id, 'snap_1');
  assert.strictEqual(parsed.confirm_token_used, 'tok_abc123');
});

test('dailey_wp_media upload is two-phase', async (t) => {
  const mock = makeApiMock();
  t.mock.module('../src/api.js', { namedExports: mock.namedExports });

  const { registerWordPressLiveEditTools } = await import('../src/tools/wordpress-live-edit.js?t=media');
  const { server, getHandler } = makeFakeServer();
  registerWordPressLiveEditTools(server as any);

  const preview = await getHandler('dailey_wp_media')({ project: 'proj_wp1', action: 'upload', filename: 'logo.png', content_base64: 'AAAA' });
  assert.match(preview.content[0].text, /PREVIEW ONLY/);
  assert.match(preview.content[0].text, /confirm_token: tok_abc123/);

  const executed = await getHandler('dailey_wp_media')({ project: 'proj_wp1', action: 'upload', filename: 'logo.png', content_base64: 'AAAA', confirm_token: 'tok_abc123' });
  const parsed = JSON.parse(executed.content[0].text);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.active_account, 'self');
});

test('dailey_wp_cli read-only runs immediately; write is two-phase', async (t) => {
  const mock = makeApiMock();
  t.mock.module('../src/api.js', { namedExports: mock.namedExports });

  const { registerWordPressLiveEditTools } = await import('../src/tools/wordpress-live-edit.js?t=cli');
  const { server, getHandler } = makeFakeServer();
  registerWordPressLiveEditTools(server as any);

  // read-only: no allow_write → executes immediately
  const read = await getHandler('dailey_wp_cli')({ project: 'proj_wp1', args: ['option', 'get', 'siteurl'] });
  const readParsed = JSON.parse(read.content[0].text);
  assert.strictEqual(readParsed.exit_code, 0);
  assert.strictEqual(readParsed.write, false);
  assert.strictEqual(mock.calls[0].body.args[0], 'option');

  // write: allow_write true, no token → preview
  const preview = await getHandler('dailey_wp_cli')({ project: 'proj_wp1', args: ['plugin', 'activate', 'akismet'], allow_write: true });
  assert.match(preview.content[0].text, /PREVIEW ONLY/);
  assert.match(preview.content[0].text, /confirm_token: tok_abc123/);

  // write with token → executes
  const executed = await getHandler('dailey_wp_cli')({ project: 'proj_wp1', args: ['plugin', 'activate', 'akismet'], allow_write: true, confirm_token: 'tok_abc123' });
  const parsed = JSON.parse(executed.content[0].text);
  assert.strictEqual(parsed.ok, true);
});
