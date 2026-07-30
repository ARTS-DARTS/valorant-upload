import assert from 'node:assert/strict';
import test from 'node:test';

import { Timestamp } from 'firebase-admin/firestore';

import { capabilitiesForPlan } from '../api/_lib/billing/entitlements.js';
import {
  applyEngagementAction,
  createEngagementHandler,
  engagementInternals,
} from '../api/engagement.js';

const now = new Date('2026-07-30T12:00:00.000Z');

function activeSponsor(version = 7) {
  return {
    schema_version: 1,
    plan_id: 'sponsor',
    status: 'active',
    valid_from: new Date(now.getTime() - 60_000),
    access_until: new Date(now.getTime() + 60_000),
    capabilities: capabilitiesForPlan('sponsor'),
    entitlement_version: version,
  };
}

function metadata(weight = 2) {
  return {
    uid: 'user-1',
    weight,
    entitlement_version: 7,
    idempotency_key_hash: 'hash',
    cast_at: Timestamp.fromDate(now),
  };
}

function response() {
  return {
    statusCode: 200,
    headers: new Map(),
    body: null,
    setHeader(name, value) { this.headers.set(name, value); },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; },
  };
}

class MemoryRef {
  constructor(db, path) { this.db = db; this.path = path; }
  collection(name) { return new MemoryCollection(this.db, `${this.path}/${name}`); }
}

class MemoryCollection {
  constructor(db, path) { this.db = db; this.path = path; }
  doc(id) { return new MemoryRef(this.db, `${this.path}/${id}`); }
}

class MemorySnapshot {
  constructor(ref, data) { this.ref = ref; this._data = data; this.exists = data !== undefined; }
  data() { return this._data; }
}

class MemoryDb {
  constructor(seed = {}) { this.docs = new Map(Object.entries(seed)); }
  collection(name) { return new MemoryCollection(this, name); }
  async runTransaction(callback) {
    const staged = new Map(this.docs);
    const tx = {
      get: async ref => new MemorySnapshot(ref, staged.get(ref.path)),
      set: (ref, data) => staged.set(ref.path, data),
      create: (ref, data) => {
        if (staged.has(ref.path)) throw new Error('already-exists');
        staged.set(ref.path, data);
      },
      update: (ref, update) => {
        if (!staged.has(ref.path)) throw new Error('not-found');
        staged.set(ref.path, { ...staged.get(ref.path), ...update });
      },
      delete: ref => staged.delete(ref.path),
    };
    const result = await callback(tx);
    this.docs = staged;
    return result;
  }
}

test('lineup like stores people and sponsor score separately', () => {
  const result = engagementInternals.lineupLikeMutation({
    data: { likes_count: 10, likes_user_count: 8, likes_user_score: 8, likes_system_bonus: 2 },
    marker: null,
    desired: true,
    metadata: metadata(2),
  });
  assert.equal(result.parentUpdate.likes_user_count, 9);
  assert.equal(result.parentUpdate.likes_user_score, 10);
  assert.equal(result.parentUpdate.likes_count, 12);
  assert.equal(result.markerData.weight, 2);
});

test('legacy aggregate initialization subtracts known system bonuses', () => {
  const like = engagementInternals.lineupLikeMutation({
    data: { likes_count: 12, likes_system_bonus: 4 },
    marker: null,
    desired: true,
    metadata: metadata(2),
  });
  assert.equal(like.parentUpdate.likes_user_score, 10);
  assert.equal(like.parentUpdate.likes_system_bonus, 4);
  assert.equal(like.parentUpdate.likes_count, 14);

  const relevance = engagementInternals.lineupReputationMutation({
    data: { votes_actual: 9, votes_outdated: 0, relevance_system_bonus: 5 },
    marker: null,
    desired: true,
    metadata: metadata(2),
  });
  assert.equal(relevance.parentUpdate.relevance_actual_score, 6);
  assert.equal(relevance.parentUpdate.votes_actual, 11);
});

