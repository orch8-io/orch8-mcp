// Orch8 embedded-workflows MCP server.
//
// A Model Context Protocol server authenticated by an `o8e1` embed token
// (a vendor-issued, sub-tenant-scoped, short-lived credential). It exposes
// ONLY what that token allows, as MCP tools:
//
//   start_<sequence>        runs:start, one tool per allowed sequence,
//                           inputSchema = the sequence's input_schema when readable
//   list_runs, get_run      runs:read
//   list_pending_approvals  approvals:resolve or runs:read
//   resolve_approval        approvals:resolve
//
// Every call goes to the engine's embed routes (`/api/v1/embed/*`) with
// `Authorization: Bearer o8e1...`; the engine verifies the HMAC, expiry,
// sub-tenant and sequence allow-list on each request. This server has no
// tenant API key, never calls tenant routes, and has no tenant-level tools
// (list_sequences, create_instance, send_signal, get_usage, ...): a call to
// any tool outside the token's catalog is rejected as an unknown tool.
//
// No dependencies: Node 18+ (global fetch). Transports: http.mjs (Streamable
// HTTP) and bin.mjs (CLI, stdio).

export const TOKEN_PREFIX = "o8e1.";
export const SCOPES = Object.freeze([
  "runs:read",
  "runs:start",
  "approvals:resolve",
  "sequences:read",
  "builder:edit",
]);

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const KNOWN_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const TOOL_NAME_MAX = 64;
const CATALOG_TTL_MS = 60_000;
const SERVER_VERSION = "0.1.0";

export class EmbedTokenError extends Error {
  constructor(message) {
    super(message);
    this.name = "EmbedTokenError";
  }
}

function b64urlDecode(segment) {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
}

/**
 * Decode (not verify: only the engine holds the secret) an `o8e1` embed token
 * and check its shape and expiry. Used to decide which tools to show; the
 * engine still enforces every claim server-side.
 */
export function decodeEmbedToken(token, nowMs = Date.now()) {
  if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) {
    throw new EmbedTokenError("expected an o8e1 embed token");
  }
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1] || !parts[2] || !/^[A-Za-z0-9_-]+$/.test(parts[1] + parts[2])) {
    throw new EmbedTokenError("malformed embed token");
  }
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(parts[1]));
  } catch {
    throw new EmbedTokenError("malformed embed token payload");
  }
  if (!payload || typeof payload !== "object" || payload.v !== 1) {
    throw new EmbedTokenError("unsupported embed token version");
  }
  if (typeof payload.tid !== "string" || typeof payload.sub !== "string") {
    throw new EmbedTokenError("embed token lacks tenant or sub-tenant");
  }
  if (!Array.isArray(payload.scp) || payload.scp.some((s) => typeof s !== "string")) {
    throw new EmbedTokenError("embed token scopes must be a list");
  }
  if (payload.seq !== null && payload.seq !== undefined &&
      (!Array.isArray(payload.seq) || payload.seq.some((s) => typeof s !== "string"))) {
    throw new EmbedTokenError("embed token sequences must be a list or null");
  }
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= nowMs) {
    throw new EmbedTokenError("embed token expired");
  }
  return {
    tenant: payload.tid,
    subTenant: payload.sub,
    scopes: new Set(payload.scp.filter((s) => SCOPES.includes(s))),
    sequences: Array.isArray(payload.seq) ? [...new Set(payload.seq)] : null,
    expiresAt: payload.exp,
    jti: typeof payload.jti === "string" ? payload.jti : null,
  };
}

/** MCP tool names: `[A-Za-z0-9_-]{1,64}`. */
export function startToolName(sequence, taken = new Set()) {
  const slug = sequence.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "sequence";
  let name = `start_${slug}`.slice(0, TOOL_NAME_MAX);
  for (let i = 2; taken.has(name); i += 1) {
    const suffix = `_${i}`;
    name = `start_${slug}`.slice(0, TOOL_NAME_MAX - suffix.length) + suffix;
  }
  return name;
}

const OPEN_OBJECT = Object.freeze({ type: "object", additionalProperties: true });

/** Tool inputSchema for a sequence: its input_schema when it is an object schema, else wrapped. */
function startInputSchema(inputSchema) {
  if (inputSchema && typeof inputSchema === "object" && !Array.isArray(inputSchema)) {
    if (inputSchema.type === "object" || (inputSchema.type === undefined && inputSchema.properties)) {
      return { schema: { type: "object", ...inputSchema }, wrapped: false };
    }
    return {
      schema: { type: "object", properties: { input: inputSchema }, required: ["input"], additionalProperties: false },
      wrapped: true,
    };
  }
  return { schema: { ...OPEN_OBJECT }, wrapped: false };
}

function pickInputSchema(body) {
  if (!body || typeof body !== "object") return undefined;
  return body.input_schema ?? body.definition?.input_schema ?? body.sequence?.input_schema;
}

