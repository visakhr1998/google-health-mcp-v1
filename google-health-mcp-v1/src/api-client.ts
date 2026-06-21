import axios, { AxiosError } from "axios";
import { API_BASE_URL } from "./constants.js";

let accessToken: string | undefined = process.env.GOOGLE_HEALTH_ACCESS_TOKEN;

export function setAccessToken(token: string): void {
  accessToken = token;
}

export async function makeApiRequest<T>(
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
  data?: unknown,
  params?: Record<string, string | number | boolean | undefined>
): Promise<T> {
  const token = accessToken;
  if (!token) {
    throw new Error(
      "No access token configured. Set GOOGLE_HEALTH_ACCESS_TOKEN environment variable or use the googlehealth_set_token tool."
    );
  }

  const cleanParams = params
    ? Object.fromEntries(
        Object.entries(params).filter(([, v]) => v !== undefined)
      )
    : undefined;

  const response = await axios({
    method,
    url: `${API_BASE_URL}/${path}`,
    data,
    params: cleanParams,
    timeout: 30000,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
  return response.data as T;
}

export function handleApiError(error: unknown): string {
  if (error instanceof AxiosError) {
    if (error.response) {
      const status = error.response.status;
      const detail =
        typeof error.response.data === "object" && error.response.data?.error?.message
          ? `: ${error.response.data.error.message}`
          : "";
      switch (status) {
        case 400:
          return `Error: Bad request${detail}. Check your parameters.`;
        case 401:
          return `Error: Unauthorized${detail}. Your access token may be expired — use googlehealth_set_token to set a fresh one.`;
        case 403:
          return `Error: Forbidden${detail}. Check that the required OAuth scope is granted.`;
        case 404:
          return `Error: Resource not found${detail}. Check the data type or resource ID.`;
        case 429:
          return `Error: Rate limit exceeded. Please wait before making more requests.`;
        default:
          return `Error: API request failed (${status})${detail}`;
      }
    } else if (error.code === "ECONNABORTED") {
      return "Error: Request timed out. Please try again.";
    } else if (error.code === "ENOTFOUND") {
      return "Error: Could not reach health.googleapis.com. Check your network.";
    }
  }
  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }
  return `Error: Unexpected error occurred: ${String(error)}`;
}