test('removing a vote subtracts its stored weight after subscription changes', () => {
  const result = engagementInternals.lineupReputationMutation({
    data: {
      votes_actual: 9,
      votes_outdated: 3,
      relevance_actual_voters: 5,
      relevance_actual_score: 7,
      relevance_outdated_voters: 3,
      relevance_outdated_score: 3,
      relevance_system_bonus: 2,
    },
    marker: { vote: true, weight: 2 },
    desired: null,
    metadata: metadata(1),
  });
  assert.equal(result.parentUpdate.relevance_actual_voters, 4);
  assert.equal(result.parentUpdate.relevance_actual_score, 5);
  assert.equal(result.parentUpdate.votes_actual, 7);
  assert.equal(result.markerWrite, 'delete');
});

test('poll and duel increment weighted result but one real ballot', () => {
  const poll = engagementInternals.pollVoteMutation({
    data: { counts: { a: 3, b: 4 }, ballotCounts: { a: 3, b: 4 }, totalVotes: 7, totalBallots: 7 },
    marker: null,
    desired: 'a',
    metadata: metadata(2),
  });
  assert.equal(poll.parentUpdate.counts.a, 5);
  assert.equal(poll.parentUpdate.ballotCounts.a, 4);
  assert.equal(poll.parentUpdate.totalVotes, 9);
  assert.equal(poll.parentUpdate.totalBallots, 8);

  const duel = engagementInternals.duelVoteMutation({
    data: { votes1: 5, votes2: 4, ballots1: 4, ballots2: 4 },
    marker: null,
    desired: 1,
    metadata: metadata(2),
  });
  assert.equal(duel.parentUpdate.votes1, 7);
  assert.equal(duel.parentUpdate.ballots1, 5);
  assert.equal(duel.parentUpdate.totalBallots, 9);
});

test('same request id is durable and does not toggle a sponsor like twice', async () => {
  const db = new MemoryDb({
    'account_entitlements/user-1': activeSponsor(),
    'lineups/lineup-1': {
      likes_count: 0,
      likes_user_count: 0,
      likes_user_score: 0,
      likes_system_bonus: 0,
    },
  });
  const input = engagementInternals.parsedAction('lineup-like', {
    target_id: 'lineup-1',
    request_id: 'abcdefghijklmnop',
    liked: true,
  });
  const first = await applyEngagementAction({ db, uid: 'user-1', input, now });
  const repeated = await applyEngagementAction({ db, uid: 'user-1', input, now });
  assert.deepEqual(repeated, first);
  assert.equal(first.likes_count, 2);
  assert.equal(db.docs.get('lineups/lineup-1').likes_count, 2);
  assert.equal(db.docs.get('lineup_likes/lineup-1/users/user-1').weight, 2);
});

test('request id cannot be reused for a different desired state', async () => {
  const db = new MemoryDb({
    'account_entitlements/user-1': activeSponsor(),
    'lineups/lineup-1': { likes_count: 0 },
  });
  const first = engagementInternals.parsedAction('lineup-like', {
    target_id: 'lineup-1', request_id: 'abcdefghijklmnop', liked: true,
  });
  const forged = engagementInternals.parsedAction('lineup-like', {
    target_id: 'lineup-1', request_id: 'abcdefghijklmnop', liked: false,
  });
  await applyEngagementAction({ db, uid: 'user-1', input: first, now });
  await assert.rejects(
    applyEngagementAction({ db, uid: 'user-1', input: forged, now }),
    error => error?.status === 409 && error?.message === 'request_id_reused',
  );
});

test('HTTP handler rejects missing auth before touching Firestore', async () => {
  let databaseCalls = 0;
  const handler = createEngagementHandler({
    db: { runTransaction() { databaseCalls += 1; } },
    preAuthCheck: () => () => {},
    rateCheck: () => {},
  });
  const res = response();
  await handler({ method: 'POST', headers: {}, params: { action: 'lineup-like' }, body: {} }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'authentication_required');
  assert.equal(databaseCalls, 0);
});
