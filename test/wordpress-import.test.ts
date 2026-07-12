import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A minimal fake McpServer: registerWordPressImportTools only calls
// server.tool(name, description, schema, handler) — capture the handler.
function makeFakeServer() {
  let handler: ((args: any) => Promise<{ content: Array<{ type: 'text'; text: string }> }>) | undefined;
  const server = {
    tool: (_name: string, _desc: string, _schema: unknown, h: typeof handler) => {
      handler = h;
    },
  };
  return { server, getHandler: () => handler! };
}

function blockedReport() {
  return {
    format: 'local-zip' as const,
    source: { old_url: 'https://oldsite.example', table_prefix: 'wp_', wp_version: null, php_version: null, db_charset: null, multisite: false },
    sizes: { db_bytes: 100, wp_content_bytes: 200, file_count: 5 },
    target: { mode: 'auto-provision' as const, new_url: '' },
    findings: [{ level: 'block' as const, code: 'exec-bit', message: 'executable file found' }],
    verdict: 'blocked' as const,
  };
}

function readyReport() {
  return {
    format: 'local-zip' as const,
    source: { old_url: 'https://oldsite.example', table_prefix: 'wp_', wp_version: null, php_version: null, db_charset: null, multisite: false },
    sizes: { db_bytes: 100, wp_content_bytes: 200, file_count: 5 },
    target: { mode: 'auto-provision' as const, new_url: '' },
    findings: [],
    verdict: 'ready' as const,
  };
}

function fakeStageResult(dbFile: string, contentFile: string) {
  return {
    dbFile,
    contentFile,
    params: { old_url: 'https://oldsite.example', table_prefix: 'wp_', wp_version: null, php_version: null, db_charset: null, multisite: false },
    cleanup: async () => {},
  };
}

