import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS raw_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,              -- 'google' | 'apple' | 'learnuq'
    source_calendar TEXT NOT NULL,     -- calendar id/name within that source
    source_uid TEXT NOT NULL,          -- event id / ICS UID from the source
    title TEXT,
    description TEXT,
    location TEXT,
    start_at TEXT NOT NULL,            -- ISO 8601
    end_at TEXT,
    all_day INTEGER NOT NULL DEFAULT 0,
    raw_json TEXT,
    fetched_at TEXT NOT NULL,
    UNIQUE(source, source_calendar, source_uid)
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    location TEXT,
    start_at TEXT NOT NULL,
    end_at TEXT,
    all_day INTEGER NOT NULL DEFAULT 0,
    primary_raw_event_id INTEGER REFERENCES raw_events(id),
    merged_raw_event_ids TEXT NOT NULL DEFAULT '[]', -- JSON array of raw_events.id
    category TEXT,                      -- 'uni' | 'trybe' | 'gym_food' | 'life_admin' | NULL
    status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'snoozed' | 'dismissed' | 'done'
    snoozed_until TEXT,
    dismiss_count INTEGER NOT NULL DEFAULT 0,
    last_interacted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_raw_events_source ON raw_events(source, source_calendar);
  CREATE INDEX IF NOT EXISTS idx_events_start_at ON events(start_at);
  CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
`);
