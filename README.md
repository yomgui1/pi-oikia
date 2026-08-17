# pi-oikia

A [Pi](https://github.com/earendil-works/pi) / [Oh My Pi](https://github.com/ollama-hub/oh-my-pi) extension to control your Home Assistant.
**The agent gets tools, not a shell!**

**17 tools** across 4 permission tiers. Connect to HA over WebSocket with a scoped Long-Lived Access Token.

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

3. Run `pi` or `omp` — tools register on session start

## Tool Tiers

Each tier permission is independently enabled/disabled in `config.json`.

| Tier | Default | Confirm | Tools |
|---|---|---|---|
| `read` | ✅ | None | 13 tools: get_state, get_services, get_config, get_history, get_logbook, get_devices, get_areas, get_home_context, get_entity_details, search_entities, get_error_log, render_template, test_condition |
| `control` | ✅ | Per-call | 4 tools: call_service, toggle, fire_event, execute_script |
| `write` | ❌ | None | 4 tools: validate_config, get_entity_registry_entry, get_device_registry_entry, toggle_device_disabled |
| `admin` | ❌ | Per-call | 1 tool: supervisor_info |

```json
// config.json
{ "tiers": { "read": true, "control": true, "write": false, "admin": false } }
```

Disabling a tier removes its tools — the agent cannot call them at all.

## Security

- Token is a **scoped LLAT** (not Supervisor admin)
- **No shell, no filesystem access** — only WS/REST API calls
- **Code-enforced guards** block secrets.yaml, .storage/, .cloud/, deps/
- All destructive actions are **confirm-gated**

## Testing

Spin up a local HA instance for smoke tests (better to use a local HA for testing than an in-production one!):

```bash
docker compose -f tests/docker-compose.test.yml up -d
```

## More

- [DESIGN.md](DESIGN.md) — History, Architecture, token strategy, tool tiers, threat model
- [CHANGELOG.md](CHANGELOG.md) — Dev history, all tools listed by tier
- [ROADMAP.md](ROADMAP.md) — Future features and ideas
