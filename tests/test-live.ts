import { HaClient } from "../src/client.ts";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const args: Record<string, true> = Object.fromEntries(process.argv.slice(2).map((a) => [a, true]));

// ── Load config.json (base) ─────────────────────────────────────
const configPath = join(__dirname, "..", "config.json");
const fullConfig = existsSync(configPath)
  ? (() => { try { return JSON.parse(readFileSync(configPath, "utf-8")); } catch { return {}; } })()
  : {};

// ── Build tiers from config, override with CLI flags ─────────────
const parsed = (fullConfig as { tiers?: Record<string, boolean> }).tiers ?? {};
const tiers: { read: boolean; control: boolean; write: boolean } = {
  read: parsed.read ?? true,
  control: parsed.control ?? true,
  write: parsed.write ?? false,
};

if ("--read" in args) tiers.read = true; else if ("--no-read" in args) tiers.read = false;
if ("--control" in args) tiers.control = true; else if ("--no-control" in args) tiers.control = false;
if ("--write" in args) tiers.write = true; else if ("--no-write" in args) tiers.write = false;

const config = {
  url: process.env.HASS_URL!,
  token: process.env.HASS_TOKEN!,
  insecure: process.env.HASS_INSECURE === "true" || fullConfig.httpInsecure || "--insecure" in args,
};

