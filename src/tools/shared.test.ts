import test from "node:test";
import assert from "node:assert/strict";
import {
  truncateIfNeeded,
  jsonResult,
  textResult,
  respond,
  ResponseFormat,
  fitJson,
  fetchNonEmptyPage,
} from "./shared.js";
import { CHARACTER_LIMIT } from "../constants.js";

test("truncateIfNeeded leaves short text alone", () => {
  assert.equal(truncateIfNeeded("hello"), "hello");
});

test("truncateIfNeeded leaves text of exactly the limit alone", () => {
  const exact = "x".repeat(CHARACTER_LIMIT);
  assert.equal(truncateIfNeeded(exact), exact);
});

test("truncateIfNeeded clips one character over the limit", () => {
  const over = "x".repeat(CHARACTER_LIMIT + 1);
  const out = truncateIfNeeded(over);
  assert.notEqual(out, over);
  assert.match(out, /Response truncated/);
  assert.equal(out.slice(0, CHARACTER_LIMIT), "x".repeat(CHARACTER_LIMIT));
});

test("textResult and jsonResult produce a single text block", () => {
  assert.deepEqual(textResult("hi"), { content: [{ type: "text", text: "hi" }] });
  assert.deepEqual(jsonResult({ a: 1 }), {
    content: [{ type: "text", text: '{\n  "a": 1\n}' }],
  });
});

// ── Issue #4: truncated JSON must still parse ────────────────────────────────
//
// The regression: output was sliced at the character limit and a prose notice
// appended, producing a body that was neither valid JSON nor an error. Clients
// that treat an unparseable payload as "no records" silently lost data.

function bigPayload(records: number) {
  return {
    dataPoints: Array.from({ length: records }, (_, i) => ({
      name: `users/me/dataTypes/steps/dataPoints/point-${i}`,
      filler: "x".repeat(500),
      steps: { countSum: String(i) },
    })),
    nextPageToken: "TOKEN123",
  };
}

test("fitJson leaves a payload under the limit untouched", () => {
  const small = { dataPoints: [{ a: 1 }] };
  const fit = fitJson(small);
  assert.equal(fit.ok, true);
  if (!fit.ok) return;
  assert.equal(fit.truncated, false);
  assert.deepEqual(JSON.parse(fit.text), small);
});

test("an oversized payload is still valid JSON", () => {
  const fit = fitJson(bigPayload(200));
  assert.equal(fit.ok, true);
  if (!fit.ok) return;
  assert.equal(fit.truncated, true);
  const parsed = JSON.parse(fit.text); // would throw on the old behaviour
  assert.ok(parsed.dataPoints.length > 0, "should keep as many records as fit");
  assert.ok(parsed.dataPoints.length < 200, "should have dropped some");
  assert.ok(fit.text.length <= CHARACTER_LIMIT);
});

test("truncation is announced in-band, not as prose", () => {
  const fit = fitJson(bigPayload(200));
  assert.equal(fit.ok, true);
  if (!fit.ok) return;
  const parsed = JSON.parse(fit.text);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.truncationInfo.returnedRecords, parsed.dataPoints.length);
  assert.equal(
    parsed.truncationInfo.returnedRecords + parsed.truncationInfo.omittedRecords,
    200
  );
  assert.doesNotMatch(fit.text, /--- Response truncated/);
});

test("the continuation token survives truncation", () => {
  const fit = fitJson(bigPayload(200));
  assert.equal(fit.ok, true);
  if (!fit.ok) return;
  assert.equal(JSON.parse(fit.text).nextPageToken, "TOKEN123");
});

test("rollupDataPoints is trimmed the same way as dataPoints", () => {
  const fit = fitJson({
    rollupDataPoints: Array.from({ length: 300 }, (_, i) => ({ i, filler: "z".repeat(400) })),
  });
  assert.equal(fit.ok, true);
  if (!fit.ok) return;
  const parsed = JSON.parse(fit.text);
  assert.ok(parsed.rollupDataPoints.length > 0);
  assert.equal(parsed.truncated, true);
});

test("a payload with no trimmable records reports an error, not an empty success", () => {
  const fit = fitJson({ blob: "q".repeat(CHARACTER_LIMIT * 2) });
  assert.equal(fit.ok, false);
  if (fit.ok) return;
  assert.match(fit.message, /RESPONSE_TOO_LARGE/);
});

test("jsonResult surfaces an untrimmable payload as isError", () => {
  const result = jsonResult({ blob: "q".repeat(CHARACTER_LIMIT * 2) });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /RESPONSE_TOO_LARGE/);
});

test("jsonResult output always parses", () => {
  for (const payload of [bigPayload(5), bigPayload(200), { dataPoints: [] }]) {
    const result = jsonResult(payload);
    assert.notEqual(result.isError, true);
    assert.doesNotThrow(() => JSON.parse(result.content[0].text));
  }
});

// ── Issue #5: empty pages that still carry a token ───────────────────────────

test("fetchNonEmptyPage skips an empty page that still has a token", async () => {
  const pages: Record<string, { dataPoints: unknown[]; nextPageToken?: string }> = {
    "": { dataPoints: [], nextPageToken: "p2" },
    p2: { dataPoints: [], nextPageToken: "p3" },
    p3: { dataPoints: [{ id: 1 }], nextPageToken: "p4" },
  };
  const seen: string[] = [];
  const page = await fetchNonEmptyPage(
    async (token) => {
      seen.push(token ?? "");
      return pages[token ?? ""];
    },
    "dataPoints"
  );
  assert.deepEqual(page.dataPoints, [{ id: 1 }]);
  assert.deepEqual(seen, ["", "p2", "p3"]);
});

test("fetchNonEmptyPage stops when the token runs out, not when a page is empty", async () => {
  const page = await fetchNonEmptyPage(async () => ({ dataPoints: [] }), "dataPoints");
  assert.deepEqual(page.dataPoints, []);
});

test("fetchNonEmptyPage returns a non-empty first page without extra calls", async () => {
  let calls = 0;
  await fetchNonEmptyPage(
    async () => {
      calls++;
      return { dataPoints: [{ id: 1 }], nextPageToken: "more" };
    },
    "dataPoints"
  );
  assert.equal(calls, 1);
});

test("fetchNonEmptyPage is bounded so a pathological range cannot spin", async () => {
  let calls = 0;
  await fetchNonEmptyPage(
    async () => {
      calls++;
      return { dataPoints: [], nextPageToken: "always" };
    },
    "dataPoints",
    undefined,
    5
  );
  assert.equal(calls, 6, "initial fetch plus maxHops");
});

test("respond picks the format and never calls the unused renderer", () => {
  const data = { a: 1 };
  let markdownCalls = 0;
  const toMarkdown = () => {
    markdownCalls++;
    return "# md";
  };

  assert.equal(respond(data, ResponseFormat.JSON, toMarkdown).content[0].text, '{\n  "a": 1\n}');
  assert.equal(markdownCalls, 0);

  assert.equal(respond(data, ResponseFormat.MARKDOWN, toMarkdown).content[0].text, "# md");
  assert.equal(markdownCalls, 1);
});
