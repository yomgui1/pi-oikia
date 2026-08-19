import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { HaClient } from "./client";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROJECT_NAME = "pi-oikia";

// ── Config ─────────────────────────────────────────────────────────

function loadTierConfig(): { read: boolean; control: boolean; write: boolean; admin: boolean } {
  const config = loadFullConfig();
  const parsed = config.tiers ?? {};
  return {
    read: parsed.read ?? true,
    control: parsed.control ?? true,
    write: parsed.write ?? false,
    admin: parsed.admin ?? false,
  };
}

function loadFullConfig(): { tiers?: Record<string, boolean>; httpInsecure?: boolean } {
  const configPath = join(__dirname, "..", "config.json");
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, "utf8");
    return JSON.parse(raw) as { tiers?: Record<string, boolean>; httpInsecure?: boolean };
  } catch {
    return {};
  }
}

// ── Extension ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let client: HaClient | null = null;
  let shuttingDown = false;
  let _ctx: ExtensionContext | null = null;

  pi.on("session_start", async (_event, ctx) => {
    _ctx = ctx;
    const url = process.env.HASS_URL ?? "ws://localhost:8123/api/websocket";
    const token = process.env.HASS_TOKEN;
    if (!token) {
      ctx.ui.setStatus("ha", "No HASS_TOKEN set — extension idle");
      ctx.ui.notify(`${PROJECT_NAME}: set HASS_TOKEN in .env to enable`, "warn");
      return;
    }

    ctx.ui.notify(
      `${PROJECT_NAME}: ensure HASS_TOKEN is a user Long-Lived Access Token (not a Supervisor token)`,
      "warn"
    );

    const httpInsecure = process.env.HASS_INSECURE === "1" || process.env.HASS_INSECURE === "true" || loadFullConfig().httpInsecure === true;
    client = new HaClient({ url, token, insecure: httpInsecure });

    const host = new URL(url).host;
    ctx.ui.setStatus("ha", `${PROJECT_NAME} → ${host}: connecting`);
    (async () => {
      try {
        await client!.connect();
        ctx.ui.setStatus("ha", `${PROJECT_NAME} → ${host}: connected`);
      } catch (err) {
        ctx.ui.setStatus("ha", `${PROJECT_NAME} → ${host}: ${err instanceof Error ? err.message : "unknown error"}`);
      }
    })();

    registerTools(client);
  });

  pi.on("session_shutdown", () => {
    shuttingDown = true;
    client?.close();
    client = null;
    _ctx = null;
  });

  /** Guard: block built-in tools from accessing protected HA paths.
   * Format: [re, blockedTools, reason]
   *  - re: regex to filter-in the path pattern.
   *  - blockedTools: a tools list that should be blocked.
   *  - reason: message given to user if the tool is blocked.
   */
  const PROTECTED_PATHS: Array<[RegExp, string[], string]> = [
    [/secrets\.yaml$/, ["read", "write"], "secrets.yaml is protected — never exposed to LLM"],
    [/\.storage\//, ["read", "write"], ".storage/ is protected — never exposed to LLM"],
    [/\.cloud\//, ["read", "write"], ".cloud/ is managed by HA Cloud"],
    [/\/deps\//, ["read", "write"], "deps/ is managed by HA Core"],
    [/\/home-assistant_v2\.db$/, ["read", "write"], "home-assistant_v2.db is internal HA database"],
  ];

  pi.on("tool_call", async (event, _ctx) => {
    const { toolName, input } = event;
    if (input.path) {
      const resolved = resolve("/config", input.path);
      if (!resolved.startsWith("/config/")) {
        return { block: true, reason: `Path resolved outside config directory` };
      }
      for (const [re, blockedTools, reason] of PROTECTED_PATHS) {
        if (blockedTools.includes(toolName) && re.test(resolved)) {
          return { block: true, reason };
        }
      }
    }
  });

  // ── Tool registration ────────────────────────────────────────────

  async function ensureConnected(c: HaClient): Promise<HaClient> {
    const host = new URL(c.config.url).host;
    try {
      await c.connect();
      _ctx?.ui.setStatus("ha", `${PROJECT_NAME} → ${host}: connected`);
    } catch (err) {
      _ctx?.ui.setStatus("ha", `${PROJECT_NAME} → ${host}: ${err instanceof Error ? err.message : "unknown error"}`);
      throw err;
    }
    return c;
  }

  function registerTools(c: HaClient) {
    if (shuttingDown) return;
    const tiers = loadTierConfig();

    if (tiers.read) {
      pi.registerTool(makeGetState(c));
      pi.registerTool(makeGetServices(c));
      pi.registerTool(makeGetConfig(c));
      pi.registerTool(makeGetHistory(c));
      pi.registerTool(makeGetLogbook(c));
      pi.registerTool(makeGetDevices(c));
      pi.registerTool(makeGetAreas(c));
      pi.registerTool(makeGetHomeContext(c));
      pi.registerTool(makeGetEntityDetails(c));
      pi.registerTool(makeSearchEntities(c));
      pi.registerTool(makeGetErrorLog(c));
      pi.registerTool(makeRenderTemplate(c));
      pi.registerTool(makeTestCondition(c));
    }

    if (tiers.control) {
      pi.registerTool(makeCallService(c));
      pi.registerTool(makeToggle(c));
      pi.registerTool(makeFireEvent(c));
      pi.registerTool(makeExecuteScript(c));
    }

    if (tiers.write) {
      pi.registerTool(makeValidateConfig(c));
      pi.registerTool(makeGetEntityRegistryEntry(c));
      pi.registerTool(makeGetDeviceRegistryEntry(c));
      pi.registerTool(makeToggleDeviceDisabled(c));
    }

    if (tiers.admin) {
      pi.registerTool(makeSupervisorInfo(c));
    }
  }

  // ── Tool factories ───────────────────────────────────────────────

  /**
   * Return the current state (and attributes) of a single Home Assistant entity.
   * @param entity_id Fully qualified entity ID (e.g. `light.kitchen`).
   * @returns Full state object with `state`, `attributes`, `last_changed`, `last_updated`, or `{ state: "not_found" }`.
   */
  function makeGetState(client: HaClient) {
    return {
      name: "ha.get_state",
      label: "HA Get State",
      description: "Get the current state of a single entity by entity_id.",
      parameters: Type.Object({
        entity_id: Type.String({ description: "Entity ID, e.g. light.kitchen" }),
      }),
      async execute(_id, params) {
        return {
          content: [{ type: "text", text: JSON.stringify(await client.getEntityState(params.entity_id), null, 2) }],
        };
      },
    };
  }

  /**
   * List available Home Assistant services grouped by domain.
   * @param domain Optional filter ("light", "switch", "automation").
   * @returns Record of domain → array of ServiceSpec objects, or filtered result if domain is provided.
   */
  function makeGetServices(client: HaClient) {
    return {
      name: "ha.get_services",
      label: "HA Get Services",
      description:
        "List all available Home Assistant services. Optionally filter by domain (light, switch, automation, etc.).",
      parameters: Type.Object({
        domain: Type.Optional(
          Type.String({ description: "Filter by domain, e.g. light, switch, automation" })
        ),
      }),
      async execute(_id, params) {
        const services = await client.getServiceList();
        if (params.domain) {
          const services$ = services[params.domain.toLowerCase()];
          if (!services$) return { content: [{ type: "text", text: `No services found for domain: ${params.domain}` }] };
          return { content: [{ type: "text", text: JSON.stringify(services$, null, 2) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(services, null, 2) }] };
      },
    };
  }

  /**
   * Get the HA instance configuration summary.
   * @returns Core config including version, timezone, elevation, unit system, config directory.
   */
  function makeGetConfig(client: HaClient) {
    return {
      name: "ha.get_config",
      label: "HA Get Config",
      description:
        "Get the Home Assistant instance configuration (version, timezone, elevation, unit system). Useful for orientation.",
      parameters: Type.Object({}),
      async execute() {
        return {
          content: [{ type: "text", text: JSON.stringify(await client.getConfig(), null, 2) }],
        };
      },
    };
  }

  /**
   * Retrieve state history for a list of entities.
   * @param entity_ids Array of entity IDs to get history for.
   * @param hours Lookback window. Default 1, max 168 (one week).
   * @returns Record mapping entity_id → array of { last_changed, state } entries.
   */
  function makeGetHistory(client: HaClient) {
    return {
      name: "ha.get_history",
      label: "HA Get History",
      description:
        "Get state history for entities. Optional hours parameter defaults to 1. Use minimal_response=true for compact output.",
      parameters: Type.Object({
        entity_ids: Type.Array(Type.String({ description: "Entity IDs to get history for" })),
        hours: Type.Optional(Type.Number({ description: "Hours back to retrieve", minimum: 0.1, maximum: 168 }), {
          default: 1,
        }),
      }),
      async execute(_id, params) {
        return {
          content: [{ type: "text", text: JSON.stringify(await client.getHistory(params.entity_ids, params.hours), null, 2) }],
        };
      },
    };
  }

  /**
   * List logbook entries with timestamps.
   * @param entity_id Optional filter to a single entity.
   * @param hours Lookback window. Default 1, max 168.
   * @returns Array of logbook entries with `when`, `name`, `message`, `entity_id`.
   */
  function makeGetLogbook(client: HaClient) {
    return {
      name: "ha.get_logbook",
      label: "HA Get Logbook",
      description:
        "Get logbook entries. Optionally filter by entity_id. Defaults to last 1 hour.",
      parameters: Type.Object({
        entity_id: Type.Optional(Type.String({ description: "Filter to a specific entity" })),
        hours: Type.Optional(Type.Number({ description: "Hours back", minimum: 0.1, maximum: 168 }), {
          default: 1,
        }),
      }),
      async execute(_id, params) {
        return {
          content: [{ type: "text", text: JSON.stringify(await client.getLogbookEntries(params.entity_id, params.hours), null, 2) }],
        };
      },
    };
  }

  /**
   * List devices from the Home Assistant device registry.
   * @param area Optional filter by area ID.
   * @param manufacturer Optional case-insensitive partial match on manufacturer name.
   * @returns Array of Device objects with id, area_id, manufacturer, name.
   */
  function makeGetDevices(client: HaClient) {
    return {
      name: "ha.get_devices",
      label: "HA Get Devices",
      description:
        "List devices from the Home Assistant device registry. Optionally filter by area or manufacturer (partial match).",
      parameters: Type.Object({
        area: Type.Optional(Type.String({ description: "Filter by area ID" })),
        manufacturer: Type.Optional(Type.String({ description: "Filter by manufacturer (case-insensitive partial match)" })),
      }),
      async execute(_id, params) {
        return {
          content: [{ type: "text", text: JSON.stringify(await client.getDevices(params.area, params.manufacturer), null, 2) }],
        };
      },
    };
  }

  /**
   * List all areas defined in Home Assistant.
   * @returns Array of Area objects with area_id, name, aliases, icons.
   */
  function makeGetAreas(client: HaClient) {
    return {
      name: "ha.get_areas",
      label: "HA Get Areas",
      description: "List all areas in Home Assistant.",
      parameters: Type.Object({}),
      async execute() {
        return {
          content: [{ type: "text", text: JSON.stringify(await client.getAreas(), null, 2) }],
        };
      },
    };
  }

  /**
   * Compact entity list with area and device context, with optional filtering.
   * Uses 4 parallel WS calls to fetch states, areas, devices, entity_registry, then joins.
   * @param area Optional fuzzy match on area name or ID.
   * @param domain Optional filter ("light", "sensor", "climate").
   * @param entity_id Optional exact entity ID match.
   * @returns { summary, entities[], total } — compact format (~10–30 bytes entity vs 1000+ for full attributes).
   */
  function makeGetHomeContext(client: HaClient) {
    return {
      name: "ha.get_home_context",
      label: "HA Get Home Context",
      description:
        "Get a compact view of entities with area/device context. Returns entity_id, state, domain, area, and device — no bloated attributes. Unfiltered call returns ALL entities (10–30 bytes each). Use to explore; then filter by area/domain/entity_id for focused results.",
      parameters: Type.Object({
        area: Type.Optional(Type.String({ description: "Area name or ID to filter on (fuzzy match)." })),
        domain: Type.Optional(Type.String({ description: "Entity domain to filter on, e.g. light, sensor, climate." })),
        entity_id: Type.Optional(Type.String({ description: "Specific entity ID to return with context." })),
      }),
      annotations: { readOnly: true, idempotent: true },
      async execute(_id, params) {
        const result = await client.buildHomeContext({
          area: params.area,
          domain: params.domain,
          entity_id: params.entity_id,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    };
  }

  /**
   * Detailed information on a single entity, including up to 10 related entities.
   * @param entity_id Fully qualified entity ID.
   * @returns Entity details: state, attributes, domain, device_class, device_id, area_id, and related_entities (same_device or same_area).
   */
  function makeGetEntityDetails(client: HaClient) {
    return {
      name: "ha.get_entity_details",
      label: "HA Get Entity Details",
      description:
        "Get detailed information about a single entity including its relationships to devices, areas, and related entities. Returns state, attributes, domain, device/area info, and up to 10 related entities (same device or same area).",
      parameters: Type.Object({
        entity_id: Type.String({ description: "The entity ID to get details for." }),
      }),
      annotations: { readOnly: true, idempotent: true },
      async execute(_id, params) {
        const result = await client.getEntityDetails(params.entity_id);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    };
  }

  /**
   * Search entities by keywords across entity_id, friendly_name, and device_class.
   * Uses term frequency scoring: +1 per match, +2 for friendly_name, +1 for entity_id.
   * Requires `getStates()` to have been called first (caches state list in the client).
   * @param query Search query, e.g. "bedroom lights", "temperature sensors", "front door". Supports multi-word.
   * @returns Up to 20 SearchEntityResult objects sorted by relevance score, or empty array if no matches.
   */
  function makeSearchEntities(client: HaClient) {
    return {
      name: "ha.search_entities",
      label: "HA Search Entities",
      description:
        "Search for entities by name, type, or description using keyword matching against entity_id, friendly_name, and device_class. Returns entities ranked by relevance score (higher = better match), capped at 20 results.", 
      parameters: Type.Object({
        query: Type.String({ description: 'Search query (e.g. "bedroom lights", "temperature sensors", "front door").' }),
      }),
      annotations: { readOnly: true, idempotent: true },
      async execute(_id, params) {
        const results = await client.searchEntities(params.query);
        if (!results.length) return { content: [{ type: "text", text: `No entities found matching "${params.query}"` }] };
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      },
    };
  }

  /**
   * Recent error log entries from Home Assistant.
   * Tries the `error_log` REST endpoint first, falls back to logbook if unavailable.
   * @param lines Number of lines to return. Default 100, max 500.
   * @returns ErrorLogResult with summary string and log data, plus metadata (source, count).
   */
  function makeGetErrorLog(client: HaClient) {
    return {
      name: "ha.get_error_log",
      label: "HA Get Error Log",
      description:
        "Get recent Home Assistant error log lines. Defaults to 100 lines, max 500. Tries the error_log REST endpoint first, falls back to the Core journal if unavailable.",
      parameters: Type.Object({
        lines: Type.Optional(Type.Number({ description: "Number of recent lines to return", minimum: 1, maximum: 500 }), {
          default: 100,
        }),
      }),
      annotations: { readOnly: true, idempotent: true },
      async execute(_id, params) {
        const result = await client.getErrorLog(params.lines);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    };
  }

  /**
   * Call a Home Assistant service (e.g. light.turn_on, cover.open_cover).
   * Confirm-gated via ctx.ui.confirm. Annotated as destructive.
   * @param domain Service domain ("light", "switch", "cover", "select").
   * @param service Service name within that domain ("turn_on", "open_cover").
   * @param data Optional payload (e.g. { entity_id: "light.kitchen", brightness: 255 }).
   * @returns Success message or rejection notice.
   */
  function makeCallService(client: HaClient) {
    return {
      name: "ha.call_service",
      label: "HA Call Service",
      description:
        "Call a Home Assistant service. Requires user confirmation before executing. Use ha.get_services to discover available services.",
      parameters: Type.Object({
        domain: Type.String({ description: "Service domain, e.g. light, switch, automation" }),
        service: Type.String({ description: "Service name, e.g. turn_on, turn_off" }),
        data: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Service data fields" })),
      }),
      annotations: { destructive: true, idempotent: false },
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const target = `${params.domain}.${params.service}`;
        const approved = await ctx.ui.confirm(
          "Service Call",
          `Call ${target}${params.data ? `\ndata: ${JSON.stringify(params.data)}` : ""}?\n\nConfirm to proceed.`
        );
        if (!approved) return { content: [{ type: "text", text: "Service call rejected by user." }] };
        await client.send("call_service", { domain: params.domain, service: params.service, service_data: params.data });
        return { content: [{ type: "text", text: `Service ${target} called successfully.` }] };
      },
    };
  }

  /**
   * Toggle an entity (on/off, open/close, lock/unlock).
   * Confirm-gated via ctx.ui.confirm, calls homeassistant.toggle service internally.
   * @param entity_id Fully qualified entity ID.
   * @returns Success message or rejection notice.
   */
  function makeToggle(client: HaClient) {
    return {
      name: "ha.toggle",
      label: "HA Toggle",
      description: "Toggle an entity (on/off, open/close) by entity_id. Requires user confirmation.",
      parameters: Type.Object({
        entity_id: Type.String({ description: "Entity ID to toggle, e.g. light.kitchen" }),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const approved = await ctx.ui.confirm("Toggle Entity", `Toggle ${params.entity_id}?\n\nConfirm to proceed.`);
        if (!approved) return { content: [{ type: "text", text: "Toggle rejected by user." }] };
        await client.send("call_service", {
          domain: "homeassistant",
          service: "toggle",
          service_data: { entity_id: params.entity_id },
        });
        return { content: [{ type: "text", text: `Toggled ${params.entity_id}` }] };
      },
    };
  }

  /**
   * Validate Home Assistant configuration via the REST API.
   * @returns Success message or error details from HA's validation.
   */
  function makeValidateConfig(client: HaClient) {
    return {
      name: "ha.validate_config",
      label: "HA Validate Config",
      description: "Run Home Assistant's configuration check to validate the current config.",
      parameters: Type.Object({}),
      async execute() {
        const restUrl = client.config.url.replace(/^ws(s)?:\/\//, "http://").replace(/\/api\/websocket$/, "") + "/api/config/core/check_config";
        const resp = await fetch(restUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${client.config.token}` },
          agent: client.agent,
        });
        if (!resp.ok) throw new Error(`Config validation failed (${resp.status}): ${await resp.text()}`);
        return { content: [{ type: "text", text: "Configuration is valid." }] };
      },
    };
  }

  /**
   * Render a Jinja2 template in Home Assistant using the WS API.
   * Confirm-gated via ctx.ui.confirm.
   * @param template Jinja2 template string using HA template syntax.
   * @returns The rendered string result.
   */
  function makeRenderTemplate(client: HaClient) {
    return {
      name: "ha.render_template",
      label: "HA Render Template",
      description:
        "Render a Jinja2 template against Home Assistant's state. Returns the rendered string.",
      parameters: Type.Object({
        template: Type.String({ description: "Jinja2 template string to render" }),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const approved = await ctx.ui.confirm(
          "Render Template",
          `Render template:\n\`\`\`\n${params.template}\n\`\`\`\n\nConfirm to proceed.`
        );
        if (!approved) return { content: [{ type: "text", text: "Template rendering rejected by user." }] };
        return { content: [{ type: "text", text: await client.renderTemplate(params.template) }] };
      },
    };
  }

  /**
   * Fire an event in Home Assistant (e.g. trigger automations).
   * Confirm-gated via ctx.ui.confirm.
   * @param event_type Event name (e.g. "alarm_disarm", "custom_event").
   * @param event_data Optional payload for the event.
   * @returns Confirmation message.
   */
  function makeFireEvent(client: HaClient) {
    return {
      name: "ha.fire_event",
      label: "HA Fire Event",
      description:
        "Fire a custom or built-in event in Home Assistant.",
      parameters: Type.Object({
        event_type: Type.String({ description: "Event type name, e.g. calendar_event" }),
        event_data: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Event data payload" })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const approved = await ctx.ui.confirm(
          "Fire Event",
          `Fire event ${params.event_type}${params.event_data ? `\ndata: ${JSON.stringify(params.event_data)}` : ""}?\n\nConfirm to proceed.`
        );
        if (!approved) return { content: [{ type: "text", text: "Event firing rejected by user." }] };
        await client.fireEvent(params.event_type, params.event_data);
        return { content: [{ type: "text", text: `Event ${params.event_type} fired.` }] };
      },
    };
  }

  /**
   * Execute an automation script in Home Assistant.
   * Confirm-gated via ctx.ui.confirm. Annotated as destructive.
   * @param sequence Script definition: single action object or array of actions.
   * @returns Confirmation message.
   */
  function makeExecuteScript(client: HaClient) {
    return {
      name: "ha.execute_script",
      label: "HA Execute Script",
      description:
        "Execute an automation script in Home Assistant. Pass a sequence array or a single action object.",
      parameters: Type.Object({
        sequence: Type.Unknown({ description: "Script sequence (array of actions) or a single action object" }),
      }),
      annotations: { destructive: true, idempotent: false },
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const approved = await ctx.ui.confirm(
          "Execute Script",
          `Execute script:\n${JSON.stringify(params.sequence)}\n\nConfirm to proceed.`
        );
        if (!approved) return { content: [{ type: "text", text: "Script execution rejected by user." }] };
        await client.executeScript(params.sequence);
        return { content: [{ type: "text", text: "Script executed." }] };
      },
    };
  }

  /**
   * Test an automation condition against current HA state.
   * Useful for validating triggers/conditions before building automations.
   * @param condition Automation condition object, e.g. `{"condition":"state","entity_id":"light.kitchen","state":"on"}`.
   * @returns "met" or "not met" as text, with `annotations.result` boolean.
   */
  function makeTestCondition(client: HaClient) {
    return {
      name: "ha.test_condition",
      label: "HA Test Condition",
      description:
        "Test an automation condition against the current Home Assistant state. Returns true if the condition is met.",
      parameters: Type.Object({
        condition: Type.Record(Type.String(), Type.Unknown(), { description: 'Condition to test, e.g. {"condition":"state","entity_id":"light.kitchen","state":"on"}' }),
      }),
      async execute(_id, params) {
        const result = await client.testCondition(params.condition);
        return { content: [{ type: "text", text: `Condition ${result ? "met" : "not met"}.`, annotations: { result } }] };
      },
    };
  }

  /**
   * Get registry entry for an entity (disabled_by status, device_id, area_id).
   * Useful before calling toggle_device_disabled or audit entity setup.
   * @param entity_id Fully qualified entity ID.
   * @returns Registry entry with entity_id, disabled_by, device_id, area_id, original_id.
   */
  function makeGetEntityRegistryEntry(client: HaClient) {
    return {
      name: "ha.get_entity_registry_entry",
      label: "HA Get Entity Registry Entry",
      description:
        "Get the entity registry status of an entity, including whether it is currently disabled. Useful before disabling an entity.",
      parameters: Type.Object({
        entity_id: Type.String({ description: "Entity ID, e.g. light.bulb_w_02_lumiere" }),
      }),
      annotations: { readOnly: true, idempotent: true },
      async execute(_id, params) {
        const entry = await client.getEntityRegistryEntry(params.entity_id);
        return { content: [{ type: "text", text: JSON.stringify(entry, null, 2) }] };
      },
    };
  }

  /**
   * Get registry entry for a device (disabled_by status, config_entries).
   * Useful before calling toggle_device_disabled or audit device setup.
   * @param device_id Device ID (UUID), e.g. "01abc123def456".
   * @returns Registry entry with device_id, disabled_by, config_entries, identifiers.
   */
  function makeGetDeviceRegistryEntry(client: HaClient) {
    return {
      name: "ha.get_device_registry_entry",
      label: "HA Get Device Registry Entry",
      description:
        "Get the device registry status of a device, including whether it is currently disabled. Useful before disabling a device.",
      parameters: Type.Object({
        device_id: Type.String({ description: "Device ID, e.g. 01abc123def456" }),
      }),
      annotations: { readOnly: true, idempotent: true },
      async execute(_id, params) {
        const entry = await client.getDeviceRegistryEntry(params.device_id);
        return { content: [{ type: "text", text: JSON.stringify(entry, null, 2) }] };
      },
    };
  }

  /**
   * Disable or re-enable a device or entity via the registry REST API.
   * Target can be specified by entity_id or device_id. Confirm-gated.
   * @param entity_id Fully qualified entity ID. If provided, toggles entity disabled state.
   * @param device_id Device ID UUID. If entity_id not provided, toggles device disabled state.
   * @returns Result with action ("Enabled"/"Disabled"), entity/device ID, and disabled status.
   */
  function makeToggleDeviceDisabled(client: HaClient) {
    return {
      name: "ha.toggle_device_disabled",
      label: "HA Toggle Device Disabled",
      description:
        "Disable or re-enable a device or entity (toggles the disabled state). Requires confirmation.",
      parameters: Type.Object({
        entity_id: Type.Optional(Type.String({ description: "Entity ID to toggle. If omitted, targets device by device_id." })),
        device_id: Type.Optional(Type.String({ description: "Device ID to toggle. If omitted, targets entity." })),
      }),
      annotations: { destructive: true, idempotent: false },
      async execute(_id, params, _signal, _onUpdate, ctx) {
        if (params.entity_id) {
          const approved = await ctx.ui.confirm(
            "Toggle Entity Disabled",
            `Toggle disabled state of ${params.entity_id}?\n\nConfirm to proceed.`
          );
          if (!approved) return { content: [{ type: "text", text: "Operation cancelled." }] };
          const result = await client.toggleEntityDisabled(params.entity_id);
          const action = result.entity_disabled ? "Disabled" : "Enabled";
          return {
            content: [{ type: "text", text: JSON.stringify({
              action,
              entity_id: result.entity_id,
              entity_disabled: result.entity_disabled,
              device_id: result.device_id,
              device_disabled: result.device_disabled,
            }, null, 2) }],
          };
        }
        if (params.device_id) {
          const approved = await ctx.ui.confirm(
            "Toggle Device Disabled",
            `Toggle disabled state of device ${params.device_id}?\n\nConfirm to proceed.`
          );
          if (!approved) return { content: [{ type: "text", text: "Operation cancelled." }] };
          const result = await client.toggleDeviceDisabled(params.device_id);
          const action = result.disabled ? "Disabled" : "Enabled";
          return {
            content: [{ type: "text", text: JSON.stringify({ action, device_id: result.device_id, disabled: result.disabled }, null, 2) }],
          };
        }
        return { content: [{ type: "text", text: "Provide entity_id or device_id." }] };
      },
    };
  }

  /**
   * Get Home Assistant Supervisor version and health status.
   * Only works on HA OS with Supervisor (not Docker/Core standalone).
   * @returns Supervisor info JSON or "Not running on HA OS/Supervisor" notice.
   */
  function makeSupervisorInfo(client: HaClient) {
    return {
      name: "ha.supervisor_info",
      label: "HA Supervisor Info",
      description:
        "Get Home Assistant Supervisor information. Only works on HA OS/Supervisor installs (not Docker or Core). Returns version info and health status.",
      parameters: Type.Object({}),
      async execute() {
        const resp = await fetch(
          client.config.url.replace(/^ws(s)?:\/\//, "http://").replace(/\/api\/websocket$/, "") + "/api/supervisor/info",
          { headers: { Authorization: `Bearer ${client.config.token}` }, agent: client.agent }
        );
        if (resp.status === 404) return { content: [{ type: "text", text: "Not running on Home Assistant OS/Supervisor." }] };
        if (!resp.ok) throw new Error(`Supervisor info failed (${resp.status})`);
        return { content: [{ type: "text", text: JSON.stringify(await resp.json(), null, 2) }] };
      },
    };
  }
}
