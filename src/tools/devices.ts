import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { makeApiRequest } from "../api-client.js";
import {
  READONLY_ANNOTATIONS,
  jsonResult,
  registerSimpleTool,
  safeTool,
} from "./shared.js";

export function registerDeviceTools(server: McpServer): void {
  registerSimpleTool(server, {
    name: "googlehealth_list_devices",
    title: "List Paired Devices",
    path: "users/me/pairedDevices",
    description:
      "Returns the user's list of paired trackers and smartwatches (Fitbit, Pixel Watch, etc.).\n\n" +
      "Required scope: googlehealth.settings.readonly",
  });

  server.registerTool(
    "googlehealth_get_device",
    {
      title: "Get Device Details",
      description:
        "Returns details for a specific paired device by ID.\n\n" +
        "Required scope: googlehealth.settings.readonly",
      inputSchema: {
        device_id: z.string().min(1).describe("The paired device ID"),
      },
      annotations: READONLY_ANNOTATIONS,
    },
    async ({ device_id }) =>
      safeTool(async () => jsonResult(await makeApiRequest(`users/me/pairedDevices/${device_id}`)))
  );

  server.registerTool(
    "googlehealth_export_exercise_tcx",
    {
      title: "Export Exercise TCX",
      description:
        "Export an exercise data point in TCX format (Training Center XML). Useful for importing workouts into other fitness platforms.\n\n" +
        "Required scope: googlehealth.activity_and_fitness.readonly (and googlehealth.location.readonly for GPS data)",
      inputSchema: {
        data_point_id: z.string().min(1).describe("The exercise data point ID to export"),
      },
      annotations: READONLY_ANNOTATIONS,
    },
    async ({ data_point_id }) =>
      safeTool(async () => {
        const data = await makeApiRequest(
          `users/me/dataTypes/exercise/dataPoints/${data_point_id}:exportExerciseTcx`
        );
        // Deliberately not truncated: a clipped TCX file is invalid XML and
        // useless to whatever the user imports it into.
        return {
          content: [
            { type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) },
          ],
        };
      })
  );
}
