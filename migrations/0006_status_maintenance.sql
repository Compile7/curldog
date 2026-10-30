-- Public status page per project, at /status/<slug>. NULL: no public page.
ALTER TABLE projects ADD COLUMN status_slug TEXT;
CREATE UNIQUE INDEX projects_status_slug ON projects(status_slug);

-- Scheduled maintenance: no checks and no alerts for the project while a window is open.
CREATE TABLE maintenance (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  starts_at INTEGER NOT NULL,          -- first occurrence
  ends_at INTEGER NOT NULL,
  repeat TEXT NOT NULL DEFAULT 'none', -- none | daily | weekly
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX maintenance_project ON maintenance(project_id);
