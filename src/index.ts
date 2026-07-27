#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { preflight } from "./auth/client.js";
import { registerProfileTools } from "./tools/profile.js";
import { registerDataPointTools } from "./tools/datapoints.js";
import { registerRollupTools } from "./tools/rollups.js";
import { registerDeviceTools } from "./tools/devices.js";

export function buildServer(): McpServer {
  const server = new McpServer({
    name: "google-health-mcp-server",
    version: "1.0.0",
  });

  registerProfileTools(server);
  registerDataPointTools(server);
  registerRollupTools(server);
  registerDeviceTools(server);

  return server;
}

async function main(): Promise<void> {
  // Resolve credentials before serving, so a dead refresh token is reported
  // (and re-authenticated) at startup instead of mid-conversation.
  await preflight();

  const server = buildServer();
  await server.connect(new StdioServerTransport());

  // stdout carries the JSON-RPC stream — all logging must go to stderr.
  console.error("Google Health MCP server running via stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
