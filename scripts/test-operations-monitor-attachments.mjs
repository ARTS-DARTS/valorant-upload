import assert from 'node:assert/strict';
import test from 'node:test';

import { runOperationalMonitor, sendTelegramDocument } from './monitor-operations-telegram.mjs';

class Ref {
  constructor(db, path) { this.db = db; this.path = path; }
  async get() {
    const value = this.db.values.get(this.path);
    return { exists:value != null, data:() => value };
  }
  async set(value, options = {}) {
    const previous = this.db.values.get(this.path) || {};
    this.db.values.set(this.path, options.merge ? { ...previous, ...value } : value);
  }
}

class MonitorDb {
  constructor() { this.values = new Map(); }
  collection(name) {
    if (name === 'settings') return { doc:id => new Ref(this, `${name}/${id}`) };
    if (name === 'billing_orders') return {
      where:() => ({ limit:() => ({ get:async () => ({ docs:[] }) }) }),
    };
    throw new Error(`unexpected collection ${name}`);
  }
}

test('Telegram document follows a migrated chat id', async () => {
  const chatIds = [];
  await sendTelegramDocument('token', '-1', '{}', 'errors.json', {
    fetchImpl:async (_url, options) => {
      chatIds.push(options.body.get('chat_id'));
      return chatIds.length === 1
        ? { ok:false, status:400, json:async () => ({ ok:false, parameters:{ migrate_to_chat_id:'-1001' } }) }
        : { ok:true, status:200, json:async () => ({ ok:true }) };
    },
  });
  assert.deepEqual(chatIds, ['-1', '-1001']);
});

test('failed attachment retries without repeating the text alert', async () => {
  const db = new MonitorDb();
  let texts = 0;
  let documents = 0;
  const options = {
    db,
    env:{ TELEGRAM_BOT_TOKEN:'token', TELEGRAM_ALERT_CHAT_ID:'chat' },
    collector:async () => ({ problems:['error burst'], errorCount:6 }),
    sender:async () => { texts += 1; },
    errorLoader:async () => [],
    documentSender:async () => {
      documents += 1;
      if (documents === 1) throw new Error('temporary upload failure');
    },
  };
  const first = await runOperationalMonitor(options);
  const second = await runOperationalMonitor(options);
  assert.equal(first.documentSent, false);
  assert.equal(second.documentSent, true);
  assert.equal(texts, 1);
  assert.equal(documents, 2);
});
