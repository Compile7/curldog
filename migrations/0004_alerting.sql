-- Heartbeats, multi-step checks, regions, slow alerts, mute, acknowledge, reminders and escalation.
ALTER TABLE monitors ADD COLUMN type TEXT NOT NULL DEFAULT 'http';        -- http | heartbeat
ALTER TABLE monitors ADD COLUMN steps TEXT NOT NULL DEFAULT '[]';         -- JSON: requests run before the main one
ALTER TABLE monitors ADD COLUMN regions INTEGER NOT NULL DEFAULT 0;       -- 1: also check from US, EU and Asia
ALTER TABLE monitors ADD COLUMN slow_ms INTEGER NOT NULL DEFAULT 0;       -- 0: no slow alerts
ALTER TABLE monitors ADD COLUMN slow_since INTEGER;                       -- first of the current run of slow checks
ALTER TABLE monitors ADD COLUMN slow INTEGER NOT NULL DEFAULT 0;          -- slow alert is active
ALTER TABLE monitors ADD COLUMN muted_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE monitors ADD COLUMN token TEXT;                               -- heartbeat ping token
ALTER TABLE monitors ADD COLUMN last_ping_at INTEGER;
ALTER TABLE monitors ADD COLUMN down_since INTEGER;
ALTER TABLE monitors ADD COLUMN acked_by TEXT;
ALTER TABLE monitors ADD COLUMN acked_at INTEGER;
ALTER TABLE monitors ADD COLUMN reminded_at INTEGER;
ALTER TABLE monitors ADD COLUMN escalated_at INTEGER;
ALTER TABLE monitors ADD COLUMN last_ok TEXT;                             -- JSON snapshot of the last passing response
CREATE UNIQUE INDEX monitors_token ON monitors(token);

UPDATE monitors SET down_since = (SELECT MAX(ts) FROM events e WHERE e.monitor_id = monitors.id AND e.status = 'down')
WHERE status = 'down';

ALTER TABLE projects ADD COLUMN remind_min INTEGER NOT NULL DEFAULT 0;     -- 0: no reminders
ALTER TABLE projects ADD COLUMN escalate_min INTEGER NOT NULL DEFAULT 0;   -- 0: no escalation
ALTER TABLE projects ADD COLUMN escalate_to TEXT NOT NULL DEFAULT '[]';    -- JSON channel ids
ALTER TABLE projects ADD COLUMN muted_until INTEGER NOT NULL DEFAULT 0;

ALTER TABLE events ADD COLUMN summary TEXT;   -- AI explanation of a failure
ALTER TABLE events ADD COLUMN actor TEXT;     -- who acknowledged

-- SSL certificate and domain expiry, refreshed daily per hostname.
CREATE TABLE expiry (
  host TEXT NOT NULL,
  kind TEXT NOT NULL,              -- ssl | domain
  expires_at INTEGER,
  checked_at INTEGER NOT NULL,
  error TEXT,
  warned INTEGER NOT NULL DEFAULT 0, -- smallest "days left" threshold already alerted
  PRIMARY KEY (host, kind)
);
