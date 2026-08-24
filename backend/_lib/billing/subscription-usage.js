import { FieldValue, Timestamp } from 'firebase-admin/firestore';

const EVENT_TYPES = new Set([
  'site_lineups_opened',
  'site_lineup_video_opened',
  'sponsor_lineup_like',
  'sponsor_lineup_relevance',
  'sponsor_poll_vote',
  'sponsor_duel_vote',
]);

const EVENT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

function clean(value, limit = 160) {
  return String(value ?? '').trim().slice(0, limit);
}

function safeKey(value) {
  return clean(value, 80).replace(/[^a-z0-9_-]/gi, '_');
}

export function queueSubscriptionUsage(tx, {
  db,
  uid,
  entitlement = {},
  eventType,
  eventId,
  targetId = '',
  occurredAt = new Date(),
}) {
  if (!EVENT_TYPES.has(eventType)) return false;
  const planId = clean(entitlement.plan_id, 40).toLowerCase();
  const orderId = clean(entitlement.latest_order_id, 40);
  if (!uid || !orderId || !['ad_free', 'plus', 'sponsor'].includes(planId)) return false;
  const at = occurredAt instanceof Date ? occurredAt : new Date(occurredAt);
  const timestamp = Timestamp.fromDate(Number.isFinite(at.getTime()) ? at : new Date());
  const id = `${safeKey(uid)}__${safeKey(orderId)}__${safeKey(eventId)}`.slice(0, 500);
  const eventRef = db.collection('subscription_usage_events').doc(id);
  const summaryRef = db.collection('subscription_usage_summaries').doc(`${safeKey(uid)}__${safeKey(orderId)}`);
  tx.create(eventRef, {
    uid,
    order_id:orderId,
    plan_id:planId,
    event_type:eventType,
    target_id:clean(targetId, 160),
    occurred_at:timestamp,
    expires_at:Timestamp.fromMillis(timestamp.toMillis() + EVENT_RETENTION_MS),
    source:'server',
  });
  tx.set(summaryRef, {
    uid,
    order_id:orderId,
    plan_id:planId,
    total_events:FieldValue.increment(1),
    event_counts:{ [eventType]:FieldValue.increment(1) },
    last_used_at:timestamp,
    updated_at:timestamp,
  }, { merge:true });
  return true;
}

export async function recordSubscriptionUsage(db, input) {
  try {
    await db.runTransaction(async tx => queueSubscriptionUsage(tx, { db, ...input }));
    return true;
  } catch (error) {
    if (Number(error?.code) === 6 || String(error?.message || '').includes('ALREADY_EXISTS')) return true;
    console.error('subscription usage write failed:', error);
    return false;
  }
}
