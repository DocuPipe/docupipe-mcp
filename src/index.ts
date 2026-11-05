#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DocuPipeClient } from "./client.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { registerTools } from "./tools.js";

const INSTRUCTIONS = "DocuPipe turns documents (PDF, scans, images, Word, Excel, email) into structured JSON. For 'pull X out of these files', "
  + "call extract once per file with a json_schema of the fields you need, then reuse the returned schema_id for the remaining files so every "
  + "result has the same fields. Long jobs return status 'processing' with a 'next' call to resume; never re-upload to retry.";

async function main(): Promise<void> {
  const client = new DocuPipeClient();
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, client);
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`docupipe-mcp failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
