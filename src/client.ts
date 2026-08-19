import { WebSocket } from "ws";
import https from "node:https";
import http from "node:http";

// ── Types ──────────────────────────────────────────────────────────

export interface EntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

export interface HaConfig {
  latitude: number;
  longitude: number;
  elevation: number;
  unit_system: { length: string; mass: string; temperature: string; volume: string };
  time_zone: string;
  locations: object;
  components: string[];
  config_dir: string;
  version: string;
  config_source: string;
  state: string;
  safe_mode: boolean;
  api: object | null;
}

export interface HaClientConfig {
  url: string;
  token: string;
  /**
   * Allow insecure TLS connections (skip certificate validation).
   *
   * SECURITY RISK: with insecure=true the connection is vulnerable
   * to man-in-the-middle attacks. Only enable when your HA instance
   * uses a self-signed certificate or a hostname that does not match
   * the certificate, but you trust your connection. Default: false.
   */
  insecure?: boolean;
}

export interface HomeContextEntity {
  entity_id: string;
  state: string;
  domain: string;
  area_id: string | null;
  area: string | null;
  device_id: string | null;
  device: string | null;
}

export interface HomeContextResult {
  summary: string;
  entities: HomeContextEntity[];
  total: number;
}

export interface EntityDetails {
  entity_id: string;
  friendly_name: string | null;
  state: string;
  attributes: Record<string, unknown>;
  domain: string;
  device_class: string | null;
  device_id: string | null;
  area_id: string | null;
  related_entities: Array<{
    entity_id: string;
    friendly_name: string | null;
    state: string;
    relationship: "same_device" | "same_area";
  }>;
}

export interface SearchEntityResult {
  entity_id: string;
  state: string;
  friendly_name: string | null;
  device_class: string | null;
  score: number;
}

export interface ErrorLogResult {
  summary: string;
  data: { log: string };
  meta: { requested_lines: number; returned_lines: number; source: string; fallback_used: boolean };
}

// ── WebSocket client ───────────────────────────────────────────────

export class HaClient {
  private ws: WebSocket | null = null;
  private id = 1;
  private authed = false;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private pendingEvents = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly _config: HaClientConfig;
  private _lastStates: EntityState[] | null = null;

  // Keepalive / reconnect
  private _keepalive: NodeJS.Timeout | null = null;
  private _pongTimer: NodeJS.Timeout | null = null;
  private _expectingPong = false;
  private _closing = false;

  constructor(config: HaClientConfig) {
    this._config = config;
  }

  /** https.Agent for WS + HTTPS REST calls — respects insecure config flag. */
  protected get _httpsAgent(): https.Agent {
    if (this._config.insecure) {
      return new https.Agent({ rejectUnauthorized: false });
    }
    return https.globalAgent;
  }

  /** http.Agent — mirrors _httpsAgent for plain-HTTP REST calls. */
  protected get _httpAgent(): http.Agent {
    return http.globalAgent;
  }

  /** Pick the correct agent for a URL by scheme (ws/wss/https/http all supported). */
  getAgent(url: string): http.Agent | https.Agent {
    return url.startsWith("wss") || url.startsWith("https") ? this._httpsAgent : this._httpAgent;
  }

  /** Whether a live WS connection is established. */
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
  get config(): HaClientConfig { return this._config; }

  async connect(): Promise<void> {
    if (this._closing) throw new Error("Client is closing");
    if (this.ws?.readyState === WebSocket.OPEN) return;

    // Reset state for reconnection
    this.authed = false;
    this.id = 1;
    this._stopKeepalive();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws = null;
    }

    await new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(this.config.url, { agent: this.getAgent(this.config.url) });
      const authTimeout = setTimeout(() => {
        this.ws?.close();
        this.ws = null;
        reject(new Error("HA auth timed out — check URL and token"));
      }, 10_000);

      this.ws.on("open", () => {
        this.ws?.on("close", () => {
          clearTimeout(authTimeout);
          this._stopKeepalive();
          this.authed = false;
          if (!this._closing) {
            for (const [, { reject }] of this.pending) reject(new Error("Disconnected — will reconnect"));
            this.pending.clear();
          }
          this.ws = null;
        });
      });

