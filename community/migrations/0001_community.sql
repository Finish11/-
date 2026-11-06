CREATE TABLE IF NOT EXISTS community_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL UNIQUE,
  device_hash TEXT NOT NULL,
  region TEXT NOT NULL,
  carrier TEXT NOT NULL,
  incident_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  ru_sites_ok INTEGER NOT NULL DEFAULT 1,
  foreign_sites_ok INTEGER NOT NULL DEFAULT 0,
  upvotes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS community_feed_cursor ON community_incidents(created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS community_votes (
  incident_id INTEGER NOT NULL REFERENCES community_incidents(id) ON DELETE CASCADE,
  device_hash TEXT NOT NULL,
  PRIMARY KEY (incident_id, device_hash)
);
CREATE TABLE IF NOT EXISTS community_tombstones (
  client_id TEXT PRIMARY KEY,
  device_hash TEXT NOT NULL,
  deleted_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS community_rate_limits (
  key TEXT PRIMARY KEY,
  window INTEGER NOT NULL,
  count INTEGER NOT NULL
);
