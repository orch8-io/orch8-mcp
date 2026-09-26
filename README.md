# Orch8 MCP distribution

Orch8 engines expose a Model Context Protocol server over Streamable HTTP at
`POST {ORCH8_URL}/api/v1/mcp` (the bare `/mcp` alias also works). It uses the
same `x-api-key` / `x-tenant-id` headers and tenant boundary as the REST API and
offers these tools: `list_sequences`, `create_sequence`, `preflight_sequence`,
`lint_sequence`, `create_instance`, `get_instance_status`,
`get_instance_outputs`, `send_signal`, `retry_instance`, `list_dlq`,
`get_usage`. Negotiated protocol versions: `2024-11-05`, `2025-03-26`,
`2025-06-18`. JSON-RPC batches are not supported; responses are plain JSON
(no SSE stream).

Orch8 is self-hosted, so there is no single public URL: every snippet below
uses `http://localhost:8080` — replace it with your engine's address.

## Quick start (works today, no registry needed)

Point your client straight at your own engine. Examples with `https://orch8.example.com`:

```bash
# Claude Code
claude mcp add --transport http --scope user orch8 https://orch8.example.com/api/v1/mcp \
  --header "x-api-key: $ORCH8_API_KEY" --header "x-tenant-id: $ORCH8_TENANT_ID"
```

```jsonc
// Cursor: ~/.cursor/mcp.json
{
  "mcpServers": {
    "orch8": {
      "url": "https://orch8.example.com/api/v1/mcp",
      "headers": { "x-api-key": "${env:ORCH8_API_KEY}", "x-tenant-id": "${env:ORCH8_TENANT_ID}" }
    }
  }
}
```

The other clients are in `clients/` (also zipped as `orch8-mcp-clients-<tag>.zip` on each
[GitHub Release](https://github.com/orch8-io/orch8-mcp/releases)); change the URL in them the same way.
For Claude Code you can instead install the plugin: `claude plugin marketplace add orch8-io/claude-code-plugin`
then `claude plugin install orch8@orch8`.

| File | Client | Where it goes |
|---|---|---|
| `server.json` | Official MCP Registry | published with `mcp-publisher` (see `SUBMISSION.md`) |
| `clients/claude-desktop.json` | Claude Desktop | merge into `claude_desktop_config.json` (Settings → Developer → Edit Config). Claude Desktop's config file only launches stdio servers, so the snippet bridges to the HTTP endpoint with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) (needs Node.js). |
| `clients/claude-code.sh` | Claude Code | run it, or install the plugin in `../claude-code-plugin` |
| `clients/cursor.mcp.json` | Cursor | `~/.cursor/mcp.json` or project `.cursor/mcp.json`; `${env:...}` is read from the environment Cursor was launched with |
| `clients/vscode.mcp.json` | VS Code (Copilot agent mode) | project `.vscode/mcp.json`, or run **MCP: Open User Configuration**; the key is prompted for and stored in VS Code's secret storage |
| `clients/windsurf.mcp_config.json` | Windsurf | `~/.codeium/windsurf/mcp_config.json` |

Do not commit literal API keys. Prefer a tenant key with the least capability
that works (`operator` for authoring/running, `approver` only answers human
gates).

## Checking the files

```bash
npm install
npm test   # validates server.json against the vendored 2025-12-11 registry schema + lints client snippets
```

The schema is vendored under `schema/` from
<https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json>.

## Smoke-testing an engine

```bash
curl -s -X POST "$ORCH8_URL/api/v1/mcp" \
  -H "content-type: application/json" \
  -H "x-api-key: $ORCH8_API_KEY" -H "x-tenant-id: $ORCH8_TENANT_ID" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## CI and releases

- `.github/workflows/ci.yml` runs `npm test` (schema validation of `server.json` and client snippet lint) and checks the vendored schema
  still matches the `$schema` URL, on every push and PR to `main`.
- Pushing a tag `v*` runs `.github/workflows/release.yml`: tests, then a GitHub Release with `server.json` and the client-config zip.
- The same workflow publishes to the official MCP Registry with `mcp-publisher` (pinned v1.8.1, sha256-checked) **only if the repository
  secret `MCP_PRIVATE_KEY` is set**. It runs `mcp-publisher login dns --domain orch8.io --private-key "$MCP_PRIVATE_KEY"`, then `mcp-publisher publish`.
  The published version is `server.json`'s `version`, not the git tag; registry versions are immutable, so bump it before each publish.

One-time setup for registry publishing (DNS auth for the `io.orch8/*` namespace), using OpenSSL 3
(on macOS: `/opt/homebrew/opt/openssl@3/bin/openssl`, since LibreSSL has no Ed25519):

```bash
openssl genpkey -algorithm Ed25519 -out key.pem
# 1. TXT record on the apex of orch8.io (not a subdomain):
echo "orch8.io. IN TXT \"v=MCPv1; k=ed25519; p=$(openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)\""
# 2. The hex private key goes into the MCP_PRIVATE_KEY repository secret (prefer an environment secret):
openssl pkey -in key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n'
```

Then keep `key.pem` offline or delete it. See <https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/authentication.mdx>.

Submission steps for the registry and every client directory are in
[`SUBMISSION.md`](SUBMISSION.md).
