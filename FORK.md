# zexi/dev Fork — What's Different from Upstream

This document records every intentional divergence from `anomalyco/opencode` so
that after each weekly rebase the goals are clear and regressions can be caught
quickly.

---

## How to rebase

The workflow `sync-upstream.yml` runs every Friday and opens a PR rebasing
`zexi/dev` onto upstream automatically.

Manual rebase onto a clean branch:

```sh
git fetch upstream
git checkout -b zexi/dev-clean upstream/dev
git merge --squash zexi/dev
# resolve conflicts, then commit in logical groups (see commits below)
```

---

## Fork commits (relative to upstream/dev)

### 1 · Release workflows — `dfa2df240`

**Files:** `.github/workflows/zexi-electron.yml`, `.github/workflows/sync-upstream.yml`

Custom CI that builds and releases signed macOS (arm64 + notarization) and
Windows (x64 + Azure trusted signing) Electron packages on every push to
`zexi/dev`. Releases are tagged `zexi-electron-<stamp>-<sha>`; old releases are
pruned to keep the 3 most recent.

The sync workflow disables all upstream workflows except these two.

**Rebase risk:** Low — touches only `.github/`. Conflicts only if upstream
renames its own workflow files.

---

### 2 · Configure desktop local server access and sync opened projects — `bd776bfa3`

**Files:** `packages/app/src/components/dialog-select-server.tsx`, `packages/app/src/components/server/server-row.tsx`, `packages/app/src/components/status-popover*.tsx`, `packages/desktop/src/main/{index,ipc,server,sidecar,constants}.ts`, `packages/desktop/src/preload/`, `packages/opencode/src/config/{server,projects}.ts`, `packages/opencode/src/server/shared/opened-projects{,.sql}.ts`, `packages/opencode/src/server/routes/instance/httpapi/{groups,handlers}/global.ts`, `packages/opencode/migration/20260511170500_opened_projects_db/migration.sql`, `packages/sdk/js/src/v2/gen/`, i18n files

**What it does:**

**a) Local server config UI**
Adds UI for users to configure the local Electron-embedded server's hostname,
port, username, and password from within the app. Config is persisted in
Electron's store under `localServerConfig`. Key IPC channels:
`get-local-server-config`, `set-local-server-config`.

**b) Opened projects sync**
Moves opened-project state into a single `OpenedProjectsContext` (Solid.js)
backed by a server-side SQLite table (`OpenedProjectTable`). All windows/tabs
subscribe to the `project.opened.updated` SSE event and stay in sync without
polling. Server-side API routes under `/global` handle list, open, close, and
reorder.

**Rebase risk:** High — touches many app-layer files. Most likely conflict
points: `status-popover.tsx`, `dialog-select-server.tsx`, `handlers/global.ts`,
and the SDK generated files.

---

### 3 · Embed and serve web UI from sidecar — `54660edfa`

**Files:** `packages/core/src/flag/flag.ts`, `packages/desktop/electron-builder.config.ts`, `packages/desktop/electron.vite.config.ts`, `packages/desktop/scripts/prebuild.ts`, `packages/opencode/src/config/server.ts`, `packages/opencode/src/server/shared/{public-ui,ui}.ts`

**What it does:**
Bundles the web SPA into the sidecar binary at build time via a generated
module (`opencode-web-ui.gen.ts`). The sidecar serves it directly, with a
priority chain:

1. Embedded bundle (`opencode-web-ui.gen.ts`) — production
2. Local directory (`OPENCODE_DEV_UI_DIR`) — dev mode, set automatically in
   Electron dev to `packages/app/dist`
3. Proxy to `https://app.opencode.ai` (override with `OPENCODE_DEV_UI_URL`) —
   fallback

Static assets (HTML shell, JS/CSS bundles, icons, favicons) under
`isPublicUIPath()` are served without authentication so a remote browser can
load the UI shell before entering credentials.

**Prerequisite for dev:** build `packages/app` first:
```sh
cd packages/app && bun run build
```

**Rebase risk:** Medium — `ui.ts` conflicts if upstream restructures
`serveUIEffect`. `flag.ts` conflicts if upstream adds flags at the same
location.

---

### 4 · Serve SPA at any subpath without auth, display auth-required page on 401 — `7bac50fd8`

**Files:** `packages/opencode/src/server/routes/instance/httpapi/middleware/authorization.ts`, `packages/opencode/src/server/routes/instance/httpapi/server.ts`, `packages/app/src/pages/error.tsx`, `packages/app/src/pages/session.tsx`, `packages/app/src/i18n/{en,zh,zht}.ts`, `packages/opencode/test/server/httpapi-ui.test.ts`

**What it does:**

**a) SPA catch-all serves without auth**
The `/*` route loads unconditionally (no credentials check) so the browser can
bootstrap the SPA shell at any subpath. API routes under `/global/*` and
instance routes remain fully protected.

**b) Bearer auth scheme**
`WWW-Authenticate` is `Bearer realm="Secure Area"` instead of `Basic`. This
suppresses the browser's native credential popup on 401 while keeping the server
fully functional — it still reads and validates `Authorization: Basic` headers
sent by the desktop app.

**c) Auth-required error page**
On 401 the SPA shows a localized "Authentication required" page with a manual
"Go to home" button, breaking the infinite redirect loop that previously occurred
when the app auto-navigated from `/` to the last opened project.

**d) /global/health probe**
Allows unauthenticated health probes so the SPA can discover the server before
the user enters credentials. If credentials are supplied but wrong, returns 401.

**Rebase risk:** Low for `authorization.ts` (small, self-contained). Medium for
`error.tsx` if upstream changes the error page structure.

---

### 5 · Cap diff size to prevent SQLite/V8 crash on large files — `c37061538`

**Files:** `packages/opencode/src/tool/apply_patch.ts`, `packages/opencode/src/tool/edit.ts`

Truncates patch/diff strings before storing them to prevent SQLite blob limits
and V8 string size limits from crashing the process on very large file edits.

**Rebase risk:** Low — isolated tool change.

---

## Behavioral invariants

After every rebase, verify these before merging/releasing:

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Remote browser opens `http://<host>:4096/` (no credentials) | 200, loads UI shell (no browser auth popup) |
| 2 | Remote browser fetches `/favicon-96x96-v3.png` | 200 (no auth required) |
| 3 | SPA fetches `/global/config` without credentials | 401 with `WWW-Authenticate: Bearer …` (not `Basic`) |
| 4 | Navigate to `http://<host>:4096/<project>/session/<id>` without credentials | Loads SPA shell, shows auth-required page, no infinite redirect |
| 5 | Desktop app bottom-left shows server icon with current server URL | Visible, clickable |
| 6 | Clicking server icon opens server config dialog | Dialog appears, shows local-server config panel in desktop mode |
| 7 | Setting local server credentials and restarting → credentials persist | Config survives restart |
| 8 | Opening a project in one browser tab → other tabs update | `project.opened.updated` event triggers sync |
| 9 | Dev mode: remote browser sees fork UI (server icon in bottom left) | Not the upstream `app.opencode.ai` version |

Quick automated check (run against a live local server on port 4096):

```sh
# Root → 200
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4096/
# Favicon → 200
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4096/favicon-96x96-v3.png
# API → 401 Bearer (not Basic)
curl -sI http://127.0.0.1:4096/global/config | grep -i www-authenticate
```

Expected output: `200`, `200`, `www-authenticate: Bearer realm="Secure Area"`.
