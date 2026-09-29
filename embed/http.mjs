// Streamable HTTP transport for the embed-mode MCP server: one POST endpoint,
// one JSON-RPC message per request, plain JSON responses (like the engine's
// own /api/v1/mcp). Each request authenticates with its own
// `Authorization: Bearer o8e1...`; any other credential (x-api-key, tenant
// keys, missing header) is refused with 401, so this endpoint can never act
// with tenant-level authority.
import { createServer } from "node:http";
import { createEmbedMcp, decodeEmbedToken, EmbedTokenError, TOKEN_PREFIX } from "./server.mjs";

const MAX_BODY_BYTES = 1024 * 1024;

function send(res, status, body, headers = {}) {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    ...(text ? { "content-type": "application/json" } : {}),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * @param {object} options
 * @param {string} options.baseUrl  Engine base URL.
 * @param {string} [options.path]    Endpoint path. Default `/mcp`.
 * @param {typeof fetch} [options.fetch]
 * @param {() => number} [options.now]
 */
export function createEmbedHttpServer(options) {
  const path = options.path ?? "/mcp";
  const sessions = new Map(); // token -> { mcp, exp }
  const now = options.now ?? Date.now;

  const sessionFor = (token) => {
    const nowMs = now();
    for (const [key, s] of sessions) if (s.exp * 1000 <= nowMs) sessions.delete(key);
    let s = sessions.get(token);
    if (!s) {
      const claims = decodeEmbedToken(token, nowMs);
      s = { mcp: createEmbedMcp({ baseUrl: options.baseUrl, token, fetch: options.fetch, now }), exp: claims.expiresAt };
      sessions.set(token, s);
    }
    return s.mcp;
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== path) return send(res, 404, { error: "not_found" });
    if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" }, { allow: "POST" });

    const auth = req.headers.authorization ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(auth);
    const challenge = { "www-authenticate": 'Bearer realm="orch8-embed", error="invalid_token"' };
    if (!match || !match[1].startsWith(TOKEN_PREFIX)) {
      return send(res, 401, { error: "embed_token_required", message: "Authorization: Bearer o8e1... is required" }, challenge);
    }
    let mcp;
    try {
      mcp = sessionFor(match[1]);
    } catch (err) {
      const message = err instanceof EmbedTokenError ? err.message : "invalid embed token";
      return send(res, 401, { error: "invalid_embed_token", message }, challenge);
    }

    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      return send(res, err.status ?? 400, { error: "bad_request", message: err.message });
    }
    const response = await mcp.handle(raw);
    if (response === null) return send(res, 202);
    return send(res, 200, response);
  });
}
