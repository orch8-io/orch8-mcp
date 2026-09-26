#!/usr/bin/env sh
# Register the Orch8 MCP endpoint with Claude Code (user scope).
# Requires ORCH8_API_KEY and ORCH8_TENANT_ID in the environment; ORCH8_MCP_URL optional.
set -eu
claude mcp add --transport http --scope user orch8 \
  "${ORCH8_MCP_URL:-http://localhost:8080/api/v1/mcp}" \
  --header "x-api-key: ${ORCH8_API_KEY}" \
  --header "x-tenant-id: ${ORCH8_TENANT_ID}"
