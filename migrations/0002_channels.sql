-- Notification channels, shared across projects.
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,          -- google_chat | telegram | webhook
  config TEXT NOT NULL,        -- JSON: {url} or {token, chat_id}
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE project_channels (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, channel_id)
);
CREATE INDEX project_channels_channel ON project_channels(channel_id);

-- Move each distinct project webhook into a channel.
INSERT INTO channels (id, name, type, config, created_by, created_at)
SELECT lower(hex(randomblob(6))),
  CASE WHEN webhook_url LIKE 'https://chat.googleapis.com/%' THEN 'Google Chat' ELSE 'Webhook' END,
  CASE WHEN webhook_url LIKE 'https://chat.googleapis.com/%' THEN 'google_chat' ELSE 'webhook' END,
  json_object('url', webhook_url), created_by, created_at
FROM (SELECT webhook_url, MIN(created_by) AS created_by, MIN(created_at) AS created_at
      FROM projects WHERE webhook_url != '' GROUP BY webhook_url);

INSERT INTO project_channels (project_id, channel_id)
SELECT p.id, c.id FROM projects p JOIN channels c ON json_extract(c.config, '$.url') = p.webhook_url;

ALTER TABLE projects DROP COLUMN webhook_url;
