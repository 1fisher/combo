# AGENTS.md

## What this is

**combo** is a multi-agent IDE desktop app: a Tauri v2 shell + React 19/TypeScript
frontend that talks to **rune** (the Charm Crush server binary, `crush`) through an
embedded Rust reverse proxy. All UI copy, code comments, and the README are in
**Chinese** — keep new UI strings and comments in Chinese to match.

```
Tauri Webview (React/TS)
   fetch / EventSource ──→ http://127.0.0.1:<random-port>/v1/*
                              │ combo-proxy (axum, pure forwarder, CORS + SSE passthrough)
                              ▼
                    rune server (`crush server` subprocess, unix socket)
```

Three components, three languages/dirs:

- **`crates/combo-proxy`** (Rust, axum) — pure reverse proxy. Forwards every
  request under `/v1/*` to rune; streams SSE bodies through un-buffered.
  Also contains `RuneManager` (`src/rune.rs`), which spawns/guards the `crush
  server` subprocess (health-poll, auto-restart is via `ensure_running`, graceful
  shutdown via `/v1/control`).
- **`src-tauri`** (Rust, Tauri v2) — thin shell. `init_backend` in `src/lib.rs`
  starts `RuneManager` + proxy on `127.0.0.1:0` (random port), emits Tauri events
  `proxy-ready` (`{port}`) and `rune-status` (`{connected}`). On rune failure it
  keeps the proxy alive pointing at an unreachable TCP address so the UI shows
  "disconnected".
- **`src/`** (React 19 + Vite + TS, shadcn/ui) — the frontend. TanStack Query
  for REST data, **Zustand** (`stores/agentStore.ts`) for SSE-driven live state,
  keyed by `sessionId`.

The frontend never talks to Tauri APIs for data (`src/lib/connection.ts` detects
Tauri via `'__TAURI_INTERNALS__' in window`), so the whole app is developable in a
plain browser. M1 directory picking is a path input, not a native dialog.

## Commands

```bash
npm run dev                 # Vite dev server, strict port 5173 (browser mode)
bash scripts/dev-proxy.sh   # = VITE_PROXY_URL=http://127.0.0.1:18234 npm run dev
npm run build               # tsc -b && vite build (production build, outputs dist/)
npm run tsc                 # tsc -b (project references: tsconfig.app.json + tsconfig.node.json)
npm test                    # vitest run (jsdom; config lives inside vite.config.ts)
npm run test:e2e            # Playwright; SKIPS itself unless COMBO_CRUSH_BIN is set
npm run gen:api             # regenerate src/lib/api/types.ts from swagger/swagger.json
cargo run -p combo-proxy --bin combo-proxy -- --port 18234   # proxy standalone (auto-spawns rune)
cargo test -p combo-proxy   # Rust unit + integration tests
```

**Browser dev workflow (recommended):** terminal 1 `bash scripts/dev-proxy.sh`,
terminal 2 `cargo run -p combo-proxy --bin combo-proxy -- --port 18234`, then open
http://localhost:5173.

**Tauri desktop mode:** the README says `npm run tauri dev`, but **that does not
work out of the box** — there is no `tauri` npm script and `@tauri-apps/cli` is not
installed. You need the Tauri CLI from the Rust toolchain (`cargo tauri dev`) or to
install `@tauri-apps/cli` first. `bundle.active` is `false` in
`src-tauri/tauri.conf.json`, so packaging is not set up.

### Env vars

| Var | Meaning |
|---|---|
| `COMBO_CRUSH_BIN` | Path to the rune server binary (default: `crush` from PATH). Required for E2E and rune integration tests. |
| `COMBO_RUNE_IT` | Set to `1` to enable the rune integration test in `crates/combo-proxy/tests/rune_integration_test.rs` (skips otherwise). |
| `COMBO_IT_DIR` | E2E workspace directory (default `/tmp/combo-e2e`). |
| `VITE_PROXY_URL` | Proxy base URL for browser mode (e.g. `http://127.0.0.1:18234`). In Tauri mode the port comes from the `proxy-ready` event with a 2s fallback to `:18234`. |

`crush` is **not** installed in this environment — anything requiring it
(integration/E2E tests, desktop mode) self-skips or fails unless the binary is
provided.

## Architecture & data flow

- **`client_id` is the identity mechanism.** `apiRequest` (`src/lib/api/client.ts`)
  auto-injects a `client_id` query param (UUID persisted in `localStorage`
  `combo.clientId`; `randomUUID` in `src/lib/clientId.ts` deliberately avoids
  `crypto.randomUUID` for insecure LAN contexts). **Gotcha:** `createWorkspace`
  must ALSO put `client_id` in the request body — rune validates it from the body,
  not the query string. SSE subscription also passes it as a query param.
- **SSE envelope is double-nested.** `GET /v1/workspaces/{id}/events?client_id=...`
  with `Accept: text/event-stream`. Each frame's `data:` is
  `{ type: <PayloadType>, payload: { type: "created"|"updated"|"deleted", payload: <real data> } }`.
  `src/lib/events/dispatch.ts` unwraps one level and writes into the Zustand store;
  `payloadTypes.ts` lists all known `PayloadType`s. Unhandled types are silently
  ignored (`run_complete` marks the run done, `message` upserts, permission/question
  types feed the modal queues). `useWorkspaceEvents` intercepts `session` events to
  invalidate the TanStack sessions query instead.
