# Google Health MCP Server

An MCP (Model Context Protocol) server that connects LLMs to the [Google Health API](https://developers.google.com/health), enabling access to fitness, health metrics, sleep, nutrition, and device data from Fitbit, Pixel Watch, and other connected devices.

## Features

- **11 read-only tools** for safe, non-destructive access to Google Health data
- **40+ health data types** including steps, heart rate, sleep, exercise, weight, SpO2, calories, and more
- **One-command sign-in** — `npm run auth` opens a browser once; tokens refresh themselves after that
- **Daily and physical-time roll-ups** for aggregated health summaries
- **Multi-source reconciliation** to deduplicate data from multiple devices
- **Dual response format** (JSON or Markdown) on key read tools
- **Pagination** across all list endpoints

## Prerequisites

- **Node.js** >= 18
- A **Google Cloud project** with the Google Health API enabled

## Setup

### 1. Create an OAuth client

In [Google Cloud Console](https://console.cloud.google.com) → **APIs & Services → Credentials → Create credentials → OAuth client ID**:

- **Application type: Desktop app**

Desktop-app clients may redirect to any `http://127.0.0.1:<port>`, so there are no redirect URIs to register.

### 2. Publish the consent screen — do not skip this

Go to **APIs & Services → OAuth consent screen** and set **Publishing status** to **In production**.

While the consent screen sits in *Testing*, **Google expires every refresh token after 7 days**. The symptom is a server that works for about a week and then fails every tool call with `invalid_grant`, over and over. Publishing is the fix; re-authenticating only buys another 7 days. For a personal app where you are the only user, publishing is the supported path — verification is only required to distribute the app to other people.

### 3. Configure and sign in

```bash
npm install
cp .env.example .env      # then fill in client ID and secret
npm run auth
```

`npm run auth` opens your browser, you consent once, and the refresh token is written to `token.json` (gitignored). You should not need to touch auth again.

Check on it at any time:

```bash
npm run auth:status
```

That prints the token's age, expiry, granted scopes, and the result of a live refresh — and if a refresh fails, it tells you whether the cause is the 7-day Testing-mode expiry or something else.

### 4. Point your MCP client at it

**Claude Code** (`~/.claude/.mcp.json`) or **Claude Desktop** (`claude_desktop_config.json`):

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

No credentials in the config — the server reads `token.json` and `.env` from its own directory. VS Code users get this automatically from the checked-in `.vscode/mcp.json`.

## Configuration

All optional; sensible defaults apply.

| Variable | Purpose |
|---|---|
| `GOOGLE_HEALTH_CLIENT_ID` | OAuth client ID (required for `npm run auth`) |
| `GOOGLE_HEALTH_CLIENT_SECRET` | OAuth client secret (required for `npm run auth`) |
| `GOOGLE_HEALTH_REFRESH_TOKEN` | Pre-existing refresh token, if you would rather not use the browser flow |
| `GOOGLE_HEALTH_TOKEN_PATH` | Where to store the token. Defaults to `./token.json` |
| `GOOGLE_HEALTH_OAUTH_PORT` | Pin the loopback callback port. Only needed for a "Web application" OAuth client |
| `GOOGLE_HEALTH_AUTO_REAUTH` | Set to `0` to disable the automatic browser re-auth on `invalid_grant` |

## How authentication behaves

- Access tokens refresh silently; concurrent tool calls share a single refresh rather than each firing their own.
- The token file is written atomically, and a rotated refresh token from Google is always persisted.
- On startup the server performs a real refresh, so a dead credential surfaces immediately instead of mid-conversation.
- If the refresh token is ever rejected, the browser flow starts automatically and the in-flight tool call completes once you consent. Set `GOOGLE_HEALTH_AUTO_REAUTH=0` for a plain error message instead.

## Tools

### User Profile & Settings

| Tool | Description | Scope |
|------|-------------|-------|
| `googlehealth_get_profile` | Get user profile (age, height, weight, timezone) | `profile.readonly` |
| `googlehealth_get_settings` | Get user settings (locale, units, timezone) | `settings.readonly` |
| `googlehealth_get_identity` | Get Fitbit + Google user IDs | `profile.readonly` |

### Health Data Points

| Tool | Description | Scope |
|------|-------------|-------|
| `googlehealth_list_data_points` | Query data points by type with time filters and pagination | varies by type |
| `googlehealth_get_data_point` | Get a single data point by ID | varies by type |

### Aggregations

| Tool | Description | Scope |
|------|-------------|-------|
| `googlehealth_daily_rollup` | Aggregate by calendar day (e.g. daily step totals) | varies by type |
| `googlehealth_rollup` | Aggregate over custom time windows (e.g. hourly buckets) | varies by type |
| `googlehealth_reconcile` | Deduplicate data from multiple sources | varies by type |

### Devices & Export

| Tool | Description | Scope |
|------|-------------|-------|
| `googlehealth_list_devices` | List paired trackers and smartwatches | `settings.readonly` |
| `googlehealth_get_device` | Get details for a specific device | `settings.readonly` |
| `googlehealth_export_exercise_tcx` | Export an exercise as TCX (Training Center XML) | `activity_and_fitness.readonly` |

## Supported Data Types

The server supports all 40+ Google Health API data types:

**Activity & Fitness:** `steps`, `distance`, `floors`, `exercise`, `active-minutes`, `active-zone-minutes`, `active-energy-burned`, `total-calories`, `calories-in-heart-rate-zone`, `time-in-heart-rate-zone`, `activity-level`, `sedentary-period`, `altitude`, `elevation`, `swim-lengths-data`, `vo2-max`, `daily-vo2-max`, `run-vo2-max`

**Health Metrics:** `heart-rate`, `daily-resting-heart-rate`, `heart-rate-variability`, `daily-heart-rate-variability`, `daily-heart-rate-zones`, `blood-glucose`, `oxygen-saturation`, `daily-oxygen-saturation`, `daily-respiratory-rate`, `respiratory-rate-sleep-summary`, `core-body-temperature`, `body-fat`, `height`, `weight`

**Sleep:** `sleep`, `daily-sleep-temperature-derivations`

**Nutrition:** `food`, `food-measurement-unit`, `hydration-log`, `nutrition-log`

**Specialized:** `electrocardiogram`, `irregular-rhythm-notification`

> **Important:** Use kebab-case for data type names in tool parameters (e.g. `heart-rate`), but snake_case in filter expressions (e.g. `heart_rate`).

## Usage Examples

### Get daily step counts for a week

```
Use googlehealth_daily_rollup with:
  data_type: "steps"
  start_date: "2026-06-09"
  end_date: "2026-06-16"
```

### Query heart rate data with a time filter

```
Use googlehealth_list_data_points with:
  data_type: "heart-rate"
  filter: 'heart_rate.sample_time.physical_time >= "2026-06-15T00:00:00Z"'
  page_size: 10
```

### Aggregate steps into hourly buckets

```
Use googlehealth_rollup with:
  data_type: "steps"
  start_time: "2026-06-15T00:00:00Z"
  end_time: "2026-06-16T00:00:00Z"
  window_size: "3600s"
```

## OAuth Scopes

`npm run auth` requests all of these. All use the base URL `https://www.googleapis.com/auth/googlehealth`:

| Scope suffix | Access |
|-------------|--------|
| `.activity_and_fitness.readonly` | Steps, exercise, calories, distance, etc. |
| `.health_metrics_and_measurements.readonly` | Heart rate, weight, SpO2, blood glucose, etc. |
| `.sleep.readonly` | Sleep data |
| `.nutrition.readonly` | Food, hydration, nutrition logs |
| `.profile.readonly` | User profile and identity |
| `.settings.readonly` | User settings and paired devices |
| `.ecg.readonly` | Electrocardiogram data |
| `.irn.readonly` | Irregular rhythm notifications |
| `.location.readonly` | GPS location during exercise |

The first six are treated as required; a token missing any of them produces a startup warning.

## Project Structure

```
src/
  index.ts            # server wiring: register tool groups, connect stdio
  api-client.ts       # HTTP client and error-to-message mapping
  constants.ts        # base URL, character limit, data types, scopes
  formatters.ts       # markdown rendering (pure, unit-tested)
  auth/
    store.ts          # token persistence — atomic writes, .env loading
    oauth.ts          # loopback browser login with PKCE
    client.ts         # OAuth client, refresh, invalid_grant recovery
  cli/
    login.ts          # npm run auth
    status.ts         # npm run auth:status
  tools/
    shared.ts         # annotations, schemas, result helpers
    profile.ts        # 3 profile/settings/identity tools
    datapoints.ts     # list, get, reconcile
    rollups.ts        # daily and physical-time roll-ups
    devices.ts        # devices and TCX export
scripts/
  check-secrets.mjs   # credential scanner (pre-commit hook + CI)
dist/                 # compiled output (npm run build)
evaluation.xml        # 10 verified evaluation questions
```

## Development

```bash
npm install
npm run build
npm start
npm run dev            # auto-reload via tsx
npm test               # unit tests (node:test)
npm run check-secrets  # scan the tree for credentials
```

Enable the pre-commit credential guard once per clone:

```bash
git config core.hooksPath .githooks
```

Inspect the tool surface interactively:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

## Security

- `.env` and `token.json` hold live credentials and are gitignored. `.env.example` documents the shape.
- A pre-commit hook and a CI job both run `scripts/check-secrets.mjs`, which blocks Google client secrets, access tokens, refresh tokens, API keys, and private keys.
- Anything written to disk in plaintext should be treated as compromised if it leaks — rotate in Cloud Console rather than just deleting the file.

## Evaluation

`evaluation.xml` contains 10 verified questions testing multi-tool workflows against real Google Health data. It is a fixture for an external harness; no runner is bundled with this repo.

## API Notes

- The Google Health API is the successor to the Fitbit Web API, rebuilt on Google infrastructure
- Data comes from Fitbit devices, Pixel Watch, and third-party apps via Health Connect
- The `dailyRollUp` endpoint uses civil time (date objects), while `rollUp` uses physical time (ISO 8601 timestamps)
- Roll-up ranges are closed-open: `end_date` is exclusive
- Not all data types support all operations. The API returns an error listing supported actions if you try an unsupported one
- Rate limits apply. The server returns actionable error messages when limits are hit

## License

MIT
