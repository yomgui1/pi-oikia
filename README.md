# pi-oikia

A [Pi](https://github.com/earendil-works/pi) / [Oh My Pi](https://github.com/ollama-hub/oh-my-pi) extension to control your Home Assistant.
**The agent gets tools, not a shell!**

**22 tools** across 3 permission tiers. Connect to HA over WebSocket with a scoped Long-Lived Access Token.

This extension has been designed with a strong security goal in mind. HA controls your home!

_Take a quick look to [DESIGN.md](DESIGN.md) if you are interested in the history of this project._

## Table of contents

- [Install](#install)
- [Setup](#setup)
- [Tool Tiers](#tool-tiers)
- [Testing](#testing)
- [More](#more)

## Install

### Pi

```bash
# Automatic
pi install git:github.com/yomgui1/pi-oikia

# Or manual
mkdir -p ~/.pi/agent/extensions/pi-oikia
cp -r src package.json node_modules ~/.pi/agent/extensions/pi-oikia/
```

### Oh My Pi (OMP)

```bash
# Automatic (if supported)
omp install git:github.com/yomgui1/pi-oikia

# Or manual
mkdir -p ~/.omp/agent/extensions/pi-oikia
cp -r src package.json node_modules ~/.omp/agent/extensions/pi-oikia/
```

## Setup

pi-oikia needs the two environment variables `HASS_URL` and `HASS_TOKEN`:

1. Create a HA API token from your HA instance: Settings → Users → Create token
2. Choose where to set your credentials:
   
   **Pi (local)** — create `~/.pi/agent/extensions/pi-oikia/.env`:
   ```
   HASS_URL=wss://your-ha-host:8123/api/websocket   # default: ws://localhost:8123/api/websocket
   HASS_TOKEN=eyJh...
   ```
   
   **OMP (local)** — create `~/.omp/agent/extensions/pi-oikia/.env`:
   ```
   HASS_URL=wss://your-ha-host:8123/api/websocket
   HASS_TOKEN=eyJh...
   ```
   
   **Docker / CI** — set env vars `HASS_TOKEN` and `HASS_URL` before running.

   **Optional: `HASS_INSECURE`** — set to `1` or `true`, or set `"httpInsecure": true` in
   `config.json`, to disable TLS certificate validation. You need it when your HA
   instance has a self-signed certificate or a hostname that does not match the cert, but...
   **Warning: the connection is vulnerable to man-in-the-middle attacks when enabled.**
   So use it only on trusted networks!
   Default: `false` (certificates are validated).

3. Run `pi` or `omp` — tools register on session start

## Status line format

By default, `pi-oikia` writes a status line to the agent's status bar:

```
pi-oikia → ha-host:8123: connected
```

You can change this with `PIOKIA_STATUS_FORMAT` (environment variable) or
`statusFormat` (key in `config.json`). Env takes precedence.

| Value | Effect |
|---|---|
| `full` *(default)* | `pi-oikia → host: idle` / `: connecting` / `: connected` / `: <err>` |
| `compact` | `pi-okia → ha: idle` / `→ ha ✓` / `→ ha …` / `→ ha ✗ <err>` |
| `minimal` | `ha: idle` / `ha ✓` / `ha …` / `ha ✗ <err>` |
| `off` | nothing displayed at all |

Examples:

```bash
# Env (highest priority)
PIOKIA_STATUS_FORMAT=compact pi
```

```jsonc
// config.json — same options, lower priority than env
{
  "tiers": { "read": true, "control": true, "write": false },
  "statusFormat": "compact"
}
```

Unknown values fall through to `default`. No error is raised.
## Tool Tiers

Each tier permission is independently enabled/disabled in `config.json`.

| Tier | Default | Confirm | Tools |
|---|---|---|---|
| `read` | ✅ | `render_template` only | 14 tools: get_state, get_services, get_config, get_history, get_logbook, get_devices, get_areas, get_home_context, get_entity_details, search_entities, get_error_log, render_template, test_condition, supervisor_info |
| `control` | ✅ | Per-call | 4 tools: call_service, toggle, fire_event, execute_script |
| `write` | ❌ | `toggle_device_disabled` only | 4 tools: validate_config, get_entity_registry_entry, get_device_registry_entry, toggle_device_disabled |

```json
// config.json
{ "tiers": { "read": true, "control": true, "write": false } }
```

Disabling a tier removes its tools — the agent cannot call them at all.

## Security

- Token is a **scoped LLAT** (not Supervisor admin)
- **No shell, no filesystem access** — only WS/REST API calls
- **Code-enforced guards** block secrets.yaml, .storage/, .cloud/, deps/
- All destructive actions are **confirm-gated**
- TLS certificate validation is **enforced by default**. `httpInsecure: true` disables it
  (see [Setup](#setup)) and must never be used on untrusted networks.

## Testing

Spin up a local HA instance for smoke tests (better to use a local HA for testing than an in-production one!):

```bash
docker compose -f tests/docker-compose.test.yml up -d
```

### Live API test

Test **all** tools (read, control, write) against a running HA instance. Disabled tiers are still exercised as regression checks and marked `⦿ skipped`:

```bash
HASS_URL=wss://your-ha:8123/api/websocket \
HASS_TOKEN=your-long-lived-token \
bun tests/test-live.ts
```

**CLI flags** override `config.json` tiers:

| Flag | Effect |
|------|--------|
| `--read` / `--no-read` | Force read tier on/off |
| `--control` / `--no-control` | Force control tier on/off |
| `--write` / `--no-write` | Force write tier on/off |
| `--insecure` | Skip TLS certificate validation |
| `--help` | Show usage |

Use `http://` URLs if HA isn't behind TLS.

## More

- [DESIGN.md](DESIGN.md) — History, Architecture, token strategy, tool tiers, threat model
- [CHANGELOG.md](CHANGELOG.md) — Dev history, all tools listed by tier
- [ROADMAP.md](ROADMAP.md) — Future features and ideas
