import test from "node:test";
import assert from "node:assert/strict";
import { AxiosError } from "axios";
import { handleApiError } from "./api-client.js";
import { isInvalidGrant } from "./auth/client.js";

function httpError(status: number, message?: string): AxiosError {
  const error = new AxiosError("Request failed");
  error.response = {
    status,
    statusText: "",
    headers: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: {} as any,
    data: message ? { error: { message } } : {},
  };
  return error;
}

function networkError(code: string): AxiosError {
  const error = new AxiosError("network");
  error.code = code;
  return error;
}

test("400 explains it is a parameter problem", () => {
  assert.match(handleApiError(httpError(400, "bad filter")), /Bad request: bad filter/);
});

test("401 mentions refresh rather than a dead end", () => {
  const out = handleApiError(httpError(401));
  assert.match(out, /Unauthorized/);
  assert.match(out, /npm run auth/);
});

test("403 names the ungranted scopes", () => {
  const out = handleApiError(httpError(403, "insufficient scope"));
  assert.match(out, /Forbidden: insufficient scope/);
  assert.match(out, /npm run auth/);
});

test("404 points at the data type or id", () => {
  assert.match(handleApiError(httpError(404)), /not found.*data type or resource ID/s);
});

test("429 asks the caller to back off", () => {
  assert.match(handleApiError(httpError(429)), /Rate limit exceeded/);
});

test("unmapped statuses still report the code", () => {
  assert.match(handleApiError(httpError(500)), /failed \(500\)/);
});

test("timeouts and DNS failures are distinguished", () => {
  assert.match(handleApiError(networkError("ECONNABORTED")), /timed out/);
  assert.match(handleApiError(networkError("ENOTFOUND")), /Could not reach health\.googleapis\.com/);
});

test("plain errors and non-errors both produce a message", () => {
  assert.equal(handleApiError(new Error("boom")), "Error: boom");
  assert.match(handleApiError("just a string"), /Unexpected error.*just a string/);
});

test("invalid_grant is reported ahead of the HTTP mapping", () => {
  const out = handleApiError(new Error("invalid_grant: Token has been expired or revoked."));
  assert.match(out, /invalid_grant/);
  assert.match(out, /npm run auth/);
});

test("isInvalidGrant matches both the response body and the message", () => {
  assert.equal(isInvalidGrant({ response: { data: { error: "invalid_grant" } } }), true);
  assert.equal(isInvalidGrant(new Error("... invalid_grant ...")), true);
  assert.equal(isInvalidGrant(new Error("something else")), false);
  assert.equal(isInvalidGrant({ response: { data: { error: "invalid_scope" } } }), false);
  assert.equal(isInvalidGrant(null), false);
  assert.equal(isInvalidGrant("invalid_grant"), false);
});
