import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestContext } from '../src/context.js';

// Security review 2026-10-15, H4 (10-14 M2). Belt and braces behind the
// registration flag: even if a local-file WordPress tool is ever registered on
// the hosted server again, its handler must refuse inside a hosted request
// (requestContext store set) before touching the filesystem or the API.
const HOSTED_MESSAGE = 'Not available on the hosted server. Use the local MCP or the CLI.';

type Handler = (args: any) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;

function makeFakeServer() {
  let handler: Handler | undefined;
  const server = { tool: (_n: string, _d: string, _s: unknown, h: Handler) => { handler = h; } };
  return { server, getHandler: () => handler! };
}

function mockDeps(t: any, calls: string[]) {
  t.mock.module('../src/api.js', {
    namedExports: {
      apiRequest: async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        return { ok: false, status: 500, data: { error: 'unexpected call' } };
      },
      formatError: (res: any) => JSON.stringify(res),
      textResult: (text: string) => ({ content: [{ type: 'text' as const, text }] }),
      isValidProjectId: (id: string) => /^[0-9a-f-]{8,}$/i.test(id),
      invalidProjectIdResult: (id: string) => ({ content: [{ type: 'text' as const, text: `invalid project id: ${id}` }] }),
    },
  });
  t.mock.module('../src/upload.js', {
    namedExports: {
      putFileToPresignedUrl: async (_url: string, path: string) => { calls.push(`upload ${path}`); },
    },
  });
  t.mock.module('@daileyos/wp-bundle', {
    namedExports: {
      analyze: async (path: string) => { calls.push(`analyze ${path}`); throw new Error('analyze reached'); },
      stage: async (path: string) => { calls.push(`stage ${path}`); throw new Error('stage reached'); },
      detect: async () => 'local-zip',
      adapterFor: () => { throw new Error('not used'); },
    },
  });
}

const PROJECT = '0123abcd-0000-4000-8000-000000000000';

test('dailey_wordpress_migrate refuses inside a hosted request: no file or API access', async (t) => {
  const calls: string[] = [];
  mockDeps(t, calls);
  const { registerWordPressMigrateTools } = await import('../src/tools/wordpress-migrate.js?t=hosted');
  const { server, getHandler } = makeFakeServer();
  registerWordPressMigrateTools(server as any);
  const result = await requestContext.run({ token: 'hosted-token' }, () => getHandler()({
    project_id: PROJECT, action: 'migrate', db_file: '/etc/passwd', content_file: '/app/package.json', old_url: 'https://x.example',
  }));
  assert.equal(result.content[0].text, HOSTED_MESSAGE);
  assert.deepEqual(calls, []);
});

test('dailey_wordpress_import refuses inside a hosted request: no analyze/stage/upload/API', async (t) => {
  const calls: string[] = [];
  mockDeps(t, calls);
  const { registerWordPressImportTools } = await import('../src/tools/wordpress-import.js?t=hosted');
  const { server, getHandler } = makeFakeServer();
  registerWordPressImportTools(server as any);
  const result = await requestContext.run({ token: 'hosted-token' }, () => getHandler()({
    action: 'analyze', bundle_file: '/etc/passwd',
  }));
  assert.equal(result.content[0].text, HOSTED_MESSAGE);
  assert.deepEqual(calls, []);
});

test('outside a hosted request (local stdio) both tools still run', async (t) => {
  const calls: string[] = [];
  mockDeps(t, calls);
  const { registerWordPressMigrateTools } = await import('../src/tools/wordpress-migrate.js?t=local');
  const { registerWordPressImportTools } = await import('../src/tools/wordpress-import.js?t=local');
  const m = makeFakeServer(); registerWordPressMigrateTools(m.server as any);
  const i = makeFakeServer(); registerWordPressImportTools(i.server as any);

  const mig = await m.getHandler()({
    project_id: PROJECT, action: 'migrate', db_file: '/nonexistent/db.sql', content_file: '/nonexistent/c.zip', old_url: 'https://x.example',
  });
  assert.equal(mig.content[0].text, 'File not found: /nonexistent/db.sql');

  const imp = await i.getHandler()({ action: 'analyze', bundle_file: '/nonexistent/bundle.zip' });
  assert.equal(imp.content[0].text, 'File not found: /nonexistent/bundle.zip');
});
