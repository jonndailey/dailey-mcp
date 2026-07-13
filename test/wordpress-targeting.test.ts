import { test } from 'node:test';
import assert from 'node:assert';

// Minimal fake McpServer: registerWordPressTargetingTools calls
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

// Shared active-account state so setActiveAccount/getActiveAccount behave like
// the real session-scoped store while under mock.
function makeApiMock() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  let active: string | undefined;
  return {
    calls,
    getActive: () => active,
    namedExports: {
      apiRequest: async (method: string, path: string, body?: unknown) => {
        calls.push({ method, path, body });
        if (path === '/projects') {
          return { ok: true, status: 200, data: { id: 'proj_wp1', name: (body as any).name, slug: 'my-blog', status: 'pending', repo_url: (body as any).repo_url, build_id: 'b1' } };
        }
        if (path === '/projects/wp/list') {
          return { ok: true, status: 200, data: { projects: [
            { project_id: 'proj_wp1', slug: 'my-blog', domain: 'my-blog.dailey.cloud', env: 'prod', db_name: 'wp_myblog', namespace: 'cust-abc', active_account: active ?? null },
          ] } };
        }
        if (path === '/projects/wp/resolve?ref=my-blog') {
          return { ok: true, status: 200, data: { project_id: 'proj_wp1', slug: 'my-blog', domain: 'my-blog.dailey.cloud', env: 'prod', db_name: 'wp_myblog', namespace: 'cust-abc', active_account: active ?? null } };
        }
        if (path === '/projects/wp/resolve?ref=ghost') {
          return { ok: false, status: 404, data: { error: 'not found' } };
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

test('dailey_create_wordpress POSTs /projects with the hardened WP catalog body and returns admin URL + account', async (t) => {
  const mock = makeApiMock();
  t.mock.module('../src/api.js', { namedExports: mock.namedExports });

  const { registerWordPressTargetingTools } = await import('../src/tools/wordpress-targeting.js?t=create');
  const { server, getHandler } = makeFakeServer();
  registerWordPressTargetingTools(server as any);

  const result = await getHandler('dailey_create_wordpress')({ name: 'My Blog', account: 'acme' });
  const text = result.content[0].text;

  const post = mock.calls.find((c) => c.path === '/projects');
  assert.ok(post, 'must POST /projects');
  assert.deepStrictEqual(post!.body, {
    name: 'My Blog',
    repo_url: 'wordpress:6-apache',
    needs_database: true,
    needs_storage: true,
  });
  assert.match(text, /https:\/\/my-blog\.dailey\.cloud\/wp-admin/);
  assert.match(text, /WORDPRESS_ADMIN_PASSWORD/);
  assert.match(text, /Account:\s+acme/, 'surfaces the effective account');
});

test('dailey_wp_list calls GET /projects/wp/list and surfaces active_account + projects', async (t) => {
  const mock = makeApiMock();
  t.mock.module('../src/api.js', { namedExports: mock.namedExports });

  const { registerWordPressTargetingTools } = await import('../src/tools/wordpress-targeting.js?t=list');
  const { server, getHandler } = makeFakeServer();
  registerWordPressTargetingTools(server as any);

  const result = await getHandler('dailey_wp_list')({ account: 'acme' });
  const parsed = JSON.parse(result.content[0].text);

  assert.deepStrictEqual(mock.calls.map((c) => `${c.method} ${c.path}`), ['GET /projects/wp/list']);
  assert.strictEqual(parsed.active_account, 'acme');
  assert.strictEqual(parsed.count, 1);
  assert.strictEqual(parsed.projects[0].slug, 'my-blog');
});

test('dailey_wp_target echoes the resolved identity for a valid ref', async (t) => {
  const mock = makeApiMock();
  t.mock.module('../src/api.js', { namedExports: mock.namedExports });

  const { registerWordPressTargetingTools } = await import('../src/tools/wordpress-targeting.js?t=target-ok');
  const { server, getHandler } = makeFakeServer();
  registerWordPressTargetingTools(server as any);

  const result = await getHandler('dailey_wp_target')({ project: 'my-blog' });
  const parsed = JSON.parse(result.content[0].text);

  assert.strictEqual(parsed.resolved, true);
  assert.strictEqual(parsed.target.project_id, 'proj_wp1');
  assert.strictEqual(parsed.target.db_name, 'wp_myblog');
  assert.strictEqual(parsed.target.domain, 'my-blog.dailey.cloud');
  assert.match(parsed.confirm, /db=wp_myblog/);
});

test('dailey_wp_target returns a clear not-found on 404 pointing at dailey_wp_list', async (t) => {
  const mock = makeApiMock();
  t.mock.module('../src/api.js', { namedExports: mock.namedExports });

  const { registerWordPressTargetingTools } = await import('../src/tools/wordpress-targeting.js?t=target-404');
  const { server, getHandler } = makeFakeServer();
  registerWordPressTargetingTools(server as any);

  const result = await getHandler('dailey_wp_target')({ project: 'ghost', account: 'acme' });
  const parsed = JSON.parse(result.content[0].text);

  assert.strictEqual(parsed.resolved, false);
  assert.strictEqual(parsed.active_account, 'acme');
  assert.match(parsed.message, /No WordPress project matching 'ghost'/);
  assert.match(parsed.message, /dailey_wp_list/);
});
