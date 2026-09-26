# Submission checklist: Orch8 integrations

Nothing in these repos has been pushed or published. Every step below is manual
and needs the owner's accounts. Repos:

| Deliverable | Local repo |
|---|---|
| MCP registry manifest and client snippets | `integrations/mcp` |
| Claude Code plugin and marketplace | `integrations/claude-code-plugin` |
| n8n community node | `integrations/n8n-nodes-orch8` |
| Zapier app | `integrations/zapier-orch8` |
| Make custom app | `integrations/make-orch8` |
| Terraform provider | `terraform-provider-orch8` |

## 1. Official MCP Registry (registry.modelcontextprotocol.io)

1. Create a public GitHub repo (e.g. `orch8-io/mcp`) and push `integrations/mcp`.
2. Install the publisher: `brew install mcp-publisher` (or download it from the
   `modelcontextprotocol/registry` GitHub releases).
3. Prove ownership of the `io.orch8/*` namespace through DNS:
   - `openssl genpkey -algorithm Ed25519 -out key.pem`
   - Add the TXT record that `mcp-publisher login dns --help` prints for `orch8.io`
     (format `v=MCPv1; k=ed25519; p=<base64 public key>`).
   - `mcp-publisher login dns --domain orch8.io --private-key <hex seed>`
   - Alternative: rename to `io.github.orch8-io/orch8` and run `mcp-publisher login github`.
4. `npm test` (schema check), then `mcp-publisher publish` from this directory.
5. Verify with `curl "https://registry.modelcontextprotocol.io/v0/servers?search=io.orch8/orch8"`.
6. On every engine release, bump `version` in `server.json` and publish again.
   Published versions are immutable.

The manifest declares a `remotes` entry with a `{orch8_host}` URL variable
because Orch8 is self-hosted. If a hosted Orch8 Cloud endpoint ships, add a
second remote with its fixed URL.

## 2. Client directories

| Client | Where | What to submit |
|---|---|---|
| Claude Desktop / claude.ai connectors | claude.ai/directory/manage (developer portal, needs a paid plan) | Remote MCP connector. The directory expects OAuth-capable remote servers, and the engine only takes `x-api-key` today, so list it after OAuth lands. Until then, document the `mcp-remote` snippet. |
| Cursor | cursor.com/mcp directory (submission form on the page) and an "Add to Cursor" deeplink `cursor://anysphere.cursor-deeplink/mcp/install?name=orch8&config=<base64 of the server object>` | `clients/cursor.mcp.json` |
| VS Code | `vscode:mcp/install?<url-encoded JSON>` install link in the docs; the GitHub MCP registry reads from the official registry (step 1) | `clients/vscode.mcp.json` |
| Windsurf | Windsurf MCP marketplace (reads from registries/submissions in its MCP settings) | `clients/windsurf.mcp_config.json` |
| Community lists | PR to `punkpeye/awesome-mcp-servers`; listings on mcp.so, Smithery, PulseMCP (PulseMCP ingests the official registry) | link to the docs page and `server.json` |

## 3. Claude Code plugin

1. Create a public GitHub repo `orch8-io/claude-code-plugin` and push `integrations/claude-code-plugin`.
2. Run `claude plugin validate --strict .claude-plugin/plugin.json` and `claude plugin validate .`.
3. The repo is already its own marketplace (`.claude-plugin/marketplace.json`, source `./`). Users install it with:
   `claude plugin marketplace add orch8-io/claude-code-plugin` and then `claude plugin install orch8@orch8`.
4. Anthropic's directory: submit the GitHub repo at <https://claude.ai/directory/manage> after
   working through <https://claude.com/docs/plugins/pre-submission-checklist>.
   `claude-plugins-official` doesn't take portal submissions; go through a partner contact.
5. Bump `version` in `plugin.json` on every release, and optionally tag it with `claude plugin tag --push`.

## 4. n8n community node

1. Create the GitHub repo `orch8-io/n8n-nodes-orch8` and push.
2. `npm login` as the owning org, then `npm publish --access public` from a clean build.
   The package name must start with `n8n-nodes-` and carry the `n8n-community-node-package` keyword.
3. Users install it through n8n **Settings → Community Nodes → Install** with `n8n-nodes-orch8`.
4. Run `npx @n8n/scan-community-package n8n-nodes-orch8` after publishing.
5. For "verified" status, which also makes it available on n8n Cloud: submit through the n8n Creator Portal
   (<https://creators.n8n.io>) and follow n8n's verification guidelines (no runtime deps, linter clean,
   published with npm provenance from GitHub Actions per n8n's current rules).

## 5. Zapier

From `integrations/zapier-orch8`:
`npx zapier-platform login`, then `npx zapier-platform register "Orch8"` (once), then
`npx zapier-platform push`, then invite beta testers with `npx zapier-platform users:add`, then `npx zapier-platform promote 0.1.0`.
Public listing: complete the Zapier Developer Platform publishing requirements (at least 3 live users with active Zaps, logo, descriptions,
test account for reviewers) and click **Publish** in developer.zapier.com. The reviewer needs a
reachable Orch8 engine and an API key.

## 6. Make

Create an empty app in Make, put its `appId`/zone into `origins` in `makecomapp.json` (API token with `sdk-apps` scopes in the git-ignored `.secrets/apikey`), then **Deploy to Make** from the Make Apps Editor VS Code extension. Alternatively, paste each component into the web editor as `integrations/make-orch8/README.md` describes. Test it in a private
scenario, and to share, **Publish** (link-shared). For the public app directory, **Request review**
from the app's page. Make's review requires docs, a test account, and a verified connection.

## 7. Terraform Registry

1. Create the public GitHub repo `orch8-io/terraform-provider-orch8`. The name must match `terraform-provider-{name}`.
2. Generate a GPG key (RSA, not ECC) and add its ASCII-armored public key in the registry under
   **User Settings → Signing Keys**.
3. Add the repo secrets `GPG_PRIVATE_KEY` and `PASSPHRASE` and use HashiCorp's goreleaser GitHub Action.
   Push the tag `v0.1.0` so goreleaser builds, signs `SHA256SUMS`, and attaches
   `terraform-registry-manifest.json`.
4. On registry.terraform.io: **Publish → Provider**, then pick the repo. Later tags publish automatically through the webhook.
