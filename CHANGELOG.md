# Changelog — pi-oikia

## v0.6.0

- Status line format customizable from an idea given by leen <leen2175@outlook.com> (PR#1)

## v0.5.0

- **New tool: `ha.add_energy_device`** — Register kWh sensors as tracked devices in the Energy dashboard via WebSocket API (`energy/get_prefs`, `energy/save_prefs`). Added `getEnergyPreferences()` and `saveEnergyPreferences()` to HaClient.
- **Service call response capture** — `call_service` now requests `return_response: true` from HA's WebSocket API. Services like `recorder.get_statistics` can now return their actual JSON responses instead of a generic "success" message.
- **Gallery discovery** — Added `pi-package` keyword to `package.json` for automatic discovery on pi.dev gallery.

## v0.4.0

- **Security hardening** — Path guards now block `.storage/` reads (not just writes). Renamed `PROTECTED_PATHS` field from `allowed` to `blockedTools` to fix inverted semantics.
- **Confirmation gate on `render_template`** — Added `ctx.ui.confirm()` gate and MCP annotations to prevent unsupervised Jinja2 template execution.
- **Script summarization for `execute_script`** — Added `summarizeScriptSequence()` helper to display a readable summary of automation scripts in the confirmation dialog. Enforced single-action or array-of-single-actions constraint.
- **Removed weak Supervisor token heuristic** — Dropped `token.split(".").length >= 5` check (never triggered for valid tokens). Replaced with a user warning notification instead of an error.
- **Removed `.env` auto-loading** — Environment variables (`HASS_TOKEN`, `HASS_URL`) are now the user's responsibility to configure before running the extension.
- **Removed admin tier** — The `admin` tier contained only `supervisor_info`, a read-only tool. Moved it to `read` tier; `loadTierConfig()` now returns `{ read, control, write }` (3 tiers instead of 4).
- **Documentation fixes** — Updated README.md and DESIGN.md to match code: correct tool count (22), correct tier count (3), accurate confirm columns, eager connection lifecycle, and honest token strategy claims.
- **WebSocket agent fix** — Split `https.Agent` into per-scheme `_httpAgent`/`_httpsAgent` + `getAgent(url)` to fix Bun `fetch()` socket closure on `http://` URLs and correct `ws://` connections always receiving `https.Agent`.
- **Registry mutation migration** — `toggleEntityDisabled` and `toggleDeviceDisabled` migrated from REST PATCH to WebSocket `config/entity_registry/update` and `config/device_registry/update` (REST endpoints unavailable on Docker HA Core).
- **Live test suite** — Added `tests/test-live.ts` exercising all 24 API methods across read/control/write tiers with CLI flags (`--read`, `--control`, `--write`, `--insecure`).

## v0.3.0

- **Secure-by-default TLS** — Connection is secure by default. Added `HASS_INSECURE` env var and `config.json.httpInsecure` to opt-in to unverified TLS when running with self-signed certs.
- **Immediate connection at startup** — WS connection is attempted at session_start with status updates on success/failure (replaces stale "Connecting" display).
- **Readable error messages** — `ErrorEvent` from WebSocket is unwrapped to expose the actual error string (e.g. "TLS handshake failed" instead of "[object ErrorEvent]").
- **Documentation** — few minor corrections.

## v0.2.0

- **Lazy connection init** — WS connection is deferred to the first tool call instead of failing at session_start. Extension tools are registered immediately; connection happens on first use with retry.
- **Connection retry with backoff** — `send()` retries up to 3 times with exponential backoff (1s, 2s, 4s). Invalid tokens are not retried.
- **WebSocket keepalive** — Ping sent every 15s to prevent HA from closing idle connections (~30s timeout). Dead connections are detected via pong timeout (8s) and force a reconnect.
- **searchEntities lazy state fetch** — `searchEntities` now fetches states on first call instead of requiring `getStates()` to be called manually.
- **New tools** — `render_template`, `test_condition`, `execute_script`, `fire_event`, `get_error_log`, `search_entities`, `get_entity_details`, `get_entity_registry_entry`, `get_device_registry_entry`, `toggle_device_disabled`, `supervisor_info`
- **Path guards** — Block `.cloud/`, `deps/`, `home-assistant_v2.db` via tool_call event handler (in addition to `secrets.yaml` and `.storage/`)

## v0.1.0

Initial commit with first usable version
