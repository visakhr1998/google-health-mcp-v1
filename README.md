# Google Health MCP Server

An MCP server that connects LLMs to the [Google Health API](https://developers.google.com/health) — steps, heart rate, sleep, nutrition, weight, and paired-device data from Fitbit, Pixel Watch, and other connected sources. 11 read-only tools, JSON or Markdown output.

## Prerequisites

- Node.js >= 18
- A Google Cloud project with the Google Health API enabled

## Setup

**1. Create an OAuth client**

In [Google Cloud Console](https://console.cloud.google.com) → **APIs & Services → Credentials → Create credentials → OAuth client ID**, choose **Application type: Desktop app**.

**2. Publish the consent screen**

**APIs & Services → OAuth consent screen** → set **Publishing status** to **In production**. Skipping this leaves the screen in *Testing*, where Google expires refresh tokens after 7 days — the server works for a week, then fails every call with `invalid_grant`. For a personal app you're the only user of, publishing needs no verification.

**3. Install and sign in**

```bash
npm install
cp .env.example .env      # fill in GOOGLE_HEALTH_CLIENT_ID / _SECRET
npm run auth
```

This opens your browser once; the refresh token is written to `token.json` (gitignored). Check its status any time with `npm run auth:status`.

**4. Point your MCP client at it**

```json
{
  "mcpServers": {
    "google-health": {
      "command": "node",
      "args": ["/path/to/google-health-mcp-v1/dist/index.js"]
    }
  }
}
```

Add this to `~/.claude/.mcp.json` (Claude Code) or `claude_desktop_config.json` (Claude Desktop). No credentials go in the config — the server reads `token.json` and `.env` from its own directory. Run `npm run build` first so `dist/index.js` exists.

## Development

```bash
npm run build           # compile to dist/
npm test                # unit tests, no network
npm run dev              # auto-reload via tsx
git config core.hooksPath .githooks   # enable the pre-commit credential guard
```

## More detail

- [ONBOARDING.md](ONBOARDING.md) — architecture, tech stack, non-obvious constraints
- [TESTING.md](TESTING.md) — test suite and live E2E setup
- `CLAUDE.md` — conventions for AI coding agents working in this repo

## License

MIT
