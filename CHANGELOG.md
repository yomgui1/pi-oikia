# Changelog — pi-oikia

## Unreleased

## v0.2.0

- **Lazy connection init** — WS connection is deferred to the first tool call instead of failing at session_start. Extension tools are registered immediately; connection happens on first use with retry.
- **Connection retry with backoff** — `send()` retries up to 3 times with exponential backoff (1s, 2s, 4s). Invalid tokens are not retried.
- **WebSocket keepalive** — Ping sent every 15s to prevent HA from closing idle connections (~30s timeout). Dead connections are detected via pong timeout (8s) and force a reconnect.
- **searchEntities lazy state fetch** — `searchEntities` now fetches states on first call instead of requiring `getStates()` to be called manually.
- **New tools** — `render_template`, `test_condition`, `execute_script`, `fire_event`, `get_error_log`, `search_entities`, `get_entity_details`, `get_entity_registry_entry`, `get_device_registry_entry`, `toggle_device_disabled`, `supervisor_info`
- **Path guards** — Block `.cloud/`, `deps/`, `home-assistant_v2.db` via tool_call event handler (in addition to `secrets.yaml` and `.storage/`)

## v0.1.0

Initial commit with first usable version
