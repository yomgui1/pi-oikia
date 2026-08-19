# Design — pi-oikia

A [Pi](https://github.com/earendil-works/pi) extension to control your Home Assistant.

_Security-first, code-enforced permissions, typed tools, no shell access._

---

## 1. Problem Statement

This extension was born from a security and quality review of existing HA-AI controllers running as add-on integrations.

**Problem**: Add-on-based controllers run inside the HA container with excessive privileges (Supervisor admin tokens, full /config filesystem access, exposed shell), creating an attack surface that turns any add-on CVE into a full HA compromise.

| Concern | Add-on approach | pi-oikia |
|---|---|---|
| Runs on | HA host (container) | User machine |
| Shell access | Full | **None** |
| Token | Supervisor (`admin` role) | **LLAT (scoped, typed)** |
| Exposed port | HTTP (unauthenticated) | **None** |
| FS scope | Full /config, ssl, media, backup | **None (WS/REST only)** |
| Consent | Prompt-level (AGENTS.md text) | **Code-enforced `ctx.ui.confirm()`** |
| Internal dirs | Exposed or prompt-blocked | **Code-blocked** |
| Secrets | Exposed or prompt-blocked | **Never exposed** |
| Tool granularity | Shell or 3 profiles | **Per-tier (read/control/write)** |

The risk is clear: an add-on compromise gives the attacker direct access to HA's internal filesystem, SSL certificates, backups, and the Supervisor admin API. pi-oikia eliminates that attack surface by running outside the HA container and communicating only via the stable WS/REST API with a scoped LLAT—no shell, no filesystem access.

---

## 2. Architecture

```
┌───────────────────────────────────────────────┐
│  User machine                                 │
│                                               │
│  ┌─────────────┐          ┌────────────────┐  │
│  │ PI process  │          │ Home Assistant │  │
│  │             │ ── WS API─▶              │  │
│  │ pi-oikia    │          │ Token: LLAT    │  │
│  │ Typed tools │          │ (no FS access) │  │
│  │ Guard layer │          └────────────────┘  │
│  └─────────────┘                              │
│                                               │
└───────────────────────────────────────────────┘
```

### Key departures

1. **PI runs locally, never inside HA** — no addon, no container, no SSH. The extension lives on the user machine and talks to HA over the WebSocket API.
2. **Long-Lived Access Token (LLAT)** — not Supervisor token. The LLAT can be scoped read-only or read-write. The extension logs a warning advising users to supply a user LLAT, not a Supervisor token.
3. **No shell** — the extension registers only typed tools. No `bash`, no `fs`, no `read`, no `write`. The agent cannot escape the tool surface.
4. **Code-enforced guards** — confirmation gates and path blocklists live in TypeScript, not in AGENTS.md text.

---

## 3. Token Strategy

### 3.1 Token type

Use a **Home Assistant Long-Lived Access Token** (create at Settings → Users → Create token). Read from `HASS_TOKEN` in the project `.env`.

### 3.2 Read vs Write Scope

LLATs offer read-only or read-write (default). The extension refines further:

| LLAT Scope | Default active tier |
|---|---|
| `read-only` | `read` | `control`, `write` blocked |
| `read-write` (default) | `read`, `control` | `write` opt-in |

The extension logs a warning advising users to supply a user LLAT, not a Supervisor token.

### 3.3 Token storage

- Project `.env` or encrypted PI project config

Never in logs, tool output, or LLM context. By design, the token is never interpolated into user-facing strings.

---

## 4. Tool Tiers

Each tool declares a tier. Config enables/disables tiers.

| Tier | Default | Confirm | Tools |
|---|---|---|---|
| `read` | ✅ Always | `render_template` only | `get_state`, `get_services`, `get_config`, `get_history`, `get_logbook`, `get_devices`, `get_areas`, `get_home_context`, `get_entity_details`, `search_entities`, `get_error_log`, `render_template`, `test_condition`, `supervisor_info` |
| `control` | ✅ On | Per-call | `call_service`, `toggle`, `fire_event`, `execute_script` |
| `write` | ❌ Off | `toggle_device_disabled` only | `validate_config`, `get_entity_registry_entry`, `get_device_registry_entry`, `toggle_device_disabled` |

Disabling a tier hides its tools: the agent cannot call them at all.

```json
// config.json
{ "tiers": { "read": true, "control": true, "write": false } }
```

---

## 5. Connection Lifecycle

The extension manages a WS connection to HA:

1. Connects on `session_start` (eager — connects immediately, tools registered after connect begins)
2. Reconnects on disconnect with exponential backoff
3. Authenticates via LLAT on each connection
4. Closes on `session_shutdown`

---

## 6. Path Guards

The extension has no file tools, but the agent retains PI's built-in `read`, `write`, `edit` tools. A `tool_call` event handler blocks access to protected HA paths:

| Pattern | Reason |
|---|---|
| `secrets.yaml` | Contains credentials — never exposed |
| `.storage/**` | Internal HA state — use entity tools |
| `.cloud/**` | Managed by HA Cloud |
| `deps/**` | Managed by HA Core |
| `home-assistant_v2.db` | Internal database |

---

## 7. Token Budget

> **Security is mandatory. Token efficiency is the daily constraint.**

A large HA install returns 200–500 entities. `ha.get_home_context()` (no filters) returns ALL entities in compact format (~10–30 bytes/entity vs 1000+ for full attributes).

### Design rule

If a tool without arguments returns unbounded data, it must have a filtered equivalent.

| Pattern | Cost | Example |
|---|---|---|
| All entities (compact) | Low (~1–5 KB) | `ha.get_home_context()` |
| Single entity | Low (~200 B) | `ha.get_state(entity_id)` |
| Filtered context | Low (~1–3 KB) | `ha.get_home_context({ area: "kitchen" })` |
| No args → bounded output | By design | `ha.get_areas()`, `ha.get_config()` |

---

## 8. Threat Model

| Threat | Mitigation |
|---|---|
| `bash rm -rf /config` | No shell; `tool_call` guard blocks file ops on HA paths |
| Reads `secrets.yaml` | Path guard at code level before I/O |
| Destructive service call | `destructive: true` annotation; model acknowledges |
| Reads `.storage/entities.json` | Path guard blocks; tool returns code error |
| Token leakage in logs | Redacted in all error paths |
| Prompt injection to bypass AGENTS.md | Not applicable — guards are code, not text |
| Token compromise | LLAT scope limited; user can revoke independently |
| Extension compromised | PI trust model; project-local loading with trust prompt |

---

## 9. Security Posture

| Criterion | pi-oikia |
|---|---|
| Runs on | User machine |
| Shell access | **None** |
| Token | **LLAT (scoped, typed)** |
| Exposed port | **None** |
| FS scope | **None (WS/REST API only)** |
| Consent | **Code-enforced confirm()** |
| Internal dirs | **Code-blocked** |
| Secrets | **Never exposed** |
| Tool granularity | **Per-tier (read/control/write)** |
| Built-in tool guard | **tool_call event handler** |
