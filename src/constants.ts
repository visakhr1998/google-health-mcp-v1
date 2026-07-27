export const API_BASE_URL = "https://health.googleapis.com/v4";
export const CHARACTER_LIMIT = 25000;

const SCOPE_PREFIX = "https://www.googleapis.com/auth/googlehealth";

/**
 * Scopes without which most tools are unusable. Checked at startup; a token
 * missing any of these produces a warning telling you to re-run `npm run auth`.
 */
export const REQUIRED_SCOPES = [
  `${SCOPE_PREFIX}.activity_and_fitness.readonly`,
  `${SCOPE_PREFIX}.health_metrics_and_measurements.readonly`,
  `${SCOPE_PREFIX}.sleep.readonly`,
  `${SCOPE_PREFIX}.nutrition.readonly`,
  `${SCOPE_PREFIX}.profile.readonly`,
  `${SCOPE_PREFIX}.settings.readonly`,
] as const;

/**
 * Everything requested at login. The extras cover data types that are in
 * DATA_TYPES but gated behind their own scopes (electrocardiogram,
 * irregular-rhythm-notification) plus GPS tracks in TCX exports. Requesting
 * them up front avoids a puzzling 403 later; they are not in REQUIRED_SCOPES
 * so an older token granting only the core six still starts without warnings.
 */
export const ALL_SCOPES = [
  ...REQUIRED_SCOPES,
  `${SCOPE_PREFIX}.ecg.readonly`,
  `${SCOPE_PREFIX}.irn.readonly`,
  `${SCOPE_PREFIX}.location.readonly`,
] as const;

export const DATA_TYPES = [
  "active-energy-burned",
  "active-minutes",
  "active-zone-minutes",
  "activity-level",
  "altitude",
  "blood-glucose",
  "body-fat",
  "calories-in-heart-rate-zone",
  "core-body-temperature",
  "daily-heart-rate-variability",
  "daily-heart-rate-zones",
  "daily-oxygen-saturation",
  "daily-respiratory-rate",
  "daily-resting-heart-rate",
  "daily-sleep-temperature-derivations",
  "daily-vo2-max",
  "distance",
  "electrocardiogram",
  "elevation",
  "exercise",
  "floors",
  "food",
  "food-measurement-unit",
  "heart-rate",
  "heart-rate-variability",
  "height",
  "hydration-log",
  "irregular-rhythm-notification",
  "nutrition-log",
  "oxygen-saturation",
  "respiratory-rate-sleep-summary",
  "run-vo2-max",
  "sedentary-period",
  "sleep",
  "steps",
  "swim-lengths-data",
  "time-in-heart-rate-zone",
  "total-calories",
  "vo2-max",
  "weight",
] as const;

export type DataType = (typeof DATA_TYPES)[number];
