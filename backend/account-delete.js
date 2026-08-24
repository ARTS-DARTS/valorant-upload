import { createHmac } from 'node:crypto';

import { FieldValue, Timestamp } from 'firebase-admin/firestore';

import { adminApp, adminAuth, adminFirestore } from './_lib/firebase-admin.js';
import {
  ACCOUNT_DELETION_GRACE_MS,
  deletionRequestFingerprint,
  evaluateDeletionRisk,
  verifyDeletionAppCheck,
} from './account-deletion-workflow.js';

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function bearerToken(req) {
  const header = String(req.headers?.authorization || '');
  if (!header.startsWith('Bearer ')) throw fail(401, 'authentication_required');
  return header.slice(7);
}

export function deletedSubjectId(uid, pepper) {
  if (typeof pepper !== 'string' || pepper.length < 32) {
    throw fail(503, 'account_deletion_unavailable');
  }
  return createHmac('sha256', pepper).update(uid).digest('hex');
}

async function processAuthoredLineups(db, uid, subjectId) {
  let cursor = null;
  let removed = 0;
  let anonymized = 0;
  do {
    let query = db.collection('lineups')
      .where('user_id', '==', uid)
      .orderBy('__name__')
      .limit(200);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    if (snapshot.empty) break;
    const batch = db.batch();
    for (const document of snapshot.docs) {
      const data = document.data() || {};
      if (data.status === 'approved' || data.status === 'archived') {
        batch.update(document.ref, {
          user_id: `deleted_${subjectId.slice(0, 24)}`,
          submitted_by: 'Удалённый автор',
          author_deleted: true,
          author_deleted_at: FieldValue.serverTimestamp(),
        });
        anonymized += 1;
      } else {
        batch.delete(document.ref);
        removed += 1;
      }
    }
    await batch.commit();
    cursor = snapshot.docs.at(-1);
    if (snapshot.size < 200) break;
  } while (true);
  return { removed, anonymized };
}

export async function deleteAccountData({
  db,
  auth,
  uid,
  subjectId,
  now,
}) {
  const userRef = db.collection('users').doc(uid);
  const customerRef = db.collection('billing_customers').doc(uid);
  const [userSnap, customerSnap] = await Promise.all([userRef.get(), customerRef.get()]);
  const profile = userSnap.exists ? (userSnap.data() || {}) : {};
  const customer = customerSnap.exists ? (customerSnap.data() || {}) : {};
  const lineups = await processAuthoredLineups(db, uid, subjectId);

  if (customer.open_order_id) {
    const orderRef = db.collection('billing_orders').doc(String(customer.open_order_id));
    const orderSnap = await orderRef.get();
    if (orderSnap.exists && orderSnap.data()?.status === 'pending') {
      await orderRef.update({
        status:'requires_review',
        review_reason:'account_deleted_before_settlement',
        updated_at:FieldValue.serverTimestamp(),
      });
    }
  }

  if (customerSnap.exists) {
    await customerRef.set({
      uid:FieldValue.delete(),
      email:FieldValue.delete(),
      user_email:FieldValue.delete(),
      yandex_id:FieldValue.delete(),
      display_name:FieldValue.delete(),
      deleted_subject_id:subjectId,
      account_deleted_at:FieldValue.serverTimestamp(),
      open_order_id:null,
      open_order_expires_at:null,
      updated_at:FieldValue.serverTimestamp(),
    }, { merge:true });
  }

  const directRoots = [
    'notifications', 'user_private', 'user_stats', 'user_auth_links',
  ];
  for (const collection of directRoots) {
    await db.recursiveDelete(db.collection(collection).doc(uid));
  }
  const batch = db.batch();
  for (const collection of [
    'account_entitlements', 'user_public_perks', 'user_badges', 'rate_limits',
  ]) {
    batch.delete(db.collection(collection).doc(uid));
  }
  const nameLower = String(profile.name_lower || '').trim();
  if (nameLower) batch.delete(db.collection('usernames').doc(nameLower));
  batch.set(db.collection('deleted_accounts').doc(subjectId), {
    deleted_at:FieldValue.serverTimestamp(),
    created_at:profile.created_at || null,
    reason:'Удалён пользователем',
    source:'server_self_service',
    authored_lineups_removed:lineups.removed,
    authored_lineups_anonymized:lineups.anonymized,
    financial_history_retained_pseudonymously:true,
    completed_at_iso:now.toISOString(),
  });
  await batch.commit();
  await db.recursiveDelete(userRef);
  await auth.deleteUser(uid);
  return lineups;
}

export function createAccountDeleteHandler({
  db = null,
  auth = null,
  appCheck = null,
  now = () => new Date(),
  pepper = process.env.ACCOUNT_DELETION_PEPPER,
} = {}) {
  return async function accountDeleteHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ error:'method_not_allowed' });
    try {
      const authService = auth ?? adminAuth();
      const decoded = await authService.verifyIdToken(bearerToken(req), true);
      const firestore = db ?? adminFirestore();
      const requestRef = firestore.collection('account_deletion_requests').doc(decoded.uid);
      if (req.body?.action === 'cancel') {
        const pending = await requestRef.get();
        if (!pending.exists || pending.data()?.status !== 'scheduled') {
          throw fail(409, 'deletion_not_cancellable');
        }
        await requestRef.set({ status:'cancelled', cancelled_at:FieldValue.serverTimestamp() }, { merge:true });
        return res.status(200).json({ cancelled:true });
      }
      if (req.body?.confirm !== true) throw fail(400, 'confirmation_required');
      const currentSeconds = Math.floor(now().getTime() / 1000);
      if (!Number.isFinite(decoded.auth_time) || currentSeconds - decoded.auth_time > 10 * 60) {
        throw fail(401, 'recent_sign_in_required');
      }
      const pending = await requestRef.get();
      if (pending.exists && pending.data()?.status === 'scheduled') {
        return res.status(200).json({
          scheduled:true, execute_after:pending.data().execute_after.toDate().toISOString(),
        });
      }
      const serverNow = now();
      const userRecord = await authService.getUser(decoded.uid);
      const appCheckVerified = await verifyDeletionAppCheck(
        appCheck ?? adminApp().appCheck(), req.headers?.['x-firebase-appcheck'],
      );
      const risk = evaluateDeletionRisk({
        decoded, userRecord, appCheckVerified,
        priorRequests:Number(pending.data()?.request_count || 0), now:serverNow,
      });
      const executeAfter = new Date(serverNow.getTime() + ACCOUNT_DELETION_GRACE_MS);
      await requestRef.set({
        uid:decoded.uid, subject_id:deletedSubjectId(decoded.uid, pepper), status:'scheduled',
        requested_at:Timestamp.fromDate(serverNow), execute_after:Timestamp.fromDate(executeAfter),
        risk_score:risk.score, risk_reasons:risk.reasons, suspicious:risk.suspicious,
        app_check_verified:appCheckVerified,
        ...deletionRequestFingerprint(req, pepper),
        request_count:Number(pending.data()?.request_count || 0) + 1,
      });
      return res.status(202).json({ scheduled:true, execute_after:executeAfter.toISOString() });
    } catch (error) {
      const status = Number(error.status) || (String(error.code || '').startsWith('auth/') ? 401 : 500);
      if (status >= 500) console.error('account-delete error:', error);
      return res.status(status).json({
        error:status >= 500 ? 'account_deletion_unavailable' : error.message,
      });
    }
  };
}

export default createAccountDeleteHandler();
