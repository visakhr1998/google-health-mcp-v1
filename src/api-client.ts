import axios, { AxiosError } from "axios";
import { API_BASE_URL, ALL_SCOPES } from "./constants.js";
import { getValidAccessToken, currentTokens, isInvalidGrant } from "./auth/client.js";
import { missingScopes } from "./auth/store.js";

export async function makeApiRequest<T>(
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
  data?: unknown,
  params?: Record<string, string | number | boolean | undefined>
): Promise<T> {
  const token = await getValidAccessToken();

  const cleanParams = params
    ? Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined))
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

/** Scopes this account never granted — the usual explanation for a 403. */
function ungrantedScopeHint(): string {
  const absent = missingScopes(currentTokens()?.scopes, [...ALL_SCOPES]);
  if (absent.length === 0) return " All known scopes are granted, so this data type may not be available for your account.";
  const names = absent.map((s) => s.replace("https://www.googleapis.com/auth/googlehealth.", ""));
  return ` Your token does not grant: ${names.join(", ")}. Run \`npm run auth\` to re-consent.`;
}

export function handleApiError(error: unknown): string {
  if (isInvalidGrant(error)) {
    return "Error: Google rejected the stored refresh token (invalid_grant). Run `npm run auth` to sign in again.";
  }

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
          return `Error: Unauthorized${detail}. The access token was rejected; it will be refreshed on the next call. If this repeats, run \`npm run auth\`.`;
        case 403:
          return `Error: Forbidden${detail}.${ungrantedScopeHint()}`;
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
