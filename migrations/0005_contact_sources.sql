CREATE TABLE IF NOT EXISTS contact_sources (
  contact_id TEXT PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  capture_source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS capture_usage (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);
