'use strict';

const { createHash } = require('node:crypto');
const COLLECTIONS = ['events', 'sessions', 'auth', 'scans', 'counters', 'leases'];
const hash = value => createHash('sha256').update(value).digest('hex');
const rows = result => Array.isArray(result && result.data) ? result.data : result && result.data ? [result.data] : [];
const plain = row => { if (!row) return null; const { _id, ...value } = row; return value; };

class CloudBaseStore {
  constructor(db) { this.db = db; }
  collection(bucket, context = this.db) { return context.collection('dadi_' + bucket); }

  async initialize() {
    // Creating an existing collection is harmless; other errors are not hidden.
    for (const bucket of COLLECTIONS) {
      try { await this.db.createCollection('dadi_' + bucket); }
      catch (error) {
        if (!/exist|已存在/i.test(String(error.code || '') + ' ' + String(error.message || ''))) throw error;
      }
    }
  }

  async read(bucket, key, context = this.db) {
    return plain(rows(await this.collection(bucket, context).doc(key).get())[0]);
  }
  async get(bucket, key) { return this.read(bucket, key); }
  async put(bucket, key, value) { await this.collection(bucket).doc(key).set(value); return value; }
  async remove(bucket, key) { await this.collection(bucket).doc(key).remove(); }
  async ensure(bucket, key, value) {
    return this.transaction(async tx => {
      const existing = await this.read(bucket, key, tx);
      if (existing) return existing;
      await this.collection(bucket, tx).doc(key).set(value);
      return value;
    });
  }
  async transaction(callback) {
    const result = await this.db.runTransaction(callback, 5);
    // node-sdk versions return either callback value or {result: callbackValue}.
    return result && Object.prototype.hasOwnProperty.call(result, 'result') ? result.result : result;
  }
  async list(bucket) {
    const result = [];
    let lastId = '';
    while (true) {
      let query = this.collection(bucket);
      if (lastId) query = query.where({ _id: this.db.command.gt(lastId) });
      const page = rows(await query.orderBy('_id', 'asc').limit(100).get());
      result.push(...page.map(plain));
      if (page.length < 100) return result;
      lastId = page[page.length - 1]._id;
    }
  }

  async recordScan(value) {
    const nonceKey = hash(value.eventId + ':' + value.nonce);
    return this.transaction(async tx => {
      const existing = await this.read('scans', nonceKey, tx);
      if (existing) return { duplicate: true, scan: existing };
      const counter = await this.read('counters', value.eventId, tx);
      const id = Number(counter && counter.sequence || 0) + 1;
      const scan = { ...value, id, status: 'pending', ackAt: null, deviceId: '', errorCode: '', profileClickedAt: null };
      await this.collection('counters', tx).doc(value.eventId).set({ sequence: id });
      await this.collection('scans', tx).doc(nonceKey).set(scan);
      return { duplicate: false, scan };
    });
  }

  async scansAfter(eventId, after, limit) {
    const page = rows(await this.collection('scans')
      .where({ eventId, id: this.db.command.gt(after) }).orderBy('id', 'asc').limit(limit).get());
    return page.map(plain);
  }
  async latestCursor(eventId) {
    const counter = await this.get('counters', eventId);
    return Number(counter && counter.sequence || 0);
  }
  async profileClick(eventId, nonce, now) {
    const key = hash(eventId + ':' + nonce);
    return this.transaction(async tx => {
      const current = await this.read('scans', key, tx);
      if (!current || current.profileClickedAt) return current;
      const updated = { ...current, profileClickedAt: now };
      await this.collection('scans', tx).doc(key).set(updated);
      return updated;
    });
  }
  async claim(eventId, deviceId, now) {
    return this.transaction(async tx => {
      const current = await this.read('leases', eventId, tx);
      if (current && current.expiresAt > now && current.deviceId !== deviceId) {
        return { claimed: false, expiresAt: current.expiresAt };
      }
      const next = { deviceId, expiresAt: now + 30000 };
      await this.collection('leases', tx).doc(eventId).set(next);
      return { claimed: true, expiresAt: next.expiresAt };
    });
  }
  async scanById(eventId, id) {
    return plain(rows(await this.collection('scans').where({ eventId, id }).limit(1).get())[0]);
  }
  async acknowledge(eventId, id, value) {
    const found = await this.scanById(eventId, id);
    if (!found) return null;
    const nonceKey = hash(eventId + ':' + found.nonce);
    return this.transaction(async tx => {
      const current = await this.read('scans', nonceKey, tx);
      if (!current || current.status === 'played') return current;
      const updated = { ...current, ...value };
      await this.collection('scans', tx).doc(nonceKey).set(updated);
      return updated;
    });
  }

  async filteredScans(filter) {
    const result = [];
    let lastId = '';
    // Stable _id pagination avoids a growing skip and does not silently truncate data.
    // Date/event filtering is done after paging to avoid requiring many compound indexes.
    while (true) {
      let query = this.collection('scans');
      if (lastId) query = query.where({ _id: this.db.command.gt(lastId) });
      const page = rows(await query.orderBy('_id', 'asc').limit(100).get());
      for (const item of page) {
        if (item.createdAt < filter.from || item.createdAt >= filter.to) continue;
        if (filter.eventId && item.eventId !== filter.eventId) continue;
        if (filter.sessionId && item.sessionId !== filter.sessionId) continue;
        result.push(plain(item));
      }
      if (page.length < 100) return result.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
      lastId = page[page.length - 1]._id;
    }
  }
  async close() {}
}

async function createCloudBaseStore(options = {}) {
  const sdk = require('@cloudbase/node-sdk');
  const config = { env: process.env.CLOUDBASE_ENV_ID || process.env.TCB_ENV || sdk.SYMBOL_CURRENT_ENV };
  if (process.env.CLOUDBASE_APIKEY) config.accessKey = process.env.CLOUDBASE_APIKEY;
  if (options.context) config.context = options.context;
  const store = new CloudBaseStore(sdk.init(config).database());
  if (process.env.INIT_COLLECTIONS === '1') await store.initialize();
  return store;
}

module.exports = { CloudBaseStore, createCloudBaseStore, COLLECTIONS };