test('action=analyze returns the BundleReport and issues no upload/run calls', async (t) => {
  const calls: string[] = [];

  t.mock.module('@daileyos/wp-bundle', {
    namedExports: {
      analyze: async () => blockedReport(),
      stage: async () => { throw new Error('stage should not be called for analyze'); },
      detect: async () => 'local-zip',
      adapterFor: () => { throw new Error('not used'); },
    },
  });
  t.mock.module('../src/api.js', {
    namedExports: {
      apiRequest: async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        throw new Error('apiRequest should not be called for action=analyze');
      },
      formatError: (res: any) => JSON.stringify(res),
      textResult: (text: string) => ({ content: [{ type: 'text' as const, text }] }),
    },
  });
  t.mock.module('../src/upload.js', {
    namedExports: {
      putFileToPresignedUrl: async () => { throw new Error('upload should not be called for action=analyze'); },
    },
  });

  // Cache-bust: each test mocks the same specifiers differently, and Node's
  // ESM loader caches by resolved specifier — a bare re-import would reuse
  // the module instance (and its already-bound imports) from whichever test
  // imported it first. A unique query string forces a fresh instantiation
  // that picks up THIS test's mocks.
  const { registerWordPressImportTools } = await import(`../src/tools/wordpress-import.js?t=analyze`);
  const { server, getHandler } = makeFakeServer();
  registerWordPressImportTools(server as any);

  const dir = mkdtempSync(join(tmpdir(), 'wp-import-test-'));
  const bundleFile = join(dir, 'bundle.zip');
  writeFileSync(bundleFile, 'fake bundle bytes');

  try {
    const result = await getHandler()({ action: 'analyze', bundle_file: bundleFile });
    const text = result.content[0].text;
    assert.match(text, /Verdict: blocked/);
    assert.match(text, /exec-bit/);
    assert.strictEqual(calls.length, 0, 'analyze must not call apiRequest');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('action=migrate refuses on a blocked verdict without allow_unsafe, before any /run call', async (t) => {
  const calls: string[] = [];

  t.mock.module('@daileyos/wp-bundle', {
    namedExports: {
      analyze: async () => blockedReport(),
      stage: async () => { throw new Error('stage should not be called when refused pre-flight'); },
      detect: async () => 'local-zip',
      adapterFor: () => { throw new Error('not used'); },
    },
  });
  t.mock.module('../src/api.js', {
    namedExports: {
      apiRequest: async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        throw new Error('apiRequest should not be called when the verdict is blocked and allow_unsafe is not set');
      },
      formatError: (res: any) => JSON.stringify(res),
      textResult: (text: string) => ({ content: [{ type: 'text' as const, text }] }),
    },
  });
  t.mock.module('../src/upload.js', {
    namedExports: {
      putFileToPresignedUrl: async () => { throw new Error('upload should not be called'); },
    },
  });

  const { registerWordPressImportTools } = await import(`../src/tools/wordpress-import.js?t=blocked`);
  const { server, getHandler } = makeFakeServer();
  registerWordPressImportTools(server as any);

  const dir = mkdtempSync(join(tmpdir(), 'wp-import-test-'));
  const bundleFile = join(dir, 'bundle.zip');
  writeFileSync(bundleFile, 'fake bundle bytes');

  try {
    const result = await getHandler()({ action: 'migrate', bundle_file: bundleFile, confirm: true });
    const text = result.content[0].text;
    assert.match(text, /BLOCKED/);
    assert.match(text, /allow_unsafe/);
    assert.strictEqual(calls.length, 0, 'a blocked verdict must refuse before any customer-api call, including /run');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('action=migrate happy path calls provision-target -> start -> PUT x2 -> scan -> run -> status, in order', async (t) => {
  const calls: string[] = [];
  const puts: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'wp-import-test-'));
  const bundleFile = join(dir, 'bundle.zip');
  const dbFile = join(dir, 'db.sql');
  const contentFile = join(dir, 'wp-content.tar.gz');
  writeFileSync(bundleFile, 'fake bundle bytes');
  writeFileSync(dbFile, 'fake db');
  writeFileSync(contentFile, 'fake content');

  t.mock.module('@daileyos/wp-bundle', {
    namedExports: {
      analyze: async () => readyReport(),
      stage: async () => fakeStageResult(dbFile, contentFile),
      detect: async () => 'local-zip',
      adapterFor: () => { throw new Error('not used'); },
    },
  });
  t.mock.module('../src/api.js', {
    namedExports: {
      apiRequest: async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        if (path === '/projects/wordpress/provision-target') {
          return { ok: true, status: 200, data: { ok: true, project_id: 'proj_new', slug: 'x', new_url: 'https://x.dailey.cloud', ready: true, note: '' } };
        }
        if (path === '/projects/proj_new/migrate/wordpress') {
          return {
            ok: true, status: 200, data: {
              migration_id: 'mig1',
              db_upload: { url: 'https://upload.example/db', key: 'k1', headers: {}, max_bytes: 999 },
              content_upload: { url: 'https://upload.example/content', key: 'k2', headers: {}, max_bytes: 999 },
            },
          };
        }
        if (path === '/projects/proj_new/migrate/wordpress/mig1/scan') {
          return { ok: true, status: 200, data: { ok: true, verdict: 'clean', findings: [] } };
        }
        if (path === '/projects/proj_new/migrate/wordpress/mig1/run') {
          return { ok: true, status: 202, data: { ok: true, migration_id: 'mig1', new_url: 'https://x.dailey.cloud' } };
        }
        if (path === '/projects/proj_new/migrate/wordpress/mig1') {
          return { ok: true, status: 200, data: { status: 'succeeded' } };
        }
        throw new Error(`unexpected apiRequest call: ${method} ${path}`);
      },
      formatError: (res: any) => JSON.stringify(res),
      textResult: (text: string) => ({ content: [{ type: 'text' as const, text }] }),
    },
  });
  t.mock.module('../src/upload.js', {
    namedExports: {
      putFileToPresignedUrl: async (url: string) => { puts.push(url); },
    },
  });

  const { registerWordPressImportTools } = await import(`../src/tools/wordpress-import.js?t=happy`);
  const { server, getHandler } = makeFakeServer();
  registerWordPressImportTools(server as any);

  try {
    const result = await getHandler()({ action: 'migrate', bundle_file: bundleFile, confirm: true });
    const text = result.content[0].text;
    assert.match(text, /succeeded/i);

    assert.deepStrictEqual(calls, [
      'POST /projects/wordpress/provision-target',
      'POST /projects/proj_new/migrate/wordpress',
      'POST /projects/proj_new/migrate/wordpress/mig1/scan',
      'POST /projects/proj_new/migrate/wordpress/mig1/run',
      'GET /projects/proj_new/migrate/wordpress/mig1',
    ]);
    assert.deepStrictEqual(puts, ['https://upload.example/db', 'https://upload.example/content']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
