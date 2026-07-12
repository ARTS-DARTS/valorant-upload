import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { Timestamp, getFirestore } from 'firebase-admin/firestore';

loadEnv({ path: '.env.local', override: false });
loadEnv({ path: '.env', override: false });

const serviceAccountJson = String(process.env.FIREBASE_SERVICE_ACCOUNT || '')
  .replace(/^\uFEFF/, '')
  .trim();

if (!serviceAccountJson) {
  console.error('DUEL E2E SKIPPED: FIREBASE_SERVICE_ACCOUNT is not configured locally.');
  process.exitCode = 2;
} else {
  await run();
}

async function run() {
  if (!getApps().length) {
    initializeApp({ credential: cert(JSON.parse(serviceAccountJson)) });
  }

  // The fake uid prevents a real user from receiving a test notification. Push is
  // disabled explicitly so a developer's local OneSignal env cannot leak into E2E.
  delete process.env.ONESIGNAL_APP_ID;
  delete process.env.ONESIGNAL_REST_KEY;

  const { finalizeDuelById } = await import('../api/duel-finalizer.js');
  const db = getFirestore();
  const suffix = `${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const prefix = `__codex_duel_e2e_${suffix}`;
  const winnerId = `${prefix}_winner`;
  const loserId = `${prefix}_loser`;
  const duelId = `${prefix}_duel`;
  const uid = `${prefix}_user`;

  const winnerRef = db.collection('lineups').doc(winnerId);
  const loserRef = db.collection('lineups').doc(loserId);
  const duelRef = db.collection('duels').doc(duelId);
  const userRef = db.collection('users').doc(uid);
  const announcementRef = db.collection('duel_announcements').doc(duelId);
  const inboxRef = db.collection('notifications').doc(uid);

  try {
    const seed = db.batch();
    seed.set(winnerRef, {
      title: 'E2E winner',
      status: 'approved',
      user_id: uid,
      likes_count: 7,
      votes_actual: 2,
      duel_wins: 0,
    });
    seed.set(loserRef, {
      title: 'E2E loser',
      status: 'approved',
      likes_count: 13,
      votes_actual: 8,
    });
    seed.set(userRef, {
      bonus_lineups: 4,
      total_likes: 11,
      duel_wins: 0,
    });
    seed.set(duelRef, {
      status: 'active',
      finalized: false,
      lineup1Id: winnerId,
      lineup2Id: loserId,
      votes1: 137,
      votes2: 3,
      endsAt: Timestamp.fromMillis(Date.now() - 60_000),
    });
    await seed.commit();

    const outcome = await finalizeDuelById(duelId);
    assert.equal(outcome.duelId, duelId);
    assert.equal(outcome.winnerId, winnerId);
    assert.equal(outcome.loserId, loserId);
    assert.equal(outcome.uid, uid);
    assert.equal(outcome.likesAwarded, 100, 'winner vote conversion must cap at 100 likes');

    const [winnerSnap, loserSnap, userSnap, duelSnap, announcementSnap, notificationsSnap, inboxSnap] =
      await Promise.all([
        winnerRef.get(),
        loserRef.get(),
        userRef.get(),
        duelRef.get(),
        announcementRef.get(),
        userRef.collection('notifications').get(),
        inboxRef.collection('items').get(),
      ]);

    assert.equal(winnerSnap.get('status'), 'approved');
    assert.equal(winnerSnap.get('likes_count'), 107, '137 votes must award exactly 100 likes');
    assert.equal(winnerSnap.get('votes_actual'), 7, 'winner must receive +5 relevance');
    assert.equal(winnerSnap.get('duel_wins'), 1);
    assert.equal(loserSnap.get('status'), 'archived');
    assert.equal(loserSnap.get('likes_count'), 13, 'loser likes must remain unchanged');
    assert.equal(loserSnap.get('votes_actual'), 8, 'loser relevance must remain unchanged');
    assert.equal(userSnap.get('bonus_lineups'), 9, 'winner author must receive +5 points');
    assert.equal(userSnap.get('total_likes'), 111);
    assert.equal(userSnap.get('duel_wins'), 1);
    assert.equal(duelSnap.get('status'), 'finished');
    assert.equal(duelSnap.get('finalized'), true);
    assert.equal(duelSnap.get('winnerLineupId'), winnerId);
    assert.equal(duelSnap.get('loserLineupId'), loserId);
    assert.equal(duelSnap.get('likesAwarded'), 100);
    assert.equal(duelSnap.get('pointsAwarded'), 5);
    assert.equal(announcementSnap.exists, true);
    assert.equal(announcementSnap.get('title'), 'Победил лайнап «E2E winner»!');
    assert.equal(notificationsSnap.size, 1, 'exactly one reward notification must be created');
    assert.equal(notificationsSnap.docs[0].get('type'), 'duel_win');
    assert.equal(notificationsSnap.docs[0].get('points'), 5);
    assert.equal(notificationsSnap.docs[0].get('likes'), 100);
    assert.equal(inboxSnap.size, 1, 'profile inbox must receive the reward notification');
    assert.equal(inboxSnap.docs[0].get('is_read'), false);

    const secondOutcome = await finalizeDuelById(duelId);
    assert.equal(secondOutcome.alreadyFinalized, true);

    const [winnerAfterSecond, userAfterSecond, notificationsAfterSecond, inboxAfterSecond] = await Promise.all([
      winnerRef.get(),
      userRef.get(),
      userRef.collection('notifications').get(),
      inboxRef.collection('items').get(),
    ]);
    assert.equal(winnerAfterSecond.get('likes_count'), 107, 'idempotent retry must not add likes');
    assert.equal(winnerAfterSecond.get('votes_actual'), 7, 'idempotent retry must not add relevance');
    assert.equal(userAfterSecond.get('bonus_lineups'), 9, 'idempotent retry must not add points');
    assert.equal(notificationsAfterSecond.size, 1, 'idempotent retry must not add notifications');
    assert.equal(inboxAfterSecond.size, 1, 'idempotent retry must not duplicate profile inbox items');

    console.log(`DUEL E2E PASSED: ${duelId}`);
  } finally {
    const notifications = await userRef.collection('notifications').get();
    const inboxItems = await inboxRef.collection('items').get();
    const cleanup = db.batch();
    for (const notification of notifications.docs) cleanup.delete(notification.ref);
    for (const item of inboxItems.docs) cleanup.delete(item.ref);
    cleanup.delete(announcementRef);
    cleanup.delete(duelRef);
    cleanup.delete(winnerRef);
    cleanup.delete(loserRef);
    cleanup.delete(userRef);
    cleanup.delete(inboxRef);
    await cleanup.commit();
    console.log(`DUEL E2E CLEANUP COMPLETE: ${prefix}`);
  }
}
