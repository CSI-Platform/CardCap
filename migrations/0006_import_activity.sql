CREATE TABLE IF NOT EXISTS import_activity (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  label TEXT NOT NULL,
  state TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_import_activity_user_time ON import_activity(user_id, started_at DESC);

INSERT OR IGNORE INTO import_activity (id, user_id, label, state, detail, started_at)
SELECT 'photo-' || id, user_id, 'Business card',
  CASE WHEN status IN ('failed', 'error') THEN 'failed' ELSE 'complete' END,
  CASE WHEN status IN ('failed', 'error') THEN 'Unable to extract this card.'
       WHEN status = 'duplicate' THEN 'Duplicate merged' ELSE 'Card processed' END, created_at
FROM extraction_jobs;

INSERT OR IGNORE INTO import_activity (id, user_id, label, state, detail, started_at)
SELECT 'capture-' || c.id, c.user_id, COALESCE(NULLIF(json_extract(s.capture_source, '$.url'), ''), 'Pasted text'),
  'complete', 'Contact saved', COALESCE(NULLIF(json_extract(s.capture_source, '$.checkedAt'), ''), c.created_at)
FROM contact_sources s JOIN contacts c ON c.id = s.contact_id;