class EngineError extends Error {
  constructor(status, body, path) {
    const detail = body && typeof body === "object"
      ? body.message ?? body.error ?? JSON.stringify(body)
      : body;
    super(`engine returned ${status} on ${path}${detail ? `: ${detail}` : ""}`);
    this.status = status;
  }
}

/**
 * Build an embed-mode MCP session for one token.
 *
 * @param {object} options
 * @param {string} options.baseUrl  Engine base URL (e.g. https://orch8.example.com).
 * @param {string | (() => string | Promise<string>)} options.token  o8e1 token, or a provider for refresh.
 * @param {typeof fetch} [options.fetch]
 * @param {() => number} [options.now]
 * @param {number} [options.timeoutMs]  Per-request timeout. Default 30000.
 */
export function createEmbedMcp(options) {
  if (!options?.baseUrl) throw new TypeError("createEmbedMcp requires baseUrl");
  if (!options.token) throw new TypeError("createEmbedMcp requires an o8e1 token or token provider");
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 30_000;
  let catalog = null; // { token, builtAt, tools, starts: Map<toolName, {sequence, wrapped}> }

  async function currentToken() {
    const token = typeof options.token === "function" ? await options.token() : options.token;
    return { token, claims: decodeEmbedToken(token, now()) };
  }

  async function call(token, method, path, body) {
    if (!path.startsWith("/")) throw new Error("embed path must be absolute");
    const url = `${base}/api/v1/embed${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = res.status === 204 ? "" : await res.text();
      let parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      if (!res.ok) throw new EngineError(res.status, parsed, `/api/v1/embed${path}`);
      return parsed ?? {};
    } finally {
      clearTimeout(timer);
    }
  }

  async function sequenceSchema(token, claims, sequence) {
    if (!claims.scopes.has("sequences:read")) return undefined;
    try {
      return pickInputSchema(await call(token, "GET", `/sequences/${encodeURIComponent(sequence)}`));
    } catch {
      return undefined;
    }
  }

  async function allowedSequences(token, claims) {
    if (claims.sequences) return claims.sequences.map((name) => ({ name }));
    // seq: null means "every sequence of the sub-tenant": enumerate them if we may.
    if (!claims.scopes.has("sequences:read")) return [];
    try {
      const body = await call(token, "GET", "/sequences");
      const items = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : [];
      return items
        .map((item) => (typeof item === "string" ? { name: item } : item))
        .filter((item) => item && typeof item.name === "string");
    } catch {
      return [];
    }
  }

  async function buildCatalog() {
    const { token, claims } = await currentToken();
    if (catalog && catalog.token === token && now() - catalog.builtAt < CATALOG_TTL_MS) return catalog;
    const tools = [];
    const starts = new Map();
    const has = (s) => claims.scopes.has(s);

    if (has("runs:start")) {
      const taken = new Set();
      for (const seq of await allowedSequences(token, claims)) {
        const name = startToolName(seq.name, taken);
        taken.add(name);
        const rawSchema = pickInputSchema(seq) ?? (await sequenceSchema(token, claims, seq.name));
        const { schema, wrapped } = startInputSchema(rawSchema);
        starts.set(name, { sequence: seq.name, wrapped, required: Array.isArray(schema.required) ? schema.required : [] });
        tools.push({
          name,
          title: `Start ${seq.name}`,
          description:
            `Start a run of the "${seq.name}" workflow. Arguments are the workflow input. ` +
            "Returns the run id; follow it with get_run.",
          inputSchema: schema,
        });
      }
    }
    if (has("runs:read")) {
      tools.push({
        name: "list_runs",
        title: "List runs",
        description: "List recent workflow runs visible to this embed session (newest first).",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100 },
            cursor: { type: "string", description: "next_cursor from a previous call" },
          },
          additionalProperties: false,
        },
      });
      tools.push({
        name: "get_run",
        title: "Get run",
        description: "Get a workflow run's state and steps (outputs only for steps the workflow makes visible).",
        inputSchema: {
          type: "object",
          properties: { run_id: { type: "string", description: "Run id returned by a start_ tool or list_runs" } },
          required: ["run_id"],
          additionalProperties: false,
        },
      });
    }
    if (has("approvals:resolve") || has("runs:read")) {
      tools.push({
        name: "list_pending_approvals",
        title: "List pending approvals",
        description: "List approval requests waiting for a decision, with their prompt and allowed choices.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      });
    }
    if (has("approvals:resolve")) {
      tools.push({
        name: "resolve_approval",
        title: "Resolve approval",
        description:
          "Answer a pending approval. `choice` must be one of the approval's choice values from list_pending_approvals.",
        inputSchema: {
          type: "object",
          properties: {
            approval_id: { type: "string" },
            choice: { type: "string" },
            comment: { type: "string" },
          },
          required: ["approval_id", "choice"],
          additionalProperties: false,
        },
      });
    }
    catalog = { token, builtAt: now(), tools, starts };
    return catalog;
  }

  function str(args, key, required = true) {
    const value = args?.[key];
    if (value === undefined && !required) return undefined;
    if (typeof value !== "string" || value.length === 0) {
      throw Object.assign(new Error(`argument "${key}" must be a non-empty string`), { invalidParams: true });
    }
    return value;
  }

  async function runTool(name, args) {
    const cat = await buildCatalog();
    const token = cat.token;
    if (!cat.tools.some((t) => t.name === name)) {
      throw Object.assign(new Error(`unknown tool: ${name}`), { invalidParams: true });
    }
    const start = cat.starts.get(name);
    if (start) {
      const missing = start.required.filter((key) => args?.[key] === undefined);
      if (missing.length > 0) {
        throw Object.assign(new Error(`missing required argument(s): ${missing.join(", ")}`), { invalidParams: true });
      }
      const input = start.wrapped ? args?.input : args ?? {};
      return call(token, "POST", "/runs", { sequence: start.sequence, input: input ?? {} });
    }
    switch (name) {
      case "list_runs": {
        const q = new URLSearchParams();
        if (args?.limit !== undefined) q.set("limit", String(args.limit));
        if (args?.cursor !== undefined) q.set("cursor", String(args.cursor));
        const qs = q.toString();
        return call(token, "GET", `/runs${qs ? `?${qs}` : ""}`);
      }
      case "get_run":
        return call(token, "GET", `/runs/${encodeURIComponent(str(args, "run_id"))}`);
      case "list_pending_approvals":
        return call(token, "GET", "/approvals");
      case "resolve_approval": {
        const body = { choice: str(args, "choice") };
        const comment = str(args, "comment", false);
        if (comment !== undefined) body.comment = comment;
        const result = await call(token, "POST", `/approvals/${encodeURIComponent(str(args, "approval_id"))}`, body);
        return Object.keys(result).length ? result : { resolved: true };
      }
      default:
        throw Object.assign(new Error(`unknown tool: ${name}`), { invalidParams: true });
    }
  }

  const ok = (value) => ({
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value && typeof value === "object" && !Array.isArray(value) ? value : { result: value },
    isError: false,
  });
  const fail = (message) => ({ content: [{ type: "text", text: message }], isError: true });
  const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
  const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  /**
   * Handle one JSON-RPC message (already parsed, or a raw string). Returns the
   * response object, or `null` for notifications.
   */
  async function handle(message) {
    let msg = message;
    if (typeof message === "string") {
      try {
        msg = JSON.parse(message);
      } catch (err) {
        return rpcError(null, PARSE_ERROR, `parse error: ${err.message}`);
      }
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      return rpcError(null, INVALID_REQUEST, "expected a single JSON-RPC object (batch requests are not supported)");
    }
    const id = msg.id;
    if (msg.jsonrpc !== "2.0") return rpcError(id, INVALID_REQUEST, 'missing or invalid jsonrpc field (expected "2.0")');
    if (typeof msg.method !== "string") return rpcError(id, INVALID_REQUEST, "missing method");
    if (id === undefined) return null; // notification

    const params = msg.params ?? {};
    switch (msg.method) {
      case "initialize": {
        const requested = params.protocolVersion;
        const protocolVersion = KNOWN_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
        try {
          const { claims } = await currentToken();
          return rpcResult(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "orch8-embed", title: "Orch8 embedded workflows", version: SERVER_VERSION },
            instructions:
              `Embedded Orch8 workflows for ${claims.subTenant}. Start a workflow with its start_ tool, ` +
              "then poll get_run; answer human approvals with list_pending_approvals and resolve_approval.",
          });
        } catch (err) {
          return rpcError(id, INVALID_REQUEST, err.message);
        }
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        try {
          const cat = await buildCatalog();
          return rpcResult(id, { tools: cat.tools });
        } catch (err) {
          return rpcError(id, INVALID_REQUEST, err.message);
        }
      case "tools/call": {
        if (typeof params.name !== "string") return rpcError(id, INVALID_PARAMS, "tools/call requires params.name");
        try {
          return rpcResult(id, ok(await runTool(params.name, params.arguments ?? {})));
        } catch (err) {
          if (err.invalidParams) return rpcError(id, INVALID_PARAMS, err.message);
          if (err instanceof EmbedTokenError) return rpcResult(id, fail(err.message));
          return rpcResult(id, fail(err.message ?? String(err)));
        }
      }
      default:
        return rpcError(id, METHOD_NOT_FOUND, `method not found: ${msg.method}`);
    }
  }

  return { handle, tools: async () => (await buildCatalog()).tools };
}
