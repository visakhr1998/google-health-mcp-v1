#!/usr/bin/env node
// Scans for Google credential material.
//
//   node scripts/check-secrets.mjs           # scan tracked + untracked files
//   node scripts/check-secrets.mjs --staged  # scan staged content (pre-commit hook)
//
// Exits 1 on any finding. Deliberately dependency-free so it can run in a git
// hook and in CI without an install step.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const PATTERNS = [
  { name: "Google OAuth client secret", re: /GOCSPX-[\w-]{10,}/ },
  { name: "Google OAuth access token", re: /\bya29\.[\w.-]{20,}/ },
  { name: "Google OAuth refresh token", re: /\b1\/\/[\w-]{20,}/ },
  { name: "Google API key", re: /\bAIza[\w-]{35}\b/ },
  { name: "PEM private key", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

// Files that legitimately describe the patterns rather than containing secrets.
const ALLOWLIST = new Set(["scripts/check-secrets.mjs"]);

const staged = process.argv.includes("--staged");

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function filesToScan() {
  const out = staged
    ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
    : git(["ls-files", "--cached", "--others", "--exclude-standard"]);
  return out.split("\n").map((f) => f.trim()).filter(Boolean);
}

function contentOf(file) {
  // For --staged, read the staged blob rather than the worktree copy, so that
  // an unstaged "fix" can't hide a secret that is actually being committed.
  if (staged) {
    try {
      return git(["show", `:${file}`]);
    } catch {
      return null;
    }
  }
  try {
    if (statSync(file).size > 5 * 1024 * 1024) return null;
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

const findings = [];
for (const file of filesToScan()) {
  if (ALLOWLIST.has(file)) continue;
  const content = contentOf(file);
  if (content === null) continue;
  const lines = content.split(/\r?\n/);
  for (const { name, re } of PATTERNS) {
    lines.forEach((line, i) => {
      const m = re.exec(line);
      if (m) findings.push({ file, line: i + 1, name, sample: m[0].slice(0, 12) });
    });
  }
}

if (findings.length > 0) {
  console.error(`\n  BLOCKED: found ${findings.length} credential(s).\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.name} (${f.sample}...)`);
  }
  console.error(
    "\n  Remove the credential, then rotate it in Google Cloud Console —\n" +
      "  assume anything written to disk in plaintext is compromised.\n" +
      "  Credentials belong in .env or token.json, both gitignored.\n"
  );
  process.exit(1);
}

console.log(`No credentials found (${staged ? "staged" : "tracked + untracked"}).`);
