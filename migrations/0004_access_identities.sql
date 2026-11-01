CREATE TABLE IF NOT EXISTS access_identities (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (issuer, subject),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_access_identities_user ON access_identities(user_id);
CREATE INDEX IF NOT EXISTS idx_users_normalized_email ON users(lower(trim(email)));
