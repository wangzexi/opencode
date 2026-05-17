# zexi/dev Fork — What's Different from Upstream

This document records every intentional divergence from `anomalyco/opencode` so
that after each weekly rebase the goals are clear and regressions can be caught
quickly.

---

## How to rebase

The workflow `sync-upstream.yml` runs every Friday and rebases `zexi/dev` onto
upstream automatically. After a rebase, verify the [behavioral invariants](#behavioral-invariants) below.

Manual rebase if needed:

```sh
git fetch upstream
git rebase --onto upstream/dev $(git merge-base HEAD upstream/dev) zexi/dev
```

---

## Fork commits (relative to upstream/dev)

### 1 · Release workflows — `f4bb5ae17`

**Files:** `.github/workflows/zexi-electron.yml`, `.github/workflows/sync-upstream.yml`, `packages/desktop/electron-builder.config.ts`, `packages/script/src/index.ts`

Custom CI that builds and releases signed macOS (arm64 + notarization) and
Windows (x64 + Azure trusted signing) Electron packages on every push to
`zexi/dev`. Releases are tagged `zexi-electron-<stamp>-<sha>`; old releases are
pruned to keep the 3 most recent.

The sync workflow disables all upstream workflows except these two.

**Rebase risk:** Low — touches only `.github/` and build config. Conflicts
typically arise if upstream renames `electron-builder.config.ts`.

---

### 2 · Configure desktop local server access — `78b5d1182`

**Files:** `packages/app/src/components/dialog-select-server.tsx`, `packages/app/src/components/server/server-row.tsx`, `packages/app/src/components/status-popover*.tsx`, `packages/desktop/src/main/{index,ipc,server,sidecar}.ts`, `packages/desktop/src/preload/`, `packages/opencode/src/config/server.ts`, i18n files

**What it does:** Adds UI for users to configure the local Electron-embedded
server's hostname, port, username, and password from within the app. Previously
these could only be set via environment variables. The config is persisted in
Electron's store under `localServerConfig` (see `constants.ts`).

Key additions:
- IPC channels: `get-local-server-config`, `set-local-server-config`
- `getLocalServerConfig() / setLocalServerConfig()` in `server.ts`
- Server dialog revamp in `dialog-select-server.tsx` — includes a local-server
  config panel when running in desktop mode
- Status bar server icon (bottom-left) opens the server selection/config dialog

**Rebase risk:** High — touches many app-layer files. Conflicts are likely if
upstream refactors `status-popover`, `dialog-select-server`, or the desktop
main/preload plumbing.

---

### 3 · Sync opened projects through server events — `7aa32f066`

**Files:** `packages/app/src/context/opened-projects.tsx`, `packages/opencode/src/config/projects.ts`, `packages/opencode/src/server/routes/instance/httpapi/{groups,handlers}/global.ts`, `packages/sdk/js/src/v2/gen/`

**What it does:** Moves opened-project state from scattered per-component state
into a single `OpenedProjectsContext` (Solid.js). The context subscribes to the
`project.opened.updated` server-sent event so all windows/tabs stay in sync
without polling.

Adds server-side API routes under `/global` for listing, opening, closing, and
reordering opened projects. Also extends the JS SDK types accordingly.

**Rebase risk:** Medium — `handlers/global.ts` and the SDK generated files are
common conflict points if upstream adds routes in the same files.

---

### 4 · Keep opened project metadata single-sourced — `02416fa48`

**Files:** `packages/opencode/src/server/shared/opened-projects.ts` (new), `packages/opencode/src/server/shared/opened-projects.sql.ts` (new), `packages/desktop/src/main/{server,ipc,constants}.ts`, `packages/app/src/context/{platform,server,opened-projects}.tsx`, `packages/app/src/pages/layout.tsx`

**What it does:** Persists opened-project metadata (name, icon, commands,
ordering) in the opencode SQLite database via a dedicated `OpenedProjectTable`,
rather than duplicating it across Electron store and server memory. This was a
follow-up fix after the upstream rebase broke the original implementation.

Also stores `localServerConfig` in Electron store (previously it lived only in
memory), fixing the config disappearing on restart.

**Rebase risk:** Medium-High — `opened-projects.ts` is a new file owned by this
fork; conflicts arise only if upstream creates a file at the same path. The
migration SQL file path must stay unique.

---

### 5 · Allow web UI shell without auth — `b8c154e01`

**Files:** `packages/opencode/src/server/shared/public-ui.ts`, `packages/opencode/test/server/httpapi-ui.test.ts`

**What it does:** Static assets (HTML shell, JS bundles, CSS, icons, favicons)
are served without requiring authentication, so a remote browser can load the
app UI shell before the user has entered credentials. API routes remain
protected.

`isPublicUIPath()` returns `true` for:
- `/`, `/index.html`, `/site.webmanifest`, manifest PNGs
- `/assets/*` (JS/CSS bundles)
- `/favicon*`, `/apple-touch-icon*`, `/social-share.*`

**Why this matters:** Without this, a remote browser hitting the server gets a
401 on the very first request and cannot load anything — the user has no way to
enter credentials.

**Rebase risk:** Low — `public-ui.ts` is a small file. Conflict only if upstream
adds its own public-path logic here.

---

### 6 · Serve local web UI in dev mode, suppress auth dialog — `dd426faec`

**Files:** `packages/core/src/flag/flag.ts`, `packages/desktop/src/main/server.ts`, `packages/opencode/src/server/routes/instance/httpapi/middleware/authorization.ts`, `packages/opencode/src/server/shared/ui.ts`

**What it does:**

**a) Bearer auth scheme** (`authorization.ts`)
Changed `WWW-Authenticate` response header from `Basic` to `Bearer`. Chrome and
Firefox show a native credentials popup for `Basic` on every 401, including XHR
responses from the SPA. `Bearer` suppresses this popup while keeping the server
fully functional — it still reads and validates `Authorization: Basic` headers
sent by the desktop app.

