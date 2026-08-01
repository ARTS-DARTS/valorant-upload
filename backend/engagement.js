import { createHash } from 'node:crypto';

import { FieldValue, Timestamp } from 'firebase-admin/firestore';

import { adminAuth, adminFirestore } from './_lib/firebase-admin.js';
import { normalizeEntitlement } from './_lib/billing/entitlements.js';
import { createPreAuthLimiter } from './billing-me.js';

const ALLOWED_ORIGINS = new Set([
  'https://vlineups.ru',
  'https://www.vlineups.ru',
  'http://localhost:3000',
]);
const ACTIONS = new Set(['lineup-like', 'lineup-reputation', 'poll-vote', 'duel-vote']);
const ID_PATTERN = /^[^/\u0000-\u001f\u007f]{1,128}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,96}$/;
const AUTH_TIMEOUT_MS = 10_000;
const REQUEST_WINDOW_MS = 60_000;
const REQUEST_LIMIT = 90;
const REQUEST_MAX_KEYS = 10_000;
const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const preAuthLimiter = createPreAuthLimiter({
  requestLimit: 180,
  perIpConcurrencyLimit: 8,
  globalConcurrencyLimit: 64,
});
const requestWindows = new Map();

function clean(value) {
  return String(value ?? '').replace(/п»ї/g, '').trim();
}

function httpError(status, code) {
  return Object.assign(new Error(code), { status, code });
}