- **Run lifecycle:** `AgentPanel.onSend` generates a `runId` (UUID), optimistically
  inserts a user message with id `` `local-${runId}` `` (fake `created_at` via
  `Date.now()`), POSTs `/v1/workspaces/{id}/agent`, then marks the run `running`.
  On failure it deletes the optimistic message. `run_complete` sets the run to
  `done`. Note: `MessageVM.streaming` is set to `true` on every upsert and never
  flipped back — completion is signaled by run status, not message flags.
- **Proxy gotchas** (`crates/combo-proxy/src/handler.rs`): strips `HOST`,
  `CONNECTION`, `CONTENT_LENGTH`, `TRANSFER_ENCODING` headers in both directions.
  Unix-socket upstream URIs must be `unix://<hex-encoded-socket-path>/<path>`.
  Rune's default socket is `$XDG_RUNTIME_DIR/crush-<uid>.sock` (falls back to
  `temp_dir()`, and to `crush.sock` when uid unknown); path is capped at 104 bytes
  (macOS `sun_path` limit) in `rune.rs::default_socket_path`. Rune stdout goes to
  `$TMPDIR/combo-rune.log`. When `--origin` flags are absent, CORS is fully
  permissive; Tauri mode passes `tauri://localhost` and `http://localhost:5173`.

## Code organization & conventions

- **Rust:** module-per-concern under `crates/combo-proxy/src/` (`handler`, `router`,
  `rune`, `upstream`), `pub` API re-exported from `lib.rs`. Workspace root
  `Cargo.toml` has members `crates/combo-proxy` and `src-tauri`.
- **Frontend layout:** `src/components/{ui,shell,agent}` — `ui/` is generated
  shadcn primitives, `shell/` is app chrome (sidebar, tabs, status bar), `agent/`
  is the chat/tool/modal UI. `src/hooks/` wraps TanStack queries + SSE lifecycle;
  `src/lib/api/` is the typed client (`types.ts` generated, `index.ts` hand-written
  endpoint wrappers); `src/lib/events/` is SSE + dispatch; `src/lib/connection.ts`
  is proxy address discovery + health polling; `src/stores/` is Zustand.
- **Generated types are NOT purely generated.** `npm run gen:api` runs
  `openapi-typescript` over `swagger/swagger.json` (vendored from the rune repo at
  commit `28ed89ff`, see `swagger/README.md`) then **appends a hand-maintained
  `Api` namespace** (in `scripts/gen-api.sh`) because the swagger is incomplete
  (question types, parts, etc. missing). Hand-edit that appended block when the
  wire types change; `src/lib/api/contract.test.ts` is a type-level compile check
  guarding the shapes.
- **Naming:** kebab-case filenames, PascalCase components, camelCase functions,
  `use` prefix on hooks, wire types under the `Api` namespace. Tests are colocated
  as `*.test.ts` / `*.test.tsx`.
- **Alias:** `@/*` → `./src/*` (configured in both `vite.config.ts` and
  `tsconfig.app.json`). Vitest config lives **inside** `vite.config.ts`
  (jsdom env, globals, excludes `e2e/**`).

## Testing

- **Unit (Vitest + Testing Library, jsdom):** `apiRequest` tests stub global fetch
  with `vi.stubGlobal` and drive the base URL via `setProxyBaseUrl` (a module-level
  mutable in `connection.ts` — reset per test). `dispatch-real.test.ts` replays
  captured real rune SSE envelopes through `applyEvent`. Store and component tests
  assert against the Zustand store directly.
- **Rust:** in-module `#[cfg(test)]` units plus `tests/proxy_test.rs` (spins an
  in-memory stub axum upstream and asserts proxying incl. SSE passthrough) and
  `tests/rune_integration_test.rs` (real rune, gated on `COMBO_RUNE_IT=1`).
- **E2E (Playwright):** `playwright.config.ts` `webServer` auto-starts both Vite
  (`bash scripts/dev-proxy.sh`) and the proxy (`cargo run ... --port 18234`) with
  `reuseExistingServer: true`. The spec skips itself unless `COMBO_CRUSH_BIN` is
  set. It **wipes the workspace dir (`/tmp/combo-e2e`) before running** because
  rune persists state (`.crush/`) inside the workspace. Selectors rely on Chinese
  UI text (e.g. `getByPlaceholder('输入项目路径')`, button `添加项目`, `发送`,
  title `新建会话`).

## Gotchas summary

1. `npm run tauri dev` (README) is wrong as-is — no tauri npm script/CLI installed.
2. Browser dev needs the proxy on `:18234`; that port is hard-coded as fallback in
   `connection.ts`, `dev-proxy.sh`, `playwright.config.ts`, and the e2e spec.
3. `client_id` goes in query params everywhere, but must also be in the
   `createWorkspace` request body.
4. SSE envelopes are double-nested; don't read `env.payload` directly.
5. Message `streaming` flag never resets; use run status for completion.
6. Don't "fix" the appended `Api` namespace block in `types.ts` by moving it into
   the generated section — it must be re-appended by `gen-api.sh`.
7. Keep Chinese for user-facing strings; the e2e suite depends on it.
8. `tsc -b` (project references) is incremental; `tsconfig.node.tsbuildinfo` /
   `tsconfig.app.tsbuildinfo` are gitignored but regenerate on build.
9. `agentStore` state is in-memory only — reloading the page loses messages;
   history is refetched via `getSessionHistory` when a session is activated.
