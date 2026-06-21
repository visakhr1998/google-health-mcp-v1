# Google Health MCP Server

An MCP (Model Context Protocol) server that connects LLMs to the [Google Health API](https://developers.google.com/health), enabling access to fitness, health metrics, sleep, nutrition, and device data from Fitbit, Pixel Watch, and other connected devices.

## Features

- **12 read-only tools** for safe, non-destructive access to Google Health data
- **40+ health data types** including steps, heart rate, sleep, exercise, weight, SpO2, calories, and more
- **Daily and physical-time roll-ups** for aggregated health summaries
- **Multi-source reconciliation** to deduplicate data from multiple devices
- **Dual response format** (JSON or Markdown) on key read tools
- **Pagination** across all list endpoints
- **OAuth 2.0** authentication via environment variable or runtime token tool

## Prerequisites

- **Node.js** >= 18
- A **Google Cloud project** with the Google Health API enabled
- An **OAuth 2.0 access token** with the appropriate `googlehealth.*` scopes

## Installation

```bash
git clone <repo-url>
cd google-health-mcp-v1
npm install
npm run build
```

## Getting an OAuth Token

### Option 1: OAuth 2.0 Playground (recommended for testing)

1. In [Google Cloud Console](https://console.cloud.google.com) > **APIs & Services > Credentials**, create an **OAuth 2.0 Client ID** (Web application type)
2. Add `https://developers.google.com/oauthplayground` as an authorized redirect URI
3. Go to the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground)
4. Click the gear icon > check **"Use your own OAuth credentials"** > paste your Client ID and Secret
5. In Step 1, enter the scopes you need (see [Scopes](#oauth-scopes) below)
6. Click **Authorize APIs** > sign in > click **"Advanced" > "Go to [app name] (unsafe)"**
7. In Step 2, click **Exchange authorization code for tokens**
8. Copy the `access_token`

### Option 2: gcloud CLI

```bash
gcloud auth application-default login \
  --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly,https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly,https://www.googleapis.com/auth/googlehealth.sleep.readonly,https://www.googleapis.com/auth/googlehealth.nutrition.readonly,https://www.googleapis.com/auth/googlehealth.profile.readonly,https://www.googleapis.com/auth/googlehealth.settings.readonly

gcloud auth application-default print-access-token
```

> **Note:** Access tokens expire after ~1 hour. Generate a new one when needed.

## Configuration

### Claude Code

Add to your `~/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "google-health": {
      "command": "node",
      "args": ["/path/to/google-health-mcp-v1/dist/index.js"],
      "env": {
        "GOOGLE_HEALTH_ACCESS_TOKEN": "ya29.your-token-here"
      }
    }
  }
}
```

### Claude Desktop

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "google-health": {
      "command": "node",
      "args": ["/path/to/google-health-mcp-v1/dist/index.js"],
      "env": {
        "GOOGLE_HEALTH_ACCESS_TOKEN": "ya29.your-token-here"
      }
    }
  }
}
```

### Runtime Token

You can also set or refresh the token at runtime using the `googlehealth_set_token` tool, without restarting the server.

## Tools

### Authentication

| Tool | Description |
|------|-------------|
| `googlehealth_set_token` | Set or update the OAuth 2.0 access token at runtime |

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

### Get sleep stages from last night

```
Use googlehealth_list_data_points with:
  data_type: "sleep"
  page_size: 1
```

## OAuth Scopes

All scopes use the base URL `https://www.googleapis.com/auth/googlehealth`:

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

## Project Structure

```
google-health-mcp-v1/
  src/
    index.ts          # MCP server with 12 read-only tool registrations
    api-client.ts     # Shared HTTP client with OAuth and error handling
    constants.ts      # API base URL, character limit, data type enum
  dist/               # Compiled JavaScript (npm run build)
  evaluation.xml      # 10 verified evaluation questions
  package.json
  tsconfig.json
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run
npm start

# Dev mode with auto-reload
npm run dev

# Test with MCP Inspector
npx @modelcontextprotocol/inspector node dist/index.js
```

## Evaluation

The `evaluation.xml` file contains 10 verified questions testing multi-tool workflows against real Google Health data. Run evaluations with:

```bash
pip install anthropic mcp

python scripts/evaluation.py \
  -t stdio \
  -c node \
  -a dist/index.js \
  -e GOOGLE_HEALTH_ACCESS_TOKEN=ya29.your-token \
  evaluation.xml
```

## API Notes

- The Google Health API is the successor to the Fitbit Web API, rebuilt on Google infrastructure
- Data comes from Fitbit devices, Pixel Watch, and third-party apps via Health Connect
- The `dailyRollUp` endpoint uses civil time (date objects), while `rollUp` uses physical time (ISO 8601 timestamps)
- Not all data types support all operations. The API returns an error listing supported actions if you try an unsupported one
- Rate limits apply. The server returns actionable error messages when limits are hit

## License

MIT