function setHeaders(req, res) {
  const origin = clean(req.headers.origin);
  if (ALLOWED_ORIGINS.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
}

function rejectForeignOrigin(req) {
  const origin = clean(req.headers.origin);
  return Boolean(origin && !ALLOWED_ORIGINS.has(origin));
}

function requestIp(req) {
  const value = clean(req.ip || req.socket?.remoteAddress).toLowerCase();
  if (!value) return 'unknown';
  return value.startsWith('::ffff:') ? value.slice(7) : value;
}

async function authorize(req, verifyIdToken, timeoutMs) {
  const header = clean(req.headers.authorization);
  if (!header.startsWith('Bearer ')) throw httpError(401, 'authentication_required');
  let timeout;
  try {
    return await Promise.race([
      verifyIdToken(header.slice(7).trim()),
      new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(httpError(503, 'authentication_timeout')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function checkUidRate(uid, nowMillis = Date.now()) {
  if (requestWindows.size >= REQUEST_MAX_KEYS) {
    for (const [key, value] of requestWindows) {
      if (nowMillis - value.startedAt >= REQUEST_WINDOW_MS) requestWindows.delete(key);
    }
  }
  const current = requestWindows.get(uid);
  if (!current || nowMillis - current.startedAt >= REQUEST_WINDOW_MS) {
    if (!current && requestWindows.size >= REQUEST_MAX_KEYS) throw httpError(429, 'too_many_requests');
    requestWindows.set(uid, { startedAt: nowMillis, count: 1 });
    return;
  }
  current.count += 1;
  if (current.count > REQUEST_LIMIT) throw httpError(429, 'too_many_requests');
}

function requireId(value, field) {
  const result = clean(value);
  if (!ID_PATTERN.test(result) || result === '.' || result === '..') {
    throw httpError(400, `invalid_${field}`);
  }
  return result;
}

function requireRequestId(value) {
  const result = clean(value);
  if (!REQUEST_ID_PATTERN.test(result)) throw httpError(400, 'invalid_request_id');
  return result;
}

function safeInt(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function markerWeight(data) {
  return data?.weight === 2 ? 2 : 1;
}

function entitlementWeight(entitlement, capability) {
  return entitlement?.capabilities?.[capability] === 2 ? 2 : 1;
}

function timestampMillis(value) {
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return 0;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parsedAction(action, body = {}) {
  if (!ACTIONS.has(action)) throw httpError(404, 'unknown_action');
  const targetId = requireId(body.target_id, 'target_id');
  const requestId = requireRequestId(body.request_id);
  if (action === 'lineup-like') {
    if (typeof body.liked !== 'boolean') throw httpError(400, 'invalid_liked');
    return { action, targetId, requestId, desired: body.liked };
  }
  if (action === 'lineup-reputation') {
    if (body.vote !== null && typeof body.vote !== 'boolean') {
      throw httpError(400, 'invalid_vote');
    }
    return { action, targetId, requestId, desired: body.vote };
  }
  if (action === 'poll-vote') {
    return {
      action,
      targetId,
      requestId,
      desired: requireId(body.option_id, 'option_id'),
    };
  }
  const choice = Number(body.choice);
  if (!Number.isSafeInteger(choice) || ![1, 2].includes(choice)) {
    throw httpError(400, 'invalid_choice');
  }
  return { action, targetId, requestId, desired: choice };
}

function requestIdentity(uid, input) {
  const bodyHash = hash(JSON.stringify({
    action: input.action,
    targetId: input.targetId,
    desired: input.desired,
  }));
  const receiptId = hash(`${uid}\0${input.action}\0${input.requestId}`);
  return { bodyHash, receiptId };
}

function markerMetadata(uid, input, entitlement, now) {
  return {
    uid,
    weight: entitlementWeight(entitlement, {
      'lineup-like': 'lineup_like_weight',
      'lineup-reputation': 'lineup_relevance_weight',
      'poll-vote': 'poll_vote_weight',
      'duel-vote': 'duel_vote_weight',
    }[input.action]),
    entitlement_version: safeInt(entitlement.entitlement_version),
    idempotency_key_hash: hash(input.requestId),
    cast_at: now,
  };
}

function lineupLikeMutation({ data, marker, desired, metadata }) {
  const previous = Boolean(marker);
  if (previous === desired) {
    return {
      markerWrite: 'none',
      parentUpdate: null,
      response: { liked: desired, likes_count: safeInt(data.likes_count) },
    };
  }
  const previousWeight = marker ? markerWeight(marker) : 0;
  const nextWeight = desired ? metadata.weight : 0;
  const deltaWeight = nextWeight - previousWeight;
  const deltaPeople = (desired ? 1 : 0) - (previous ? 1 : 0);
  const currentBonus = safeInt(
    data.likes_system_bonus,
    0,
  );
  const currentScore = safeInt(
    data.likes_user_score,
    Math.max(0, safeInt(data.likes_count) - currentBonus),
  );
  const currentPeople = safeInt(data.likes_user_count, currentScore);
  const score = Math.max(0, currentScore + deltaWeight);
  const people = Math.max(0, currentPeople + deltaPeople);
  const likesCount = score + currentBonus;
  return {
    markerWrite: desired ? 'set' : 'delete',
    markerData: desired ? { liked_at: metadata.cast_at, ...metadata } : null,
    parentUpdate: {
      likes_user_count: people,
      likes_user_score: score,
      likes_system_bonus: currentBonus,
      likes_count: likesCount,
      engagement_schema_version: 1,
      engagement_updated_at: metadata.cast_at,
    },
    response: { liked: desired, likes_count: likesCount, weight: nextWeight || previousWeight },
  };
}

function lineupReputationMutation({ data, marker, desired, metadata }) {
  const previous = typeof marker?.vote === 'boolean' ? marker.vote : null;
  if (previous === desired) {
    return {
      markerWrite: 'none',
      parentUpdate: null,
      response: {
        previous_vote: previous,
        current_vote: desired,
        votes_actual: safeInt(data.votes_actual),
        votes_outdated: safeInt(data.votes_outdated),
      },
    };
  }
  const previousWeight = marker ? markerWeight(marker) : 0;
  const nextWeight = desired === null ? 0 : metadata.weight;
  const bonus = safeInt(data.relevance_system_bonus, 0);
  let actualScore = safeInt(
    data.relevance_actual_score,
    Math.max(0, safeInt(data.votes_actual) - bonus),
  );
  let outdatedScore = safeInt(data.relevance_outdated_score, safeInt(data.votes_outdated));
  let actualVoters = safeInt(data.relevance_actual_voters, actualScore);
  let outdatedVoters = safeInt(data.relevance_outdated_voters, outdatedScore);
  if (previous === true) { actualScore -= previousWeight; actualVoters -= 1; }
  if (previous === false) { outdatedScore -= previousWeight; outdatedVoters -= 1; }
  if (desired === true) { actualScore += nextWeight; actualVoters += 1; }
  if (desired === false) { outdatedScore += nextWeight; outdatedVoters += 1; }
  actualScore = Math.max(0, actualScore);
  outdatedScore = Math.max(0, outdatedScore);
  actualVoters = Math.max(0, actualVoters);
  outdatedVoters = Math.max(0, outdatedVoters);
  return {
    markerWrite: desired === null ? 'delete' : 'set',
    markerData: desired === null ? null : {
      vote: desired,
      voted_at: metadata.cast_at,
      ...metadata,
    },
    parentUpdate: {
      relevance_actual_voters: actualVoters,
      relevance_actual_score: actualScore,
      relevance_outdated_voters: outdatedVoters,
      relevance_outdated_score: outdatedScore,
      relevance_system_bonus: bonus,
      votes_actual: actualScore + bonus,
      votes_outdated: outdatedScore,
      engagement_schema_version: 1,
      engagement_updated_at: metadata.cast_at,
    },
    response: {
      previous_vote: previous,
      current_vote: desired,
      votes_actual: actualScore + bonus,
      votes_outdated: outdatedScore,
      weight: nextWeight || previousWeight,
    },
  };
}

function pollVoteMutation({ data, marker, desired, metadata }) {
  const counts = { ...(data.counts && typeof data.counts === 'object' ? data.counts : {}) };
  if (!Object.hasOwn(counts, desired) || !Number.isSafeInteger(counts[desired])) {
    throw httpError(400, 'invalid_option');
  }
  if (marker) {
    const existing = clean(marker.optionId);
    if (existing !== desired) throw httpError(409, 'already_voted');
    return {
      markerWrite: 'none',
      parentUpdate: null,
      response: { option_id: existing, counts, total_votes: safeInt(data.totalVotes) },
    };
  }
  const ballotCounts = {
    ...(data.ballotCounts && typeof data.ballotCounts === 'object' ? data.ballotCounts : {}),
  };
  ballotCounts[desired] = safeInt(ballotCounts[desired], safeInt(counts[desired])) + 1;
  counts[desired] += metadata.weight;
  const totalBallots = safeInt(data.totalBallots, safeInt(data.totalVotes)) + 1;
  const totalVotes = safeInt(data.totalVotes) + metadata.weight;
  return {
    markerWrite: 'set',
    markerData: { optionId: desired, votedAt: metadata.cast_at, ...metadata },
    parentUpdate: {
      counts,
      ballotCounts,
      totalBallots,
      totalVotes,
      updatedAt: metadata.cast_at,
      engagement_schema_version: 1,
    },
    response: { option_id: desired, counts, total_votes: totalVotes, weight: metadata.weight },
  };
}

function duelVoteMutation({ data, marker, desired, metadata }) {
  if (marker) {
    const existing = Number(marker.choice);
    if (existing !== desired) throw httpError(409, 'already_voted');
    return {
      markerWrite: 'none',
      parentUpdate: null,
      response: { choice: existing, votes1: safeInt(data.votes1), votes2: safeInt(data.votes2) },
    };
  }
  const votes1 = safeInt(data.votes1) + (desired === 1 ? metadata.weight : 0);
  const votes2 = safeInt(data.votes2) + (desired === 2 ? metadata.weight : 0);
  const ballots1 = safeInt(data.ballots1, safeInt(data.votes1)) + (desired === 1 ? 1 : 0);
  const ballots2 = safeInt(data.ballots2, safeInt(data.votes2)) + (desired === 2 ? 1 : 0);
  return {
    markerWrite: 'set',
    markerData: { choice: desired, votedAt: metadata.cast_at, ...metadata },
    parentUpdate: {
      votes1,
      votes2,
      ballots1,
      ballots2,
      totalBallots: ballots1 + ballots2,
      engagement_schema_version: 1,
      updatedAt: metadata.cast_at,
    },
    response: { choice: desired, votes1, votes2, weight: metadata.weight },
  };
}

export async function applyEngagementAction({ db, uid, input, now = new Date() }) {
  const { bodyHash, receiptId } = requestIdentity(uid, input);
  const receiptRef = db.collection('engagement_requests').doc(receiptId);
  const entitlementRef = db.collection('account_entitlements').doc(uid);
  const settingsRef = db.collection('settings').doc('category_access');
  const userRef = db.collection('users').doc(uid);
  const parentRef = input.action.startsWith('lineup-')
    ? db.collection('lineups').doc(input.targetId)
    : input.action === 'poll-vote'
      ? db.collection('polls').doc(input.targetId)
      : db.collection('duels').doc(input.targetId);
  const markerRef = input.action === 'lineup-like'
    ? db.collection('lineup_likes').doc(input.targetId).collection('users').doc(uid)
    : input.action === 'lineup-reputation'
      ? parentRef.collection('votes').doc(uid)
      : input.action === 'poll-vote'
        ? parentRef.collection('votes').doc(uid)
        : parentRef.collection('voters').doc(uid);

  return db.runTransaction(async tx => {
    const reads = [tx.get(receiptRef), tx.get(entitlementRef), tx.get(parentRef), tx.get(markerRef)];
    if (input.action === 'poll-vote') reads.push(tx.get(settingsRef), tx.get(userRef));
    const [receiptSnap, entitlementSnap, parentSnap, markerSnap, settingsSnap, userSnap] = await Promise.all(reads);
    if (receiptSnap.exists) {
      const receipt = receiptSnap.data() || {};
      if (receipt.uid !== uid || receipt.body_hash !== bodyHash) throw httpError(409, 'request_id_reused');
      return receipt.response;
    }
    if (!parentSnap.exists) throw httpError(404, 'unavailable');
    const data = parentSnap.data() || {};
    if (input.action === 'poll-vote') {
      if (settingsSnap?.data()?.polls_enabled !== true) throw httpError(403, 'polls_disabled');
      if (data.audience === 'admins' && userSnap?.data()?.role !== 'admin') {
        throw httpError(403, 'forbidden');
      }
      if (data.status !== 'active' || (timestampMillis(data.endsAt) > 0 && timestampMillis(data.endsAt) <= now.getTime())) {
        throw httpError(409, 'finished');
      }
    }
    if (input.action === 'duel-vote') {
      if (data.status !== 'active' || timestampMillis(data.endsAt) <= now.getTime()) {
        throw httpError(409, 'finished');
      }
    }
    const entitlement = normalizeEntitlement(
      entitlementSnap.exists ? entitlementSnap.data() : null,
      { now },
    );
    const metadata = markerMetadata(uid, input, entitlement, Timestamp.fromDate(now));
    const args = {
      data,
      marker: markerSnap.exists ? markerSnap.data() : null,
      desired: input.desired,
      metadata,
    };
    const mutation = {
      'lineup-like': lineupLikeMutation,
      'lineup-reputation': lineupReputationMutation,
      'poll-vote': pollVoteMutation,
      'duel-vote': duelVoteMutation,
    }[input.action](args);
    if (mutation.markerWrite === 'set') tx.set(markerRef, mutation.markerData);
    if (mutation.markerWrite === 'delete') tx.delete(markerRef);
    if (mutation.parentUpdate) tx.update(parentRef, mutation.parentUpdate);
    const response = { ...mutation.response, action: input.action };
    tx.create(receiptRef, {
      uid,
      action: input.action,
      target_id: input.targetId,
      body_hash: bodyHash,
      response,
      created_at: metadata.cast_at,
      expires_at: Timestamp.fromMillis(now.getTime() + RECEIPT_TTL_MS),
    });
    return response;
  });
}

export function createEngagementHandler({
  verifyIdToken = token => adminAuth().verifyIdToken(token, true),
  db = null,
  preAuthCheck = req => preAuthLimiter(requestIp(req)),
  rateCheck = checkUidRate,
  now = () => new Date(),
  authTimeoutMs = AUTH_TIMEOUT_MS,
} = {}) {
  return async function engagementHandler(req, res) {
    setHeaders(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (rejectForeignOrigin(req)) return res.status(403).json({ error: 'origin_not_allowed' });
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
    let releasePreAuth = () => {};
    try {
      const release = preAuthCheck(req);
      if (typeof release === 'function') releasePreAuth = release;
      const decoded = await authorize(req, verifyIdToken, authTimeoutMs);
      rateCheck(decoded.uid);
      const input = parsedAction(req.params?.action, req.body);
      const result = await applyEngagementAction({
        db: db ?? adminFirestore(),
        uid: decoded.uid,
        input,
        now: now(),
      });
      return res.status(200).json(result);
    } catch (error) {
      const status = Number(error.status) || (String(error.code || '').startsWith('auth/') ? 401 : 500);
      if (status >= 500) console.error('engagement error:', error);
      if (status === 429) res.setHeader('Retry-After', '60');
      return res.status(status).json({ error: status >= 500 ? 'internal_server_error' : error.message });
    } finally {
      releasePreAuth();
    }
  };
}

export const engagementInternals = Object.freeze({
  parsedAction,
  lineupLikeMutation,
  lineupReputationMutation,
  pollVoteMutation,
  duelVoteMutation,
});

export default createEngagementHandler();
