#!/usr/bin/env node
// orch8-embed-mcp — MCP server for Orch8 embedded workflows, authenticated by
// an o8e1 embed token.
//
//   stdio (one end user, e.g. Claude Desktop):
//     ORCH8_URL=https://orch8.example.com ORCH8_EMBED_TOKEN=o8e1... orch8-embed-mcp
//     ORCH8_EMBED_TOKEN_FILE=/run/orch8/token orch8-embed-mcp   # re-read on every request (refresh)
//
//   Streamable HTTP (many end users, each request carries its own token):
//     ORCH8_URL=https://orch8.example.com orch8-embed-mcp --http --port 8787 [--host 127.0.0.1]
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createEmbedMcp } from "./server.mjs";
import { createEmbedHttpServer } from "./http.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}

const baseUrl = arg("engine", process.env.ORCH8_URL);
if (!baseUrl) {
  console.error("orch8-embed-mcp: set ORCH8_URL (or --engine <url>)");
  process.exit(2);
}

if (process.argv.includes("--http")) {
  const port = Number(arg("port", process.env.PORT ?? "8787"));
  const host = arg("host", "127.0.0.1");
  createEmbedHttpServer({ baseUrl }).listen(port, host, () => {
    console.error(`orch8-embed-mcp: listening on http://${host}:${port}/mcp (engine ${baseUrl})`);
  });
} else {
  const tokenFile = process.env.ORCH8_EMBED_TOKEN_FILE;
  const token = tokenFile
    ? () => readFileSync(tokenFile, "utf8").trim()
    : process.env.ORCH8_EMBED_TOKEN;
  if (!token) {
    console.error("orch8-embed-mcp: set ORCH8_EMBED_TOKEN or ORCH8_EMBED_TOKEN_FILE");
    process.exit(2);
  }
  const mcp = createEmbedMcp({ baseUrl, token });
  // MCP stdio: newline-delimited JSON-RPC on stdin/stdout; logs go to stderr.
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queue = Promise.resolve();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    queue = queue.then(async () => {
      const response = await mcp.handle(line);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    }).catch((err) => console.error(`orch8-embed-mcp: ${err?.message ?? err}`));
  });
  rl.on("close", () => { void queue.then(() => process.exit(0)); });
}