**b) Local build serving in dev mode** (`flag.ts`, `server.ts`, `ui.ts`)
Added two env flags:
- `OPENCODE_DEV_UI_DIR` — if set, the server serves static files from this
  directory (with SPA index.html fallback) instead of proxying to
  `https://app.opencode.ai`.
- `OPENCODE_DEV_UI_URL` — overrides the upstream proxy base URL.

In desktop dev mode (`!app.isPackaged`), `preferAppEnv()` automatically sets
`OPENCODE_DEV_UI_DIR` to `packages/app/dist`. This means remote browsers
connecting to the Electron-local server see the locally built UI (with fork
customizations like the server icon) instead of the production CDN version.

**Prerequisite:** `packages/app` must be built before starting Electron in dev
mode:
```sh
cd packages/app && bun run build
```

**Rebase risk:** Low for `authorization.ts` (one constant). Medium for `ui.ts`
if upstream restructures `serveUIEffect` or `serveEmbeddedUIEffect`.

---

## Behavioral invariants

After every rebase, verify these before merging/releasing:

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Remote browser opens `http://<host>:4096/` (no credentials) | 200, loads UI shell (no browser auth popup) |
| 2 | Remote browser fetches `/favicon-96x96-v3.png` | 200 (no auth required) |
| 3 | SPA fetches `/global/config` without credentials | 401 with `WWW-Authenticate: Bearer …` (not `Basic`) |
| 4 | Desktop app bottom-left shows server icon with current server URL | Visible, clickable |
| 5 | Clicking server icon opens server config dialog | Dialog appears, shows local-server config panel |
| 6 | Setting local server credentials and restarting → credentials persist | Config survives restart |
| 7 | Opening a project in one browser tab → other tabs update | `project.opened.updated` event triggers sync |
| 8 | Dev mode: remote browser sees fork UI (server icon in bottom left) | Not the upstream `app.opencode.ai` version |

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
