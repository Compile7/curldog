-- Status page: pick which monitors are public and what they're called there.
ALTER TABLE monitors ADD COLUMN on_status INTEGER NOT NULL DEFAULT 1; -- 0: hidden from the status page
ALTER TABLE monitors ADD COLUMN public_name TEXT NOT NULL DEFAULT ''; -- '': use the monitor's name

-- Incidents written by people, with updates ("Investigating", "Identified", ...), shown on the status page.
CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  impact TEXT NOT NULL,            -- minor | major
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER              -- NULL: still open
);
CREATE INDEX incidents_project ON incidents(project_id, created_at);

CREATE TABLE incident_updates (
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  status TEXT NOT NULL,            -- investigating | identified | monitoring | resolved
  message TEXT NOT NULL,
  author TEXT NOT NULL
);
CREATE INDEX incident_updates_incident ON incident_updates(incident_id, ts);
