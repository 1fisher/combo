# combo

<div align="center">

[![CI / Release](https://github.com/1fisher/combo/actions/workflows/release.yml/badge.svg)](https://github.com/1fisher/combo/actions/workflows/release.yml)
[![Release](https://img.shields.io/github/v/release/1fisher/combo)](https://github.com/1fisher/combo/releases)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Last Commit](https://img.shields.io/github/last-commit/1fisher/combo)](https://github.com/1fisher/combo)

🌐 Language: **English** | [简体中文](./README.zh-CN.md)

**An all-in-one desktop tool with a built-in combo-cli agent.**

combo is an open-source Agent IDE desktop app. It drives
[combo-cli](crates/combo-cli) (combo's own rig-powered agent) from a unified
UI, letting you run multiple sessions concurrently across project workspaces
and watch tool calls and output in real time.

A Tauri v2 desktop shell + React 19 / TypeScript frontend embeds combo-cli's
`serve` mode directly (in-process axum, listening on `127.0.0.1:18236` by
default, auto-incrementing if the port is taken) — there is no separate
reverse-proxy process anymore, and the frontend always faces a single,
unified REST + SSE contract (`/v1/*`).

</div>

---

## Features

- 🧠 **combo-cli single backend** — a rig-based multi-provider agent
  (deepseek / opencode-zen / zhipu / openrouter...) exposing REST + SSE via
  the rune-compatible protocol. Serve mode replaces everything the old
  combo-proxy reverse proxy used to do.
- 💬 **Concurrent sessions** — open multiple sessions per workspace at the
  same time, with live SSE pushes and state sharded by `sessionId`.
- 🛠️ **Tool calls & permission prompts** — agent tool calls, permission
  requests, and questions surface as modal queues in the UI, approvable /
  rejectable one by one.
- 📂 **Built-in file browsing & editing** — serve provides local file I/O
  (directory listing / reading / atomic writes); the frontend's
  FileExplorer + EditorPane can view and edit workspace files directly.
- 🖥️ **Runs in a plain browser** — the frontend depends on no Tauri API;
  `npm run dev` gives you a fully debuggable app in the browser.
- 🔌 **In-process embedding** — the Tauri shell calls combo-cli serve as a
  library (same-process axum service): no child process to babysit, crashes
  are desktop crashes, and it shuts down with the app.
- 🌊 **SSE streaming pass-through** — the service never buffers streaming
  responses; tokens reach the frontend character by character.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    Tauri Webview (React / TS)                │
│   fetch / EventSource                                        │
└──────────────────────────┬───────────────────────────────────┘
                           │  http://127.0.0.1:18236(+1)/v1/*
                           ▼
┌──────────────────────────────────────────────────────────────┐
│           combo-cli serve (in-process axum, embedded)        │
│   · REST + double-layer SSE envelope (rune-compatible)       │
│   · CORS + SSE streaming pass-through                        │
│   · Local file I/O / git / session sqlite mirror             │
│   · Token auth + host dir browsing / terminal WS / tunnel /  │
│     skills                                                   │
└──────────────────────────────────────────────────────────────┘
```

Three components:

| Component | Directory | Description |
|-----------|-----------|-------------|
| **combo-cli serve** | `crates/combo-cli/` | combo's complete backend. Listens on `127.0.0.1:18236` by default (auto-increment if taken) and serves every `/v1/*` endpoint (REST + SSE); in Tauri mode it is embedded in-process as a library (`src-tauri` calls `serve_listener` directly). |
| **Tauri shell** | `src-tauri/` | Loads combo config, builds `AppState`, and starts the embedded serve (default 18236, auto-increment if taken); the actual port is pushed to the frontend via the Tauri event `proxy-ready`, and on connection failure the frontend auto-scans for a local combo-cli. |
| **Frontend** | `src/` | React 19 + Vite + shadcn/ui (Radix + Tailwind). TanStack Query for REST; Zustand shards live SSE state by `sessionId`. |

## Prerequisites

- **Node.js** ≥ 20 and npm
- **Rust** ≥ 1.80 (make sure `~/.cargo/bin` is on your `PATH`)
- **Tauri system dependencies**:
  - macOS: Xcode Command Line Tools
  - Linux: `libwebkit2gtk-4.1-dev libgtk-3-dev libdbus-1-dev pkg-config build-essential`
  - Windows: Microsoft C++ Build Tools and WebView2
- **Agent backend**: the built-in [combo-cli](crates/combo-cli) (combo's own
  rig-powered agent); configure providers and API keys in
  `~/.config/combo/combo-cli.toml`.

## Installation & Usage

### Option 1: Desktop app (Tauri)

```bash
git clone https://github.com/1fisher/combo.git
cd combo
npm install
```

Start with the Tauri CLI (`cargo tauri`, from the Rust toolchain):

```bash
cargo tauri dev
```

The Tauri shell launches the embedded combo-cli serve (combo's full backend)
automatically — no manual setup needed. Once it starts, use the UI's
"添加项目" (Add Project) to create a workspace and start chatting.

> ⚠️ Note: the repo has **no** `tauri` npm script and `@tauri-apps/cli` is
> not installed — use `cargo tauri dev` (Rust toolchain). `bundle.active` is
> currently `false`, so packaging is not set up.

### Option 2: Plain browser dev mode (recommended for daily development)

Two terminals are required.

**Terminal 1** — start Vite, pointing `VITE_PROXY_URL` straight at combo-cli
serve:

```bash
bash scripts/dev-proxy.sh
# equivalent to: VITE_PROXY_URL=http://127.0.0.1:18236 npm run dev
```

**Terminal 2** — build and start combo-cli serve in one step (combo's full
API service):

```bash
bash scripts/dev-backend.sh          # equivalent to: cargo build -p combo-cli → run in serve mode on :18236 (auto-increment if taken)
```

Then open **http://localhost:5173** in your browser.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `COMBO_CLI_BIN` | E2E switch: Playwright specs only run when this is set (they exercise real agent workflows). |
| `COMBO_IT_DIR` | E2E workspace directory (default `/tmp/combo-e2e`). |
| `VITE_PROXY_URL` | Backend base URL in browser mode, e.g. `http://127.0.0.1:18236`. In Tauri mode the embedded serve's event port is used automatically (default 18236, auto-increment if taken); on connection failure the frontend auto-scans for a local combo-cli. |

## Common Scripts

```bash
npm run dev                 # Vite dev server (strictPort 5173, browser mode)
npm run build               # tsc -b && vite build (production build, outputs dist/)
npm run tsc                 # tsc -b (incremental type check via project references)
npm test                    # vitest run (jsdom environment)
npm run test:e2e            # Playwright (auto-skipped unless COMBO_CLI_BIN is set)
npm run gen:api             # regenerate src/lib/api/types.ts from swagger/swagger.json
cargo test -p combo-cli     # Rust unit tests
cargo run -p combo-cli -- serve --port 18236   # run the backend standalone (default 18236, auto-increment if taken)
```

## Testing

```bash
# Frontend
npm test                              # Vitest unit tests (Testing Library + jsdom)
npx tsc --noEmit                      # type check
npm run build                         # production build

# Rust
cargo test -p combo-cli               # combo-cli unit tests

# E2E (requires a working provider/API key)
COMBO_CLI_BIN=1 npx playwright test
```

> E2E **wipes the workspace directory** (`/tmp/combo-e2e`) before running.
> Specs auto-skip when `COMBO_CLI_BIN` is unset.

## Continuous Integration (CI)

The GitHub Actions workflow [CI / Release](.github/workflows/release.yml)
runs automatically on every push to `main` and on PRs. It includes:

| Job | Contents |
|-----|----------|
| **CI Frontend** | `npm ci` → `npm run tsc` → `npm test` → `npm run build` (Node 22) |
| **CI Backend** | `cargo check --workspace` → `cargo test --workspace` (Rust stable, with Tauri Linux system deps) |
| **Bump Version** | Manual `workflow_dispatch`: version bump + changelog generation + tag & push |
| **Build** | On `v*` tag push or manual trigger: multi-platform matrix build of installers |
| **Publish Release** | Publish build artifacts as a GitHub Release |

Workflow status and the latest release are shown in the badges at the top of
this README.

## Directory Layout

```
combo/
├── crates/combo-cli/    combo's complete backend (lib + binary); serve mode provides all /v1/* endpoints
│   └── src/             serve / agent / fs / git / session / auth / tunnel / ...
├── crates/combo-relay/  Relay server for tunnels (remote access)
├── src-tauri/           Tauri shell (embeds combo-cli serve, init_backend)
├── src/                 Frontend (React 19 + Vite + TS + shadcn/ui)
│   ├── components/      ui/ (shadcn primitives) shell/ (app chrome) agent/ (chat/tools/modals)
│   ├── hooks/           TanStack Query hooks + SSE lifecycle (useWorkspaceEvents)
│   ├── lib/
│   │   ├── api/         API client (types.ts generated from swagger + hand-maintained Api namespace)
│   │   ├── events/      SSE client + event dispatch (dispatch unwraps the double envelope)
│   │   └── connection.ts Backend address discovery + health polling
│   └── stores/          Zustand (agentStore: sharded by sessionId, permission / question queues)
├── swagger/             OpenAPI contract copied from the rune repo (source commit in swagger/README.md)
├── e2e/                 Playwright end-to-end tests
├── docs/superpowers/    Design docs & implementation plans (specs / plans)
└── scripts/             Dev helper scripts (dev-proxy.sh, dev-backend.sh, gen-api.sh)
```

## How It Works — Key Points

- **One unified internal protocol**: combo always exposes the same `/v1/*`
  REST + double-layer SSE envelope
  `{ type, payload: { type, payload } }`, baselined on the rune-compatible
  protocol. combo-cli serve implements this protocol natively; the frontend
  never worries about implementation details.
- **`client_id` identity**: `apiRequest` automatically injects a `client_id`
  query param (a UUID persisted in `localStorage`). Note that
  `createWorkspace` must **also put `client_id` in the request body** (the
  backend validates it from the body). SSE subscriptions carry it too.
- **Double-layer SSE envelope**:
  `GET /v1/workspaces/{id}/events?client_id=...` with
  `Accept: text/event-stream`. Each `data:` frame is
  `{ type: <PayloadType>, payload: { type: "created"|"updated"|"deleted", payload: <data> } }`;
  `src/lib/events/dispatch.ts` unwraps one layer and writes into the Zustand
  store.
- **Run lifecycle**: `onSend` generates a `runId`, optimistically inserts the
  user message, POSTs, then marks the run `running`; the `run_complete`
  event marks it `done`. Note that a message's `streaming` flag, once set to
  `true`, is never reset — completion is signaled by the **run status**, not
  the message flag.
- **No Tauri API dependency in the frontend**: the whole app is developable
  and debuggable in a plain browser; directory picking falls back to a path
  input.

## Contributing

Issues and pull requests are welcome! Please make sure that:

1. New / modified code ships with corresponding tests (Rust `cargo test` and
   frontend `npm test` pass).
2. User-facing copy stays in **Chinese** (consistent with the existing UI
   and e2e selectors).
3. API contract changes are reflected in `swagger/` and `types.ts` is
   regenerated (`npm run gen:api`).
4. Commit messages follow
   [Conventional Commits](https://www.conventionalcommits.org/).

## License

This project is open-sourced under the [MIT License](./LICENSE) — feel free
to use, modify, and distribute it.
