import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));

test("server.json validates against the vendored 2025-12-11 registry schema", () => {
  const schema = readJson("schema/server.schema.2025-12-11.json");
  const server = readJson("server.json");
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const ok = validate(server);
  assert.ok(ok, JSON.stringify(validate.errors, null, 2));
  assert.equal(server.$schema, schema.$id);
});

test("server.json remote points at the engine's MCP route with auth headers", () => {
  const server = readJson("server.json");
  const [remote] = server.remotes;
  assert.equal(remote.type, "streamable-http");
  assert.match(remote.url, /\/api\/v1\/mcp$/);
  for (const v of remote.url.matchAll(/\{([^}]+)\}/g)) {
    assert.ok(remote.variables?.[v[1]], `URL variable ${v[1]} must be declared`);
  }
  const names = remote.headers.map((h) => h.name);
  assert.deepEqual(names, ["x-api-key", "x-tenant-id"]);
  assert.equal(remote.headers[0].isSecret, true);
});

test("every client snippet is valid JSON and targets /api/v1/mcp without literal secrets", () => {
  const files = readdirSync(join(root, "clients")).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 4);
  for (const f of files) {
    const text = readFileSync(join(root, "clients", f), "utf8");
    JSON.parse(text);
    assert.match(text, /\/api\/v1\/mcp/, f);
    assert.doesNotMatch(text, /"x-api-key":\s*"[A-Za-z0-9]{16,}"/, `${f} must not embed a key`);
  }
});
