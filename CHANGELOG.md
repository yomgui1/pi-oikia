# Changelog — pi-oikia

## Unreleased

- **Lazy connection init** — WS connection is deferred to the first tool call instead of failing at session_start. Extension tools are registered immediately; connection happens on first use with retry.
- **Connection retry with backoff** — `send()` retries up to 3 times with exponential backoff (1s, 2s, 4s). Invalid tokens are not retried.
- **WebSocket keepalive** — Ping sent every 15s to prevent HA from closing idle connections (~30s timeout). Dead connections are detected via pong timeout (8s) and force a reconnect.
- **searchEntities lazy state fetch** — `searchEntities` now fetches states on first call instead of requiring `getStates()` to be called manually.

## v0.1.0

Initial commit with first usable version
