# @daileyos/mcp-server

Official [Model Context Protocol](https://modelcontextprotocol.io) server for [Dailey OS](https://os.dailey.cloud).

Connect any MCP-compliant AI coding agent — Claude Code, OpenCode, Cursor, Windsurf, Continue, Cline, Zed — to your Dailey OS account so it can deploy projects, query logs, run SQL against your databases, inspect storage, manage env vars, and more. The server speaks standard MCP over stdio, so any client that supports launching a local MCP server can use it.

## Install

The server is published to npm as [`@daileyos/mcp-server`](https://www.npmjs.com/package/@daileyos/mcp-server). You don't need to install it manually — your MCP client will `npx` it on demand the first time you use it.

### Quick start — Claude Code

Add to `~/.claude/settings.json` (or project settings):

```json
{
  "mcpServers": {
    "dailey-os": {
      "command": "npx",
      "args": ["-y", "@daileyos/mcp-server"],
      "env": {
        "DAILEY_EMAIL": "you@example.com",
        "DAILEY_PASSWORD": "your-password"
      }
    }
  }
}
```

### Quick start — OpenCode (free)

Add to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "dailey-os": {
      "type": "local",
      "command": ["npx", "-y", "@daileyos/mcp-server"],
      "enabled": true,
      "environment": {
        "DAILEY_EMAIL": "you@example.com",
        "DAILEY_PASSWORD": "your-password"
      }
    }
  }
}
```

OpenCode namespaces MCP tools with the server id, so tools are exposed as `dailey-os_dailey_whoami`, `dailey-os_dailey_list_projects`, etc.

**Full setup guide, model recommendations, and performance tuning:** https://docs.dailey.cloud/docs/mcp

## Authentication

Two modes, in priority order:

- **`DAILEY_API_TOKEN`** (preferred) — long-lived token, rotatable from the Dailey OS dashboard, can't leak your account password
- **`DAILEY_EMAIL` + `DAILEY_PASSWORD`** — falls back to logging in on startup

Set either via the `env` / `environment` block of your client's MCP config. If both are present, the token is used.

## Available tools

30 tools across 7 categories: projects & deployment, Docker images & marketplace, database, storage, env & domains, billing & usage, and platform info. See the [full list in the docs](https://docs.dailey.cloud/docs/mcp#available-tools).

Highlights:
- `dailey_list_projects` — list all your projects
- `dailey_app_logs` — tail pod logs
- `dailey_db_recall` — **read-only** SQL queries against your project database (INSERT/UPDATE/DELETE are blocked at the server)
- `dailey_project_credentials` — reveal auto-generated DB passwords, JWT secrets, etc.
- `dailey_deploy_multi` — trigger a multi-process deploy
- `dailey_run_image` — deploy any Docker Hub image as a new project

## Development

```bash
git clone git@github.com:jonndailey/dailey-mcp.git
cd dailey-mcp
npm install
npm run build

# Test locally against your Dailey OS account
export DAILEY_EMAIL=you@example.com
export DAILEY_PASSWORD=...
node dist/index.js
```

The server talks MCP over stdio — stdin/stdout. To test it directly without going through an MCP client, send JSON-RPC messages like:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
```

### Project layout

```
src/
├── index.ts         # stdio entry point + tool registration
├── api.ts           # REST client with token refresh
└── tools/
    ├── auth.ts      # dailey_whoami
    ├── projects.ts  # list, info, create, delete, services, resources, credentials
    ├── deploy.ts    # deploy_multi, deploy_history, rollback, app_logs
    ├── scale.ts     # scale replicas
    ├── env.ts       # env_vars list/set/delete
    ├── domains.ts   # domains list/add/remove
    ├── db.ts        # db_info, db_schema, db_recall, db_migrations
    ├── storage.ts   # storage_info, list_objects, presign_upload/download
    ├── images.ts    # run_image, inspect_image, marketplace_catalog
    ├── platform.ts  # platform_info
    ├── billing.ts   # billing, billing_estimate
    └── usage.ts     # resource usage
```

## Versioning

This git history begins at `1.0.2`. Versions `1.0.0` and `1.0.1` were published to npm from a pre-git working directory; their source corresponds to the state of the package.json metadata on npm but isn't tagged in this repo.

From `1.0.2` onward, every release is tagged and publishes via GitHub Actions on push of a `v*` tag.

## Contributing

Bug reports, PRs, and new tool suggestions welcome. File an issue before starting a large change so we can discuss the tool's scope and schema.

## License

MIT — see [LICENSE](LICENSE).
