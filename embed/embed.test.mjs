import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createEmbedMcp, decodeEmbedToken, startToolName } from "./server.mjs";
import { createEmbedHttpServer } from "./http.mjs";

const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);
const TENANT_TOOLS = [
  "list_sequences", "create_sequence", "preflight_sequence", "lint_sequence", "create_instance",
  "get_instance_status", "get_instance_outputs", "send_signal", "retry_instance", "list_dlq", "get_usage",
];

const b64url = (s) => Buffer.from(s).toString("base64url");
function token(overrides = {}) {
  const payload = {
    v: 1, tid: "vendor", sub: "cust-42", scp: ["runs:read", "runs:start", "approvals:resolve", "sequences:read"],
    seq: ["onboard-user", "refund.request"], iat: NOW / 1000 - 10, exp: NOW / 1000 + 600, jti: "j-1",
    ...overrides,
  };
  const body = b64url(JSON.stringify(payload));
  return `o8e1.${body}.${b64url("not-verified-here")}`;
}

/** Mock of the engine's /api/v1/embed routes (§2), recording every request. */
function mockEngine(routes = {}) {
  const calls = [];
  const defaults = {
    "GET /api/v1/embed/sequences": { items: [{ name: "onboard-user" }, { name: "refund.request" }, { name: "other" }] },
    "GET /api/v1/embed/sequences/onboard-user": {
      name: "onboard-user",
      input_schema: { type: "object", properties: { email: { type: "string" } }, required: ["email"] },
    },
    "GET /api/v1/embed/sequences/refund.request": { name: "refund.request", input_schema: { type: "string" } },
    "POST /api/v1/embed/runs": { id: "run-1" },
    "GET /api/v1/embed/runs/run-1": { id: "run-1", sequence: "onboard-user", state: "running", steps: [] },
    "GET /api/v1/embed/runs": { items: [], next_cursor: null },
    "GET /api/v1/embed/approvals": {
      items: [{ id: "ap-1", instance_id: "run-1", step_id: "approve", prompt: "Refund $20?", choices: [{ label: "Yes", value: "yes" }], created_at: "2026-09-28T12:00:00Z" }],
    },
    "POST /api/v1/embed/approvals/ap-1": null,
  };
  const table = { ...defaults, ...routes };
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    calls.push({ method, path: u.pathname, search: u.search, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const key = `${method} ${u.pathname}`;
    if (!(key in table)) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    const value = table[key];
    if (value instanceof Response) return value;
    if (value === null) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

let nextId = 1;
const rpc = (method, params) => ({ jsonrpc: "2.0", id: nextId++, method, params });

async function toolNames(mcp) {
  const res = await mcp.handle(rpc("tools/list"));
  return res.result.tools.map((t) => t.name);
}

describe("decodeEmbedToken", () => {
  test("accepts a well-formed o8e1 token and filters unknown scopes", () => {
    const claims = decodeEmbedToken(token({ scp: ["runs:read", "admin:all"] }), NOW);
    assert.equal(claims.subTenant, "cust-42");
    assert.deepEqual([...claims.scopes], ["runs:read"]);
    assert.deepEqual(claims.sequences, ["onboard-user", "refund.request"]);
  });

  test("rejects tenant API keys, malformed and expired tokens", () => {
    assert.throws(() => decodeEmbedToken("sk_live_tenant_key", NOW), /o8e1/);
    assert.throws(() => decodeEmbedToken("o8e1.onlyone", NOW), /malformed/);
    assert.throws(() => decodeEmbedToken(`o8e1.${b64url("{")}.sig`, NOW), /payload/);
    assert.throws(() => decodeEmbedToken(token({ v: 2 }), NOW), /version/);
    assert.throws(() => decodeEmbedToken(token({ exp: NOW / 1000 - 1 }), NOW), /expired/);
  });

  test("tool names are MCP-safe and unique", () => {
    const taken = new Set(["start_refund_request"]);
    assert.equal(startToolName("refund.request", taken), "start_refund_request_2");
    assert.match(startToolName("x".repeat(100)), /^start_x{58}$/);
  });
});

describe("embed-mode catalog", () => {
  test("exposes start_ tools only for the token's sequences, with their input schema", async () => {
    const engine = mockEngine();
    const mcp = createEmbedMcp({ baseUrl: "https://engine.test/", token: token(), fetch: engine.fetch, now: () => NOW });
    const { result } = await mcp.handle(rpc("tools/list"));
    const byName = Object.fromEntries(result.tools.map((t) => [t.name, t]));
    assert.deepEqual(Object.keys(byName).sort(), [
      "get_run", "list_pending_approvals", "list_runs", "resolve_approval", "start_onboard-user", "start_refund_request",
    ]);
    assert.deepEqual(byName["start_onboard-user"].inputSchema, {
      type: "object", properties: { email: { type: "string" } }, required: ["email"],
    });
    // A non-object input schema is wrapped under `input`.
    assert.deepEqual(byName.start_refund_request.inputSchema.properties.input, { type: "string" });
    assert.ok(!("start_other" in byName), "sequences outside the token must not appear");
  });

  test("never exposes tenant-level tools, whatever the scopes", async () => {
    const engine = mockEngine();
    const all = token({ scp: ["runs:read", "runs:start", "approvals:resolve", "sequences:read", "builder:edit"], seq: null });
    const mcp = createEmbedMcp({ baseUrl: "https://engine.test", token: all, fetch: engine.fetch, now: () => NOW });
    const names = await toolNames(mcp);
    for (const tenantTool of TENANT_TOOLS) assert.ok(!names.includes(tenantTool), tenantTool);
    for (const tenantTool of TENANT_TOOLS) {
      const res = await mcp.handle(rpc("tools/call", { name: tenantTool, arguments: {} }));
      assert.equal(res.error?.code, -32602, `${tenantTool} must be an unknown tool`);
    }
    // Every engine request stayed on the embed routes, with the bearer token and no API key.
    assert.ok(engine.calls.length > 0);
    for (const c of engine.calls) {
      assert.match(c.path, /^\/api\/v1\/embed\//);
      assert.equal(c.headers.authorization, `Bearer ${all}`);
      assert.ok(!("x-api-key" in c.headers) && !("x-tenant-id" in c.headers));
    }
  });

  test("seq: null enumerates the sub-tenant's sequences via the embed API", async () => {
    const engine = mockEngine();
    const mcp = createEmbedMcp({ baseUrl: "https://engine.test", token: token({ seq: null }), fetch: engine.fetch, now: () => NOW });
    const names = await toolNames(mcp);
    assert.ok(names.includes("start_other"));
  });

  test("gates tools by scope", async () => {
    const engine = mockEngine();
    const cases = [
      [["runs:read"], ["get_run", "list_pending_approvals", "list_runs"]],
      [["runs:start"], ["start_onboard-user", "start_refund_request"]],
      [["approvals:resolve"], ["list_pending_approvals", "resolve_approval"]],
      [["sequences:read", "builder:edit"], []],
    ];
    for (const [scp, expected] of cases) {
      const mcp = createEmbedMcp({ baseUrl: "https://engine.test", token: token({ scp }), fetch: engine.fetch, now: () => NOW });
      assert.deepEqual((await toolNames(mcp)).sort(), expected, scp.join(","));
    }
  });

  test("without sequences:read the start tool takes any object input", async () => {
    const engine = mockEngine();
    const mcp = createEmbedMcp({ baseUrl: "https://engine.test", token: token({ scp: ["runs:start"] }), fetch: engine.fetch, now: () => NOW });
    const { result } = await mcp.handle(rpc("tools/list"));
    assert.deepEqual(result.tools[0].inputSchema, { type: "object", additionalProperties: true });
    assert.ok(!engine.calls.some((c) => c.path.includes("/sequences")));
  });
});

describe("embed-mode tool calls", () => {
  const setup = (overrides, routes) => {
    const engine = mockEngine(routes);
    const mcp = createEmbedMcp({ baseUrl: "https://engine.test", token: token(overrides), fetch: engine.fetch, now: () => NOW });
    return { engine, mcp };
  };

  test("start_<sequence> posts the input to /embed/runs", async () => {
    const { engine, mcp } = setup();
    const res = await mcp.handle(rpc("tools/call", { name: "start_onboard-user", arguments: { email: "a@b.c" } }));
    assert.equal(res.result.isError, false);
    assert.deepEqual(res.result.structuredContent, { id: "run-1" });
    const post = engine.calls.find((c) => c.method === "POST");
    assert.equal(post.path, "/api/v1/embed/runs");
    assert.deepEqual(post.body, { sequence: "onboard-user", input: { email: "a@b.c" } });
  });

  test("a wrapped schema unwraps `input` before starting", async () => {
    const { engine, mcp } = setup();
    await mcp.handle(rpc("tools/call", { name: "start_refund_request", arguments: { input: "order-9" } }));
    assert.deepEqual(engine.calls.find((c) => c.method === "POST").body, { sequence: "refund.request", input: "order-9" });
  });

  test("get_run, list_runs and approvals map to the embed routes", async () => {
    const { engine, mcp } = setup();
    const run = await mcp.handle(rpc("tools/call", { name: "get_run", arguments: { run_id: "run-1" } }));
    assert.equal(run.result.structuredContent.state, "running");
    await mcp.handle(rpc("tools/call", { name: "list_runs", arguments: { limit: 5, cursor: "c1" } }));
    assert.equal(engine.calls.at(-1).search, "?limit=5&cursor=c1");
    const pending = await mcp.handle(rpc("tools/call", { name: "list_pending_approvals", arguments: {} }));
    assert.equal(pending.result.structuredContent.items[0].id, "ap-1");
    const resolved = await mcp.handle(rpc("tools/call", {
      name: "resolve_approval", arguments: { approval_id: "ap-1", choice: "yes", comment: "ok" },
    }));
    assert.deepEqual(resolved.result.structuredContent, { resolved: true });
    const post = engine.calls.at(-1);
    assert.equal(post.path, "/api/v1/embed/approvals/ap-1");
    assert.deepEqual(post.body, { choice: "yes", comment: "ok" });
  });

  test("scope-less tools are unknown, missing arguments are invalid params", async () => {
    const { mcp } = setup({ scp: ["runs:read"] });
    assert.equal((await mcp.handle(rpc("tools/call", { name: "resolve_approval", arguments: { approval_id: "a", choice: "y" } }))).error.code, -32602);
    assert.equal((await mcp.handle(rpc("tools/call", { name: "start_onboard-user", arguments: {} }))).error.code, -32602);
    assert.equal((await mcp.handle(rpc("tools/call", { name: "get_run", arguments: {} }))).error.code, -32602);
  });

  test("engine refusals come back as isError results", async () => {
    const { mcp } = setup({}, {
      "POST /api/v1/embed/runs": new Response(JSON.stringify({ error: "sub_tenant_quota_exceeded" }), { status: 429 }),
    });
    const res = await mcp.handle(rpc("tools/call", { name: "start_onboard-user", arguments: { email: "x" } }));
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /429.*sub_tenant_quota_exceeded/);
  });

  test("an expired token yields isError on calls and an error on tools/list", async () => {
    let now = NOW;
    const engine = mockEngine();
    const mcp = createEmbedMcp({ baseUrl: "https://engine.test", token: token(), fetch: engine.fetch, now: () => now });
    await mcp.handle(rpc("tools/list"));
    now = NOW + 3_600_000;
    const res = await mcp.handle(rpc("tools/call", { name: "get_run", arguments: { run_id: "run-1" } }));
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /expired/);
    assert.match((await mcp.handle(rpc("tools/list"))).error.message, /expired/);
  });

  test("a token provider is re-read so refreshed tokens take effect", async () => {
    const engine = mockEngine();
    let current = token({ scp: ["runs:read"] });
    const mcp = createEmbedMcp({ baseUrl: "https://engine.test", token: () => current, fetch: engine.fetch, now: () => NOW });
    assert.ok(!(await toolNames(mcp)).includes("resolve_approval"));
    current = token({ scp: ["runs:read", "approvals:resolve"], jti: "j-2" });
    assert.ok((await toolNames(mcp)).includes("resolve_approval"));
  });

  test("protocol handling mirrors the engine's MCP endpoint", async () => {
    const { mcp } = setup();
    const init = await mcp.handle(rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {} }));
    assert.equal(init.result.protocolVersion, "2025-03-26");
    assert.equal(init.result.serverInfo.name, "orch8-embed");
    assert.equal(await mcp.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
    assert.equal((await mcp.handle("{nope")).error.code, -32700);
    assert.equal((await mcp.handle([rpc("ping")])).error.code, -32600);
    assert.equal((await mcp.handle(rpc("resources/list"))).error.code, -32601);
  });
});

describe("HTTP transport", () => {
  async function listen(server) {
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${server.address().port}/mcp`;
  }

  test("requires an o8e1 bearer token and refuses tenant credentials", async (t) => {
    const engine = mockEngine();
    const server = createEmbedHttpServer({ baseUrl: "https://engine.test", fetch: engine.fetch, now: () => NOW });
    t.after(() => server.close());
    const url = await listen(server);
    const body = JSON.stringify(rpc("tools/list"));
    const post = (headers) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

    assert.equal((await post({})).status, 401);
    assert.equal((await post({ "x-api-key": "tenant-key", "x-tenant-id": "vendor" })).status, 401);
    assert.equal((await post({ authorization: "Bearer tenant-key" })).status, 401);
    assert.equal((await post({ authorization: `Bearer ${token({ exp: NOW / 1000 - 5 })}` })).status, 401);
    assert.equal((await fetch(url)).status, 405);
    assert.equal(engine.calls.length, 0);

    const ok = await post({ authorization: `Bearer ${token()}` });
    assert.equal(ok.status, 200);
    const names = (await ok.json()).result.tools.map((x) => x.name);
    assert.ok(names.includes("start_onboard-user"));
    const note = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token()}` },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    assert.equal(note.status, 202);
  });

  test("tokens for different sub-tenants get separate catalogs", async (t) => {
    const engine = mockEngine();
    const server = createEmbedHttpServer({ baseUrl: "https://engine.test", fetch: engine.fetch, now: () => NOW });
    t.after(() => server.close());
    const url = await listen(server);
    const list = async (tok) => (await (await fetch(url, {
      method: "POST", headers: { authorization: `Bearer ${tok}` }, body: JSON.stringify(rpc("tools/list")),
    })).json()).result.tools.map((x) => x.name);
    assert.ok((await list(token({ sub: "a", seq: ["onboard-user"] }))).includes("start_onboard-user"));
    const b = await list(token({ sub: "b", seq: ["refund.request"] }));
    assert.ok(!b.includes("start_onboard-user") && b.includes("start_refund_request"));
  });
});

