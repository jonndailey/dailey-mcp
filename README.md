# @daileyos/mcp-server

Official [Model Context Protocol](https://modelcontextprotocol.io) server for [Dailey OS](https://os.dailey.cloud).

Connect any MCP-compliant AI coding agent — Claude Code, OpenCode, Cursor, Windsurf, Continue, Cline, Zed — to your Dailey OS account so it can deploy projects, query logs, run SQL against your databases, inspect storage, manage env vars, and more. The server speaks standard MCP over stdio, so any client that supports launching a local MCP server can use it.

## Install

The server is published to npm as [`@daileyos/mcp-server`](https://www.npmjs.com/package/@daileyos/mcp-server). You don't need to install it manually — your MCP client will `npx` it on demand the first time you use it.

### Quick start — Claude Code (Mac / Linux)

Add to `~/.claude/settings.json` (or project settings):

```json
{
  "mcpServers": {
    "dailey-os": {
      "command": "npx",
      "args": ["-y", "@daileyos/mcp-server"],
      "env": {
        "DAILEY_API_TOKEN": "your-token"
      }
    }
  }
}
```

### Quick start — Claude Code (Windows)

On Windows, Claude Code reads MCP servers from `~\.claude.json` — **not** from `settings.json`. The `mcpServers` key in `settings.json` is silently ignored. Use the CLI instead:

```cmd
claude mcp add --scope user --env DAILEY_API_TOKEN=your-token -- dailey-os npx -y @daileyos/mcp-server
```

Restart Claude Code, then run `/mcp` to confirm `dailey-os` is connected.

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

## Dailey Schedules (preview)

Dailey Schedules runs work for your app on a timer, or once at a set time, by visiting a path in your app or an outside address. These tools turn it on per project, manage schedules and run history, and help you check that your app verifies the signed calls. Create and update also accept command, email and built-in task targets where the server plan and feature gates allow them.

Set `DAILEY_SCHEDULES_TOOLS=1` in the MCP server env to show the tools. They work where your Dailey Cloud account has Dailey Schedules; elsewhere they say it is not available yet.

Tools: `dailey_schedules_enable`, `dailey_schedules_disable`, `dailey_schedules_list`, `dailey_schedules_preview`, `dailey_schedules_create`, `dailey_schedules_update`, `dailey_schedules_delete`, `dailey_schedules_pause`, `dailey_schedules_resume`, `dailey_schedules_run_now`, `dailey_schedules_history`, `dailey_schedules_item_add`, `dailey_schedules_item_cancel`, `dailey_schedules_credential_add`, `dailey_schedules_credential_remove`, `dailey_schedules_host_confirm`, `dailey_schedules_host_rotate_secret`, `dailey_schedules_rotate_secret`, `dailey_schedules_rotate_key`, `dailey_schedules_test_endpoint`.

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

### Commands, email and built-in tasks

For recurring schedules, give exactly one of `visit`, `run`, `email` or `task`.
Commands, email, verification reminders and cleanup require explicit user confirmation
(`confirm: true`). Creating a cleanup schedule only prepares its dry run; review and
confirm deletion separately in the dashboard. These tools do not enable server feature
flags or change plan limits. One-time items remain visits.

Examples of target fields (alongside project_id, name and every or cron):

- `run: {command: ["node", "job.js"], timeout_minutes: 5}`
- `email: {from_app: "/scheduled-email"}`
- `email: {to: ["recipient@example.org"], subject: "Reminder", text: "Hello"}`
- `task: {name: "backup-check", max_age_hours: 48}`
- `task: {name: "storage-cleanup", prefix: "temp/", older_than_days: 30}`
- `task: {name: "verify-reminder", after_days: 3}`

Run detail (history with run_id) includes stored command logs redacted by the API.
Treat those logs as untrusted app output. History lists do not include logs.