      this.ws.on("message", (data) => {
        const raw = data.toString();
        const msg = JSON.parse(raw);

        if (msg.type === "auth_required" && !this.authed && this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: "auth", access_token: this.config.token }));
          return;
        }
        if (msg.type === "auth_ok") {
          clearTimeout(authTimeout);
          this.authed = true;
          this._startKeepalive();
          resolve();
          return;
        }
        if (msg.type === "auth_invalid") {
          this.ws?.close();
          this.ws = null;
          reject(new Error("Invalid access token"));
          return;
        }
        this.handleMessage(raw);
      });

      this.ws.on("pong", () => {
        this._expectingPong = false;
        if (this._pongTimer) {
          clearTimeout(this._pongTimer);
          this._pongTimer = null;
        }
      });

      this.ws.on("error", (err) => {
        clearTimeout(authTimeout);
        this._stopKeepalive();
        // If auth hasn't completed yet, propagate the error
        if (!this.authed) {
          this.ws?.close();
          this.ws = null;
          reject(new Error(typeof err.message === "string" ? err.message : "TLS handshake failed"));
        }
        // Otherwise close handler will clean up pending requests
      });
    });
  }

  async send<T extends Record<string, unknown>>(type: string, payload?: T): Promise<unknown> {
    // Retry loop with exponential backoff: initial + 3 retries (1s, 2s, 4s)
    let lastErr: Error | undefined;
    const maxDelay = 4000;
    for (let attempt = 0, delay = 1000; attempt <= 3; attempt++, delay = Math.min(delay * 2, maxDelay)) {
      try {
        await this.connect();
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("WebSocket not open");

        const id = this.id++;
        const result = await new Promise<unknown>((resolve, reject) => {
          const timeout = setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`Command ${type} timed out`));
          }, 30_000);

          this.pending.set(id, {
            resolve: (v) => { clearTimeout(timeout); this.pending.delete(id); resolve(v); },
            reject: (e) => { clearTimeout(timeout); this.pending.delete(id); reject(e); },
          });

          this.ws!.send(JSON.stringify({ id, type, ...payload }));
        });
        return result;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        // Don't retry on invalid token
        if (lastErr.message.includes("Invalid access token")) throw lastErr;
        if (attempt < 3) {
          // Reset connection state so connect() will create a new socket
          this.ws?.removeAllListeners();
          this.ws?.close();
          this.ws = null;
          this.authed = false;
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastErr ?? new Error(`Command ${type} failed after retries`);
  }

  private handleMessage(raw: string) {
    let msg: { id: number; type: string; success: boolean; result?: unknown; error?: { code: string; message: string } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const { id, type, success, result, error } = msg;

    if (type === "auth_required" && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "auth", access_token: this.config.token }));
      return;
    }
    if (type === "auth_ok") return;

    const pending = this.pending.get(id);
    if (pending && type === "result") {
      if (success) {
        pending.resolve(result);
      } else {
        pending.reject(new Error(`${error?.code}: ${error?.message}`));
      }
      return;
    }

    if (type === "event" && id) {
      const wait = this.pendingEvents.get(id);
      if (wait) {
        this.pendingEvents.delete(id);
        const event = (msg as any).event;
        wait.resolve(event);
      }
      return;
    }
  }

  private _startKeepalive(): void {
    this._stopKeepalive();
    // HA closes idle WS after ~30s. Ping every 15s.
    this._keepalive = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this._stopKeepalive();
        return;
      }
      try {
        this.ws.ping(Buffer.from("keepalive"));
      } catch {
        this._stopKeepalive();
        return;
      }
      this._expectingPong = true;
      if (this._pongTimer) clearTimeout(this._pongTimer);
      this._pongTimer = setTimeout(() => {
        if (this._expectingPong) {
          // No pong received — connection is dead, force reconnect
          this._stopKeepalive();
          this.ws?.terminate();
          this.ws = null;
          this.authed = false;
          // Reject pending requests so send() will retry
          for (const [, { reject }] of this.pending) reject(new Error("Ping timeout — reconnecting"));
          this.pending.clear();
        }
      }, 8000);
    }, 15000);
    // Prevent keepalive timer from keeping process alive
    if (this._keepalive.unref) this._keepalive.unref();
  }

  private _stopKeepalive(): void {
    if (this._keepalive) { clearInterval(this._keepalive); this._keepalive = null; }
    if (this._pongTimer) { clearTimeout(this._pongTimer); this._pongTimer = null; }
    this._expectingPong = false;
  }

  close(): void {
    this._closing = true;
    this._stopKeepalive();
    for (const [, { reject }] of this.pendingEvents) reject(new Error("Closed"));
    this.pendingEvents.clear();
    this.ws?.close();
    this.ws = null;
  }

  // ── API helpers ──────────────────────────────────────────────────

  private getBaseUrl(): string {
    return this.config.url
      .replace(/^wss:\/\//, "https://")
      .replace(/^ws:\/\//, "http://")
      .replace(/\/api\/websocket$/, "");
  }

  private getRestUrl(path: string): string {
    return this.getBaseUrl() + path;
  }

  async getStates(): Promise<EntityState[]> {
    this._lastStates = await this.send("get_states") as EntityState[];
    return this._lastStates;
  }

  async searchEntities(query: string): Promise<SearchEntityResult[]> {
    const states = this._lastStates ??= await this.getStates();
    const queryLower = query.toLowerCase();
    const terms = queryLower.split(/\s+/);

    return states
      .map((state) => {
        let score = 0;
        const searchText = [
          state.entity_id,
          state.attributes?.friendly_name || "",
          state.attributes?.device_class || "",
          state.state,
        ].join(" ").toLowerCase();

        for (const term of terms) {
          if (searchText.includes(term)) {
            score += 1;
            if ((state.attributes?.friendly_name || "").toLowerCase().includes(term)) score += 2;
            if (state.entity_id.includes(term)) score += 1;
          }
        }

        return { state, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((r) => ({
        entity_id: r.state.entity_id,
        state: r.state.state,
        friendly_name: (r.state.attributes?.friendly_name as string) || null,
        device_class: (r.state.attributes?.device_class as string) || null,
        score: r.score,
      }));
  }

  async getErrorLog(lines = 100): Promise<ErrorLogResult> {
    lines = Math.max(1, Math.min(500, lines));

    // 1) error_log REST (Supervisor add-on — primary source)
    try {
      const errorLogUrl = this.getRestUrl("/error_log");
      const resp = await fetch(errorLogUrl, {
        headers: { Authorization: `Bearer ${this.config.token}` },
        agent: () => this.getAgent(errorLogUrl),
      });
      if (resp.ok) {
        const text = await resp.text();
        const allLines = text.split("\n");
        if (allLines.at(-1) === "") allLines.pop();
        const logLines = allLines.slice(-lines);
        return {
          summary: `Returned ${logLines.length} Home Assistant error log lines`,
          data: { log: logLines.join("\n") },
          meta: { requested_lines: lines, returned_lines: logLines.length, source: "error_log", fallback_used: false },
        };
      }
      if (resp.status !== 404) throw new Error(`error_log ${resp.status}`);
    } catch (e) {
      // 404 or network error — fall through
    }

    // 2) Logbook REST (tracks all events — HA start/stop, state changes, service calls)
    const entries = await this.getLogbookEntries(undefined, Math.min(lines / 5 + 0, 24));
    const recent = entries
      .slice(-lines)
      .map((e) => {
        const time = typeof e.when === "number" ? new Date(e.when * 1000).toISOString() : e.when;
        const msg = e.message || e.state;
        return `[${time}] ${e.name || "-"}: ${msg || "state change"}`;
      })
      .join("\n");
    if (recent) {
      const returned = recent.split("\n").length;
      return {
        summary: `Returned ${returned} recent logbook entries`,
        data: { log: recent },
        meta: { requested_lines: lines, returned_lines: returned, source: "logbook", fallback_used: true },
      };
    }

    throw new Error("No log source available (error_log add-on not present, logbook empty)");
  }
  async getEntityState(entityId: string): Promise<EntityState | { entity_id: string; state: "not_found"; attributes: {}; last_changed: string; last_updated: string }> {
    await this.connect();
    const restUrl = this.getRestUrl(`/api/states/${entityId}`);
    const resp = await fetch(restUrl, {
      headers: { Authorization: `Bearer ${this.config.token}` },
      agent: () => this.getAgent(restUrl),
    });
    if (resp.status === 404) return { entity_id: entityId, state: "not_found", attributes: {}, last_changed: "", last_updated: "" };
    if (!resp.ok) throw new Error(`HA API ${resp.status}: ${await resp.text()}`);
    return resp.json();
  }

  async getServiceList(): Promise<Record<string, Record<string, ServiceSpec[]>>> {
    const res = await this.send("get_services");
    return res as unknown as Record<string, Record<string, ServiceSpec[]>>;
  }

  async getConfig(): Promise<HaConfig> {
    const res = await this.send("get_config");
    return res as unknown as HaConfig;
  }

  async getAreas(): Promise<Area[]> {
    const res = await this.send("config/area_registry/list");
    return res as unknown as Area[];
  }

  async getDevices(area?: string, manufacturer?: string): Promise<Device[]> {
    const res = await this.send("config/device_registry/list");
    let devices = res as unknown as Device[];
    if (area) devices = devices.filter((d) => d.area_id === area);
    if (manufacturer) devices = devices.filter((d) => d.manufacturer?.toLowerCase().includes(manufacturer.toLowerCase()));
    return devices;
  }

  async getEntityRegistry(): Promise<EntityRegistryEntry[]> {
    const res = await this.send("config/entity_registry/list");
    return res as unknown as EntityRegistryEntry[];
  }

  async getHistory(entityIds: string[], hours = 1): Promise<Record<string, HistoryEntry[]>> {
    const restUrl = this.getRestUrl("/api/history/period");
    const start = new Date(Date.now() - hours * 3600_000).toISOString();
    const params = new URLSearchParams({
      filter_entity_id: entityIds.join(","),
      minimal_response: "true",
    });
    const fetchUrl = `${restUrl}/${start}?${params}`;
    const resp = await fetch(fetchUrl, {
      headers: { Authorization: `Bearer ${this.config.token}` },
      agent: () => this.getAgent(fetchUrl),
    });
    if (!resp.ok) throw new Error(`HA API ${resp.status}: ${await resp.text()}`);
    const groupByEntity = (await resp.json()) as HistoryRecord[][];
    const result: Record<string, HistoryEntry[]> = {};
    for (const group of groupByEntity) {
      let currentEntityId = group[0]?.entity_id;
      for (const e of group) {
        if (e.entity_id) currentEntityId = e.entity_id;
        if (!result[currentEntityId]) result[currentEntityId] = [];
        result[currentEntityId].push({ last_changed: e.last_changed, state: e.state as string });
      }
    }
    return result;
  }

  async renderTemplate(template: string): Promise<string> {
    await this.connect();
    const id = this.id++;
    this.ws!.send(JSON.stringify({ id, type: "render_template", template }));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingEvents.delete(id);
        reject(new Error("render_template timed out"));
      }, 30_000);
      this.pendingEvents.set(id, {
        resolve: (v) => { clearTimeout(timeout); this.pendingEvents.delete(id); resolve((v as any).result as string); },
        reject: (e) => { clearTimeout(timeout); this.pendingEvents.delete(id); reject(e); },
      });
    });
  }

  async fireEvent(eventType: string, eventData?: Record<string, unknown>): Promise<void> {
    await this.send("fire_event", { event_type: eventType, event_data: eventData });
  }

  async executeScript(sequence: unknown): Promise<void> {
    await this.send("execute_script", { sequence });
  }

  async testCondition(condition: Record<string, unknown>): Promise<boolean> {
    const res = await this.send("test_condition", { condition });
    return (res as { result: boolean }).result;
  }

  async getLogbookEntries(entityId?: string, hours = 1): Promise<LogbookEntry[]> {
    const restUrl = this.getRestUrl("/api/logbook");
    const start = new Date(Date.now() - hours * 3600_000).toISOString();
    const end = new Date().toISOString();
    const params = new URLSearchParams({ end_time: end });
    if (entityId) params.set("entity", entityId);
    const resp = await fetch(`${restUrl}/${start}?${params}`, {
      headers: { Authorization: `Bearer ${this.config.token}` },
      agent: () => this.getAgent(restUrl),
    });
    if (!resp.ok) throw new Error(`HA API ${resp.status}: ${await resp.text()}`);
    return resp.json();
  }

  async buildHomeContext(args: { area?: string; domain?: string; entity_id?: string }): Promise<HomeContextResult> {
    const [states, areas, devices, entityReg] = await Promise.all([
      this.getStates(),
      this.getAreas(),
      this.getDevices(),
      this.getEntityRegistry(),
    ]);

    const areasById = new Map(areas.map((a) => [a.area_id, a]));
    const devicesById = new Map(devices.map((d) => [d.id, d]));
    const entById = new Map(entityReg.map((e) => [e.entity_id, e]));

    let entities: HomeContextEntity[] = states
      .filter((s) => !s.attributes?.hidden)
      .map((s) => {
        const reg = entById.get(s.entity_id) || ({} as EntityRegistryEntry);
        const dev = reg.device_id ? devicesById.get(reg.device_id) : null;
        const areaId = reg.area_id || dev?.area_id || null;
        const area = areaId ? areasById.get(areaId) : null;
        return {
          entity_id: s.entity_id,
          state: s.state,
          domain: s.entity_id.split(".")[0],
          area_id: areaId,
          area: area?.name || null,
          device_id: reg.device_id || null,
          device: dev?.name_by_user || dev?.name || null,
        };
      });

    if (args.area) {
      const lower = args.area.toLowerCase();
      const matchedId = [...areasById.values()].filter((a) => a.name?.toLowerCase().includes(lower) || a.area_id?.toLowerCase().includes(lower)).map((a) => a.area_id);
      entities = entities.filter((e) => e.area_id && matchedId.includes(e.area_id));
    }
    if (args.domain) entities = entities.filter((e) => e.domain === args.domain);
    if (args.entity_id) entities = entities.filter((e) => e.entity_id === args.entity_id);

    entities.sort((a, b) => (a.area || "").localeCompare(b.area || "") || a.entity_id.localeCompare(b.entity_id));

    return { summary: `${entities.length} entities`, entities, total: entities.length };
  }

  async getEntityDetails(entityId: string): Promise<EntityDetails | { error: string }> {
    const [states, areas, devices, entityReg] = await Promise.all([
      this.getStates(),
      this.getAreas(),
      this.getDevices(),
      this.getEntityRegistry(),
    ]);

    const entity = states.find((s) => s.entity_id === entityId);
    if (!entity) return { error: `Entity ${entityId} not found` };

    const [domain] = entityId.split(".");
    const reg = entityReg.find((e) => e.entity_id === entityId);
    const deviceId = entity.attributes?.device_id as string | undefined;
    let areaId = reg?.area_id || (entity.attributes?.area_id as string);

    // Resolve area_id via device if not on entity/registry
    if (!areaId && deviceId) {
      const dev = devices.find((d) => d.id === deviceId);
      areaId = dev?.area_id || null;
    }

    // Build lookup maps for efficient filtering
    const regById = new Map(entityReg.map((e) => [e.entity_id, e]));
    const devById = new Map(devices.map((d) => [d.id, d]));

    // Find related entities (same device or same area, excluding self)
    const related: EntityDetails["related_entities"] = [];
    const seen = new Set<string>();
    for (const s of states) {
      if (s.entity_id === entityId) continue;
      const sReg = regById.get(s.entity_id);
      const sDev = (s.attributes?.device_id || sReg?.device_id) as string | undefined;
      const sArea = (sReg?.area_id || (s.attributes?.area_id as string) ||
        (sDev ? (devById.get(sDev)?.area_id || null) : null));

      let rel: "same_device" | "same_area" | null = null;
      if (deviceId && sDev === deviceId) rel = "same_device";
      else if (areaId && sArea === areaId && !rel) rel = "same_area";

      if (rel && !seen.has(s.entity_id)) {
        seen.add(s.entity_id);
        related.push({
          entity_id: s.entity_id,
          friendly_name: (s.attributes?.friendly_name as string) || null,
          state: s.state,
          relationship: rel,
        });
      }
      if (related.length >= 10) break;
    }

    return {
      entity_id: entityId,
      friendly_name: (entity.attributes?.friendly_name as string) || null,
      state: entity.state,
      attributes: entity.attributes,
      domain,
      device_class: (entity.attributes?.device_class as string) || null,
      device_id: deviceId || null,
      area_id: areaId || null,
      related_entities: related,
    };
  }

  // ── Device/Entity registry management ────────────────────────────

  async getEntityRegistryEntry(entityId: string) {
    const entries = await this.getEntityRegistry();
    const entry = entries.find((e) => e.entity_id === entityId);
    if (!entry) throw new Error(`Entity ${entityId} not found in registry`);
    return entry;
  }

  async toggleEntityDisabled(entityId: string):
    Promise<{ entity_id: string; entity_disabled: boolean; device_id: string | null; device_disabled: boolean }> {
    const entry = await this.getEntityRegistryEntry(entityId);
    const currentDisabled = entry.disabled_by === "user";
    const newDisabledBy = currentDisabled ? null : "user";

    const result = await this.send("config/entity_registry/update", {
      entity_id: entityId,
      disabled_by: newDisabledBy,
    });

    const deviceId = result.device_id as string | null;
    let deviceDisabled = false;
    if (deviceId) {
      try {
        const dev = await this.getDeviceRegistryEntry(deviceId);
        deviceDisabled = dev.disabled_by === "user";
      } catch {
        // device may not exist
      }
    }
    return {
      entity_id: entityId,
      entity_disabled: newDisabledBy === "user",
      device_id: deviceId,
      device_disabled: deviceDisabled,
    };
  }

  async getDeviceRegistryEntry(deviceId: string) {
    const devices = await this.getDevices();
    const entry = devices.find((d) => d.id === deviceId);
    if (!entry) throw new Error(`Device ${deviceId} not found in registry`);
    return entry;
  }

  async toggleDeviceDisabled(deviceId: string):
    Promise<{ device_id: string; disabled: boolean }> {
    const entry = await this.getDeviceRegistryEntry(deviceId);
    const currentDisabled = entry.disabled_by === "user";
    const newDisabledBy = currentDisabled ? null : "user";

    await this.send("config/device_registry/update", {
      device_id: deviceId,
      disabled_by: newDisabledBy,
    });
    return { device_id: deviceId, disabled: newDisabledBy === "user" };
  }
}

interface HistoryEntry {
  last_changed?: string;
  state: string;
}

interface HistoryRecord {
  entity_id: string;
  state: unknown;
  attributes: Record<string, unknown>;
  last_changed?: string;
}

interface Device {
  id: string;
  area_id: string | null;
  manufacturer?: string;
  name?: string;
  name_by_user?: string;
  disabled_by?: string | null;
}

interface ServiceSpec {
  name: string;
  description: string;
  fields?: Record<string, unknown>;
}

interface Area {
  area_id: string;
  name: string;
  aliases?: string[];
  icons?: { type: string; icon: string }[];
}

interface EntityRegistryEntry {
  entity_id: string;
  area_id: string | null;
  device_id: string | null;
  name?: string;
  original_name?: string;
  disabled_by?: string | null;
}

interface LogbookEntry {
  when: number;
  name: string;
  message: string;
  entity_id?: string;
  domain?: string;
  context?: { id: string; parent_id: string | null; user_id: string | null };
}
