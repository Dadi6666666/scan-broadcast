'use strict';

const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const { dirname } = require('node:path');

class SQLiteStore {
  constructor(filename) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS documents (
        bucket TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(bucket,key)
      );
      CREATE TABLE IF NOT EXISTS scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL, nonce TEXT NOT NULL, created_at INTEGER NOT NULL,
        session_id TEXT NOT NULL, visitor_id TEXT NOT NULL, source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', ack_at INTEGER,
        device_id TEXT NOT NULL DEFAULT '', error_code TEXT NOT NULL DEFAULT '', profile_clicked_at INTEGER,
        UNIQUE(event_id,nonce)
      );
      CREATE INDEX IF NOT EXISTS scans_event_cursor ON scans(event_id,id);
      CREATE INDEX IF NOT EXISTS scans_time ON scans(created_at);
    `);
    if (!this.db.prepare('PRAGMA table_info(scans)').all().some(row => row.name === 'profile_clicked_at')) {
      this.db.exec('ALTER TABLE scans ADD COLUMN profile_clicked_at INTEGER');
    }
  }

  async get(bucket, key) {
    const row = this.db.prepare('SELECT value FROM documents WHERE bucket=? AND key=?').get(bucket, key);
    return row ? JSON.parse(row.value) : null;
  }

  async put(bucket, key, value) {
    this.db.prepare('INSERT INTO documents VALUES (?,?,?) ON CONFLICT(bucket,key) DO UPDATE SET value=excluded.value')
      .run(bucket, key, JSON.stringify(value));
    return value;
  }

  async ensure(bucket, key, value) {
    this.db.prepare('INSERT OR IGNORE INTO documents VALUES (?,?,?)').run(bucket, key, JSON.stringify(value));
    return this.get(bucket, key);
  }

  async remove(bucket, key) {
    this.db.prepare('DELETE FROM documents WHERE bucket=? AND key=?').run(bucket, key);
  }

  async list(bucket) {
    return this.db.prepare('SELECT value FROM documents WHERE bucket=? ORDER BY key').all(bucket).map(row => JSON.parse(row.value));
  }

  scan(row) {
    return row ? {
      id: row.id, eventId: row.event_id, nonce: row.nonce, createdAt: row.created_at,
      sessionId: row.session_id, visitorId: row.visitor_id, source: row.source,
      status: row.status, ackAt: row.ack_at, deviceId: row.device_id, errorCode: row.error_code,
      profileClickedAt: row.profile_clicked_at
    } : null;
  }

  async recordScan(value) {
    // The unique constraint and transaction also protect concurrent server processes.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO scans
        (event_id,nonce,created_at,session_id,visitor_id,source) VALUES (?,?,?,?,?,?)`)
        .run(value.eventId, value.nonce, value.createdAt, value.sessionId, value.visitorId, value.source);
      const scan = this.scan(this.db.prepare('SELECT * FROM scans WHERE event_id=? AND nonce=?').get(value.eventId, value.nonce));
      this.db.exec('COMMIT');
      return { duplicate: inserted.changes === 0, scan };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async scansAfter(eventId, after, limit) {
    return this.db.prepare('SELECT * FROM scans WHERE event_id=? AND id>? ORDER BY id LIMIT ?')
      .all(eventId, after, limit).map(row => this.scan(row));
  }

  async latestCursor(eventId) {
    return this.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM scans WHERE event_id=?').get(eventId).id;
  }

  async profileClick(eventId, nonce, now) {
    this.db.prepare('UPDATE scans SET profile_clicked_at=? WHERE event_id=? AND nonce=? AND profile_clicked_at IS NULL')
      .run(now, eventId, nonce);
    return this.scan(this.db.prepare('SELECT * FROM scans WHERE event_id=? AND nonce=?').get(eventId, nonce));
  }

  async claim(eventId, deviceId, now) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare("SELECT value FROM documents WHERE bucket='leases' AND key=?").get(eventId);
      const lease = row ? JSON.parse(row.value) : null;
      if (lease && lease.expiresAt > now && lease.deviceId !== deviceId) {
        this.db.exec('COMMIT');
        return { claimed: false, expiresAt: lease.expiresAt };
      }
      const next = { deviceId, expiresAt: now + 30000 };
      this.db.prepare("INSERT INTO documents VALUES ('leases',?,?) ON CONFLICT(bucket,key) DO UPDATE SET value=excluded.value")
        .run(eventId, JSON.stringify(next));
      this.db.exec('COMMIT');
      return { claimed: true, expiresAt: next.expiresAt };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  async scanById(eventId, id) {
    return this.scan(this.db.prepare('SELECT * FROM scans WHERE event_id=? AND id=?').get(eventId, id));
  }

  async acknowledge(eventId, id, value) {
    // A delayed failure acknowledgement must never overwrite successful playback.
    this.db.prepare(`UPDATE scans SET status=?,ack_at=?,device_id=?,error_code=?
      WHERE event_id=? AND id=? AND status!='played'`)
      .run(value.status, value.ackAt, value.deviceId, value.errorCode, eventId, id);
    return this.scanById(eventId, id);
  }

  async filteredScans(filter) {
    const clauses = ['created_at>=?', 'created_at<?'];
    const values = [filter.from, filter.to];
    if (filter.eventId) { clauses.push('event_id=?'); values.push(filter.eventId); }
    if (filter.sessionId) { clauses.push('session_id=?'); values.push(filter.sessionId); }
    return this.db.prepare('SELECT * FROM scans WHERE ' + clauses.join(' AND ') + ' ORDER BY created_at,id')
      .all(...values).map(row => this.scan(row));
  }

  async close() { this.db.close(); }
}

exports.SQLiteStore = SQLiteStore;
