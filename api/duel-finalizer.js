import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';

function adminDb() {
  if (!getApps().length) {
    const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || '').replace(/^\uFEFF/, '').trim();
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not configured');
    initializeApp({ credential: cert(JSON.parse(raw)) });
  }
  return getFirestore();
}

function authorUid(lineup = {}) {
  return String(lineup.user_id || lineup.uid || lineup.author_uid || lineup.submitted_by_uid || '').trim();
}

async function sendWinnerPush(outcome) {
  if (!outcome?.uid || outcome.alreadyFinalized || outcome.tie) return;
  const appId = String(process.env.ONESIGNAL_APP_ID || '').trim();
  const restKey = String(process.env.ONESIGNAL_REST_KEY || '').trim();
  if (!appId || !restKey) return;
  const title = '⚔️ Победа в дуэли!';
  const body = `Твой лайнап победил. Начислено +5 очков и +${outcome.likesAwarded} лайков.`;
  const response = await fetch('https://api.onesignal.com/notifications', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Key ${restKey}` },
    body: JSON.stringify({
      app_id: appId,
      headings: { ru: title, en: title },
      contents: { ru: body, en: body },
      include_aliases: { external_id: [outcome.uid] },
      target_channel: 'push',
      data: { type: 'duel_win', duel_id: outcome.duelId, lineup_id: outcome.winnerId },
      priority: 10,
    }),
  });
  if (!response.ok) throw new Error(`onesignal_${response.status}`);
}

export async function finalizeDuelById(duelId, { forcedWinnerId = '' } = {}) {
  const db = adminDb();
  const duelRef = db.collection('duels').doc(duelId);
  let outcome;
  await db.runTransaction(async tx => {
    const duelSnap = await tx.get(duelRef);
    if (!duelSnap.exists) throw new Error('duel_not_found');
    const duel = duelSnap.data();
    if (duel.finalized === true) { outcome = { alreadyFinalized: true, ...duel }; return; }
    const v1 = Number(duel.votes1 || 0), v2 = Number(duel.votes2 || 0);
    let winnerId = forcedWinnerId;
    if (!winnerId) {
      if (v1 === v2) { outcome = { tie: true, duelId }; return; }
      winnerId = v1 > v2 ? duel.lineup1Id : duel.lineup2Id;
    }
    if (![duel.lineup1Id, duel.lineup2Id].includes(winnerId)) throw new Error('invalid_winner');
    const loserId = winnerId === duel.lineup1Id ? duel.lineup2Id : duel.lineup1Id;
    const winnerVotes = winnerId === duel.lineup1Id ? v1 : v2;
    const likesAwarded = Math.min(100, Math.max(0, winnerVotes));
    const winnerRef = db.collection('lineups').doc(winnerId);
    const loserRef = db.collection('lineups').doc(loserId);
    const winnerSnap = await tx.get(winnerRef), loserSnap = await tx.get(loserRef);
    if (!winnerSnap.exists || !loserSnap.exists) throw new Error('lineup_not_found');
    const winner = winnerSnap.data();
    const uid = authorUid(winner);
    tx.update(winnerRef, { status: 'approved', likes_count: FieldValue.increment(likesAwarded), votes_actual: FieldValue.increment(5), duel_wins: FieldValue.increment(1), last_duel_id: duelId, updated_at: FieldValue.serverTimestamp() });
    tx.update(loserRef, { status: 'archived', archived_reason: 'duel_loss', lost_duel_id: duelId, updated_at: FieldValue.serverTimestamp() });
    if (uid) tx.set(db.collection('users').doc(uid), { bonus_lineups: FieldValue.increment(5), total_likes: FieldValue.increment(likesAwarded), duel_wins: FieldValue.increment(1), last_duel_reward: 5, last_duel_reward_at: FieldValue.serverTimestamp(), last_duel_id: duelId }, { merge: true });
    tx.update(duelRef, { status: 'finished', finalized: true, winnerLineupId: winnerId, loserLineupId: loserId, winnerAuthorUid: uid, likesAwarded, pointsAwarded: uid ? 5 : 0, finalizedAt: FieldValue.serverTimestamp(), visible: true });
    const announcementRef = db.collection('duel_announcements').doc(duelId);
    tx.set(announcementRef, { duel_id: duelId, lineup_id: winnerId, title: `Победил лайнап «${winner.title || winnerId}»!`, created_at: FieldValue.serverTimestamp(), visible: true });
    if (uid) {
      const notificationRef = db.collection('users').doc(uid).collection('notifications').doc();
      tx.set(notificationRef, { type: 'duel_win', title: '⚔️ Победа в дуэли!', body: `Твой лайнап «${winner.title || winnerId}» победил. Начислено +5 очков.`, lineup_id: winnerId, duel_id: duelId, points: 5, likes: likesAwarded, read: false, created_at: FieldValue.serverTimestamp() });
    }
    outcome = { duelId, winnerId, loserId, uid, likesAwarded };
  });
  try { await sendWinnerPush(outcome); } catch (error) {
    console.error('Duel winner push failed:', error);
  }
  return outcome;
}

export async function finalizeExpiredDuels({ limit = 10 } = {}) {
  const db = adminDb();
  const snap = await db.collection('duels').where('status', '==', 'active').where('endsAt', '<=', Timestamp.now()).orderBy('endsAt').limit(limit).get();
  const results = [];
  for (const doc of snap.docs) results.push(await finalizeDuelById(doc.id));
  return results;
}
