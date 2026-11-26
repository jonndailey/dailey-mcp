# Changelog

Changes to `@daileyos/mcp-server`, newest first. Earlier releases are recorded
in git tags (`v1.2.0` through `v1.22.0`) and their commit messages.

## 1.22.2 (2026-11-26)

Usage-header release so Core and customer-api can record MCP last-used
time, call volume, top tools, and transport, without arguments or secrets.

### Added
- Sends `X-Dailey-MCP-Tool` (tool name only) and `X-Dailey-MCP-Transport`
  (`stdio` or `http`) on authenticated customer-api requests (#28).

## 1.22.1 (2026-11-24)

Reconciles the two lines of work so one release carries both:
`feat/schedules-tools` (the source of the published 1.22.0) merged with `main`.

### Fixed
- `dailey_deploy_status` shows the real deployed date, and says `unknown`
  instead of `never` when the platform has no date or SHA to report (#25).
- `dailey_deploy_status` shows a `Restart reason:` line when the platform
  reports why an app was restarted or redeployed (#25).

### Carried forward from 1.22.0 (already published, not yet on main)
- Dailey Schedules tools, hidden unless `DAILEY_SCHEDULES_TOOLS=1` (#20).
- Verified exact-image rollback and artifact capture (`dailey_rollback_artifact`),
  first published in 1.21.10.

### Unchanged
- Security fixes from #21 (H2, H3, H4) are in both parents and remain.