// Disable TLS cert validation (--insecure flag): the agent's rejectUnauthorized:false
// covers self-signed certs, but NODE_TLS_REJECT_UNAUTHORIZED=0 is also needed to
// suppress ERR_TLS_CERT_ALTNAME_INVALID on hostname mismatch.
if (config.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

if ("--help" in args || "-h" in args) {
  console.log(`Usage: bun tests/test-live.ts [--read|--no-read] [--control|--no-control] [--write|--no-write] [--insecure]

Env vars: HASS_URL, HASS_TOKEN, HASS_INSECURE
Tiers: loaded from config.json, overridable with CLI flags.`);
  process.exit(0);
}

if (!config.url || !config.token) {
  console.error("No URL/tokens configured. Set HASS_URL and HASS_TOKEN env vars.");
  process.exit(1);
}

const client = new HaClient(config);

let passed = 0, failed = 0, skipped = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : String(e)}`);
    failed++;
  }
}

async function skip(name: string, reason: string, fn: () => Promise<void>) {
  console.log(`  ⦿ ${name} — ${reason}`);
  skipped++;
  // still exercise the API to catch regressions
  try {
    await fn();
  } catch {
    // silent — tool is skipped, regression test is best-effort
  }
}

async function main() {
  console.log(`HA: ${config.url}`);
  console.log(`tiers: read=${tiers.read}, control=${tiers.control}, write=${tiers.write}`);
  console.log(`(all tiers exercised regardless of config; disabled tiers marked ⦿)`);
  console.log();

  // ── Connect ──────────────────────────────────────────────
  console.log("--- Connection ---");
  await test("connect", async () => {
    await client.connect();
    if (!client.connected) throw new Error("not connected");
  });

  // ── read tier ────────────────────────────────────────────
  console.log("\n--- read tier ---");

  const rTest = tiers.read ? test : (name: string, fn: () => Promise<void>) => skip(name, "SKIP - not enabled", fn);

  await rTest("getConfig", async () => {
    const c = await client.getConfig();
    if (!c.version) throw new Error("no version");
    console.log(`    version: ${c.version}`);
  });

  await rTest("getServiceList", async () => {
    const s = await client.getServiceList();
    if (!s.light) throw new Error("no light domain");
    console.log(`    domains: ${Object.keys(s).length}`);
  });

  await rTest("getStates", async () => {
    const states = await client.getStates();
    if (!states.length) throw new Error("no states");
    console.log(`    entities: ${states.length}`);
  });

  await rTest("getDevices", async () => {
    const devices = await client.getDevices();
    if (!devices.length) throw new Error("no devices");
    console.log(`    devices: ${devices.length}`);
  });

  await rTest("getAreas", async () => {
    const areas = await client.getAreas();
    console.log(`    areas: ${areas.length}`);
  });

  await rTest("getEntityState (REST)", async () => {
    const states = client._lastStates || await client.getStates();
    const entity = states.find((s) => s.state !== "unavailable") || states[0];
    if (!entity) throw new Error("no entities");
    const state = await client.getEntityState(entity.entity_id);
    if (!state.entity_id) throw new Error("no entity_id in result");
  });

  await rTest("searchEntities", async () => {
    const results = await client.searchEntities("light");
    if (!results.length) console.log("    no 'light' matches");
    else console.log(`    matches: ${results.length}`);
  });

  await rTest("getEntityRegistryEntry (WS)", async () => {
    const states = client._lastStates || [];
    if (!states.length) throw new Error("no cached states");
    const entries = await client.getEntityRegistry();
    if (!entries.length) {
      console.log("    empty registry — skipping lookup");
      return;
    }
    const entry = await client.getEntityRegistryEntry(entries[0].entity_id);
    if (!entry.entity_id) throw new Error("no entity_id in result");
  });

  await rTest("getDeviceRegistryEntry (WS)", async () => {
    const devices = await client.getDevices();
    if (!devices.length) throw new Error("no devices");
    const entry = await client.getDeviceRegistryEntry(devices[0].id);
    if (!entry.id) throw new Error("no id in result");
  });

  await rTest("getHistory (REST)", async () => {
    const states = client._lastStates || [];
    if (!states.length) throw new Error("no cached states");
    const entity = states[0].entity_id;
    const history = await client.getHistory([entity], 0.5);
    console.log(`    history keys: ${Object.keys(history).length}`);
  });

  await rTest("getLogbookEntries (REST)", async () => {
    const entries = await client.getLogbookEntries(undefined, 0.5);
    console.log(`    logbook entries: ${entries.length}`);
  });

  await rTest("getErrorLog (REST)", async () => {
    const result = await client.getErrorLog(10);
    console.log(`    summary: ${result.summary}`);
  });

  await rTest("buildHomeContext", async () => {
    const result = await client.buildHomeContext({});
    if (!result.entities?.length) console.log("    no entities in context");
    else console.log(`    entities: ${result.entities.length}`);
  });

  await rTest("getEntityDetails", async () => {
    const states = client._lastStates || [];
    if (!states.length) throw new Error("no cached states");
    const details = await client.getEntityDetails(states[0].entity_id);
    if ("error" in details && typeof details === "object") console.log(`    has error`);
    else console.log(`    ok`);
  });

  await rTest("renderTemplate", async () => {
    const result = await client.renderTemplate("Hello {{ 'World' }}");
    if (result !== "Hello World") throw new Error(`got "${result}"`);
  });

  await rTest("testCondition", async () => {
    const result = await client.testCondition({
      condition: "state",
      entity_id: "sun.sun",
      state: "above_horizon",
    });
    console.log(`    condition: ${result}`);
  });

  await rTest("supervisor_info (REST)", async () => {
    const restUrl = config.url
      .replace(/^ws(s)?:\/\//, "http$1://")
      .replace(/\/api\/websocket$/, "");
    const url = restUrl + "/api/supervisor/info";
    console.log(`    fetching ${url}`);
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${config.token}` },
      agent: () => client.getAgent(url),
    });
    if (resp.status === 404) {
      console.log("    404 (not on HA OS/Supervisor) — expected");
    } else if (resp.ok) {
      const data = await resp.json();
      console.log(`    version: ${data.version || "unknown"}`);
    } else {
      throw new Error(`status ${resp.status}`);
    }
  });

  // ── control tier ─────────────────────────────────────────
  console.log("\n--- control tier ---");

  const cTest = tiers.control ? test : (name: string, fn: () => Promise<void>) => skip(name, "SKIP - not enabled", fn);

  await cTest("fireEvent", async () => {
    await client.fireEvent("test_omp_ping", { time: Date.now() });
  });

  await cTest("executeScript", async () => {
    await client.executeScript([{ delay: "0:00:00.001" }]);
  });

  await cTest("callService (toggle switch)", async () => {
    const results = await client.searchEntities("switch");
    if (results.length) {
      await client.send("call_service", {
        domain: "homeassistant",
        service: "toggle",
        service_data: { entity_id: results[0].entity_id },
      });
      console.log(`    toggled ${results[0].entity_id}`);
    } else {
      console.log("    no switch found — skipping toggle");
    }
  });

  // ── write tier ───────────────────────────────────────────
  console.log("\n--- write tier ---");

  const wTest = tiers.write ? test : (name: string, fn: () => Promise<void>) => skip(name, "SKIP - not enabled", fn);

  await wTest("validate_config (REST)", async () => {
    const restUrl = config.url
      .replace(/^ws(s)?:\/\//, "http$1://")
      .replace(/\/api\/websocket$/, "");
    const url = restUrl + "/api/config/core/check_config";
    const resp = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}` },
      agent: () => client.getAgent(url),
    });
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    console.log("    config valid");
  });

  await wTest("toggleEntityDisabled (WS update)", async () => {
    const entityId = "binary_sensor.sun_solar_rising";
    try {
      const entry = await client.getEntityRegistryEntry(entityId);
      console.log(`    testing ${entityId} (${entry.name || "unnamed"})`);
    } catch {
      console.log(`    ${entityId} not in registry -- skipping`);
      return;
    }
    const result = await client.toggleEntityDisabled(entityId);
    console.log(`    disabled: ${result.entity_disabled}`);
    // toggle back
    await client.toggleEntityDisabled(entityId);
  });

  await wTest("toggleDeviceDisabled (WS update)", async () => {
    const devices = await client.getDevices();
    if (!devices.length) {
      console.log("    no devices -- skipping");
      return;
    }
    const device = devices[0];
    console.log(`    testing ${device.id} (${device.name_by_user || device.name || "unnamed"})`);
    const result = await client.toggleDeviceDisabled(device.id);
    console.log(`    disabled: ${result.disabled}`);
    // toggle back
    await client.toggleDeviceDisabled(device.id);
  });

  await client.close();

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
