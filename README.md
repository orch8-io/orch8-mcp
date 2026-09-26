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

Submission steps for the registry and every client directory are in
[`SUBMISSION.md`](SUBMISSION.md).
