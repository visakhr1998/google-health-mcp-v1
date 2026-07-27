import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSimpleTool } from "./shared.js";

export function registerProfileTools(server: McpServer): void {
  registerSimpleTool(server, {
    name: "googlehealth_get_profile",
    title: "Get User Profile",
    path: "users/me/profile",
    description:
      "Returns the authenticated user's Google Health profile details including name, date of birth, gender, height, weight, and timezone.\n\n" +
      "Returns JSON with fields: displayName, dateOfBirth, gender, height, weight, timezone.\n\n" +
      "Required scope: googlehealth.profile.readonly",
  });

  registerSimpleTool(server, {
    name: "googlehealth_get_settings",
    title: "Get User Settings",
    path: "users/me/settings",
    description:
      "Returns the authenticated user's Google Health settings such as locale, units of measurement, and notification preferences.\n\n" +
      "Required scope: googlehealth.settings.readonly",
  });

  registerSimpleTool(server, {
    name: "googlehealth_get_identity",
    title: "Get User Identity",
    path: "users/me/identity",
    description:
      "Returns the authenticated user's identity information including Fitbit and Google user IDs.\n\n" +
      "Required scope: googlehealth.profile.readonly",
  });
}
