import test from "node:test";
import assert from "node:assert/strict";
import { truncateIfNeeded, jsonResult, textResult, respond, ResponseFormat } from "./shared.js";
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

test("jsonResult truncates oversized payloads", () => {
  const big = { pad: "y".repeat(CHARACTER_LIMIT * 2) };
  assert.match(jsonResult(big).content[0].text, /Response truncated/);
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
