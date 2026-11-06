// Kept identical to migrations/0001_init.sql (a test compares them). The Worker also runs this on
// startup so a local `wrangler dev` works before a human applies migrations to a remote D1 database.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  time INTEGER NOT NULL,
  kind TEXT NOT NULL,
  bot TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_topic_seq ON events (topic, seq);
CREATE INDEX IF NOT EXISTS events_topic_time ON events (topic, time);

CREATE TABLE IF NOT EXISTS snapshots (
  topic TEXT NOT NULL,
  slot TEXT NOT NULL,
  seq INTEGER NOT NULL,
  time INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (topic, slot)
);

CREATE TABLE IF NOT EXISTS budget (
  day TEXT PRIMARY KEY,
  publishes INTEGER NOT NULL
);
`.trim();
