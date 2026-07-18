CREATE TABLE IF NOT EXISTS learning_cities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city TEXT NOT NULL,
  normalized_city TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS forecast_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  normalized_city TEXT NOT NULL,
  city TEXT NOT NULL,
  station_id TEXT NOT NULL,
  station_name TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  target_date TEXT NOT NULL,
  horizon_days INTEGER NOT NULL,
  generated_at TEXT NOT NULL,
  openweather_temp REAL,
  openmeteo_temp REAL,
  model_temp REAL,
  dwd_pattern_temp REAL,
  likely_temp REAL,
  openweather_rain_probability REAL,
  openmeteo_rain_probability REAL,
  likely_rain_probability REAL,
  likely_rain_mm REAL,
  payload_json TEXT NOT NULL,
  verified_at TEXT,
  observed_temp REAL,
  observed_rain_mm REAL,
  temp_error REAL,
  rain_brier REAL,
  UNIQUE(normalized_city, target_date, snapshot_date)
);

CREATE INDEX IF NOT EXISTS forecast_snapshots_verify_idx
  ON forecast_snapshots(station_id, target_date, verified_at);

CREATE TABLE IF NOT EXISTS model_metrics (
  station_id TEXT PRIMARY KEY,
  cases INTEGER NOT NULL DEFAULT 0,
  temp_model_weight REAL NOT NULL DEFAULT 0.76,
  rain_probability_model_weight REAL NOT NULL DEFAULT 0.70,
  rain_amount_model_weight REAL NOT NULL DEFAULT 0.72,
  temp_mae_openweather REAL,
  temp_mae_openmeteo REAL,
  temp_mae_likely REAL,
  rain_brier_openweather REAL,
  rain_brier_openmeteo REAL,
  rain_brier_likely REAL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS api_cache (
  cache_key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO learning_cities(city, normalized_city) VALUES
  ('Berlin', 'berlin'),
  ('Muenchen', 'muenchen'),
  ('Hamburg', 'hamburg'),
  ('Coburg', 'coburg');
