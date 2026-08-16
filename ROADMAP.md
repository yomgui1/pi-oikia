# Roadmap — pi-oikia

Features and ideas to evaluate.

## Install briefing

On `session_start`, auto-generate a summary: HA version, area counts, entity counts, device model breakdown. Useful when connecting to a new instance for the first time.

**Feasibility**: High — available via `ha.get_config()`, `ha.get_areas()`, `ha.get_home_context()`.

## Persistent decisions

Record and retrieve confirmation decisions across sessions (e.g. "user always allows `light.turn_on` in kitchen"). Needs PI persistent storage API.

**Feasibility**: Medium — depends on PI's `ctx.storage` API.

## Native MCP bridge

Bridge to HA Core `/api/mcp/<API ID>` (introduced in 2026.8+). Useful if HA starts exposing tools via MCP. Likely limited gain — LLAT is sufficient for most operations.

**Feasibility**: Medium — straightforward once MCP endpoints stabilize.

## LSP YAML

Add-on feature (not extension): YAML autocompletion and diagnostics for HA configuration files. Out of scope for the extension. This is a higly debated domain (check discussions [here](https://community.home-assistant.io/t/ha-opencode-an-addon-to-plug-opencode-ai-into-your-home-assistant/971661)).

**Feasibility**: Medium — would need a proper (that's the problem!) YAML parser with HA schema awareness.

## Screenshots

Capture HA dashboard pages to verify rendering or debug UI issues. Out of scope — no browser.

**Feasibility**: Low — requires a headless browser.

## Entity discovery

Scan device capabilities and register missing entities that HA auto-discovery missed. HA covers most edge cases but some custom devices slip through. As always it opens a lot of security considerations.

**Feasibility**: Medium — requires ZHA/ZCL parsing integration.
