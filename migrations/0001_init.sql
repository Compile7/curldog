CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  webhook_url TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE monitors (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  curl TEXT NOT NULL,
  request TEXT NOT NULL,                -- parsed curl, JSON
  interval_sec INTEGER NOT NULL,
  timeout_ms INTEGER NOT NULL DEFAULT 10000,
  expected_status TEXT NOT NULL DEFAULT '200-399',
  keyword TEXT NOT NULL DEFAULT '',
  paused INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | up | down
  last_checked_at INTEGER,
  last_latency_ms INTEGER,
  last_error TEXT,
  next_check_at INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX monitors_due ON monitors(paused, next_check_at);
CREATE INDEX monitors_project ON monitors(project_id);

CREATE TABLE checks (
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  status_code INTEGER,
  latency_ms INTEGER,
  error TEXT
);
CREATE INDEX checks_monitor_ts ON checks(monitor_id, ts);
CREATE INDEX checks_ts ON checks(ts);

-- Status changes (down / recovered). Drives the incident feed and webhooks.
CREATE TABLE events (
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT
);
CREATE INDEX events_monitor_ts ON events(monitor_id, ts);
CREATE INDEX events_ts ON events(ts);
