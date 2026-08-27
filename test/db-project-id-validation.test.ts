import { test } from 'node:test';
import assert from 'node:assert';

// Regression test for [issue:dailey-mcp:3]: dailey_db_* tools used to
// interpolate `project_id` straight into a URL path template
// (`/projects/${project_id}/...`) with no validation or encoding. A crafted
// project_id containing `../` segments escapes the intended
// `/api/projects/:id/...` prefix once fetch()'s URL parser normalizes it —
// e.g. `../../admin/x` turns `.../api/projects/../../admin/x/database` into
// `.../admin/x/database`. Every dailey_db_* handler now validates project_id
// against the same UUID-shaped pattern diagnose.ts already uses, and rejects
// anything else BEFORE any apiRequest call.

// Minimal fake McpServer: registerDbTools calls server.tool(name, desc,
// schema, handler) once per tool; capture the handler for each tool by name.
function makeFakeServer() {
  const handlers = new Map<string, (args: any) => Promise<{ content: Array<{ type: 'text'; text: string }> }>>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, h: (args: any) => any) => {
      handlers.set(name, h);
    },
  };
  return { server, getHandler: (name: string) => handlers.get(name)! };
}

function makeApiMock() {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  return {
    calls,
    namedExports: {
      apiRequest: async (method: string, path: string, body?: any) => {
        calls.push({ method, path, body });
        return { ok: true, status: 200, data: {} };
      },
      formatError: (res: any) => JSON.stringify(res),
      textResult: (text: string) => ({ content: [{ type: 'text' as const, text }] }),
      // Real implementations — same pattern as the "looksLikeId" gate diagnose.ts
      // already used, reused here rather than re-invented per-tool.
      isValidProjectId: (id: string) => /^[0-9a-f-]{8,}$/i.test(id),
      invalidProjectIdResult: (id: string) => ({
        content: [{ type: 'text' as const, text: `Error: "${id}" is not a valid project ID.` }],
      }),
    },
  };
}

const TRAVERSAL_ID = '../../admin/secret';
const VALID_ID = 'a3ee3742-1111-2222-3333-444455556666';

test('dailey_db_info rejects a path-traversal-shaped project_id without calling apiRequest', async (t) => {
  const mock = makeApiMock();
  t.mock.module('../src/api.js', { namedExports: mock.namedExports });

  const { registerDbTools } = await import('../src/tools/db.js?t=info-reject');
  const { server, getHandler } = makeFakeServer();
  registerDbTools(server as any);

  const result = await getHandler('dailey_db_info')({ project_id: TRAVERSAL_ID });
  assert.strictEqual(mock.calls.length, 0, 'apiRequest must not be called for an invalid project_id');
  assert.match(result.content[0].text, /not a valid project ID/);
});

test('dailey_db_info accepts a UUID-shaped project_id and calls apiRequest with it', async (t) => {
  const mock = makeApiMock();
  t.mock.module('../src/api.js', { namedExports: mock.namedExports });

  const { registerDbTools } = await import('../src/tools/db.js?t=info-accept');
  const { server, getHandler } = makeFakeServer();
  registerDbTools(server as any);

  await getHandler('dailey_db_info')({ project_id: VALID_ID });
  assert.strictEqual(mock.calls.length, 1);
  assert.strictEqual(mock.calls[0].path, `/projects/${VALID_ID}/database`);
});

test('dailey_db_exec rejects a path-traversal-shaped project_id without calling apiRequest', async (t) => {
  const mock = makeApiMock();
  t.mock.module('../src/api.js', { namedExports: mock.namedExports });

  const { registerDbTools } = await import('../src/tools/db.js?t=exec-reject');
  const { server, getHandler } = makeFakeServer();
  registerDbTools(server as any);

  const result = await getHandler('dailey_db_exec')({ project_id: TRAVERSAL_ID, sql: 'SELECT 1' });
  assert.strictEqual(mock.calls.length, 0, 'apiRequest must not be called for an invalid project_id');
  assert.match(result.content[0].text, /not a valid project ID/);
});

test('dailey_db_tunnel rejects a path-traversal-shaped project_id for every action without calling apiRequest', async (t) => {
  const mock = makeApiMock();
  t.mock.module('../src/api.js', { namedExports: mock.namedExports });

  const { registerDbTools } = await import('../src/tools/db.js?t=tunnel-reject');
  const { server, getHandler } = makeFakeServer();
  registerDbTools(server as any);

  const handler = getHandler('dailey_db_tunnel');
  for (const action of ['open', 'close', 'list'] as const) {
    const result = await handler({ project_id: TRAVERSAL_ID, action, session_id: 'sess_1' });
    assert.match(result.content[0].text, /not a valid project ID/);
  }
  assert.strictEqual(mock.calls.length, 0, 'apiRequest must not be called for an invalid project_id');
});

test('dailey_db_import rejects a path-traversal-shaped project_id without calling apiRequest', async (t) => {
  const mock = makeApiMock();
  t.mock.module('../src/api.js', { namedExports: mock.namedExports });

  const { registerDbTools } = await import('../src/tools/db.js?t=import-reject');
  const { server, getHandler } = makeFakeServer();
  registerDbTools(server as any);

  const result = await getHandler('dailey_db_import')({
    project_id: TRAVERSAL_ID,
    table: 't',
    mode: 'insert',
    format: 'json',
    payload: '[]',
    dry_run: true,
  });
  assert.strictEqual(mock.calls.length, 0, 'apiRequest must not be called for an invalid project_id');
  assert.match(result.content[0].text, /not a valid project ID/);
});
