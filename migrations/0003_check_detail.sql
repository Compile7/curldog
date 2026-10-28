-- Response snapshot (status text, final URL, headers, first 4 KB of body) for failed checks, as JSON.
ALTER TABLE checks ADD COLUMN detail TEXT;