test("stdio transport talks MCP over newline-delimited JSON", async (t) => {
  const engine = mockEngine();
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const r = await engine.fetch(`http://engine${req.url}`, {
      method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks).toString() : undefined,
    });
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(r.status === 204 ? undefined : await r.text());
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  t.after(() => upstream.close());

  const tok = token({ exp: Math.floor(Date.now() / 1000) + 600 });
  const child = spawn(process.execPath, [fileURLToPath(new URL("./bin.mjs", import.meta.url))], {
    env: { ...process.env, ORCH8_URL: `http://127.0.0.1:${upstream.address().port}`, ORCH8_EMBED_TOKEN: tok },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  const lines = [];
  let buffered = "";
  const waitFor = (n) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout; got ${lines.length} lines`)), 5000);
    const check = () => { if (lines.length >= n) { clearTimeout(timer); resolve(); } };
    child.stdout.on("data", (d) => {
      buffered += d;
      const parts = buffered.split("\n");
      buffered = parts.pop();
      lines.push(...parts.filter(Boolean).map((l) => JSON.parse(l)));
      check();
    });
    check();
  });
  const done = waitFor(3);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_run", arguments: { run_id: "run-1" } } })}\n`);
  await done;
  assert.deepEqual(lines.map((l) => l.id), [1, 2, 3]);
  assert.ok(lines[1].result.tools.some((x) => x.name === "start_onboard-user"));
  assert.equal(lines[2].result.structuredContent.id, "run-1");
});
