import { createHash } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';

import { adminAuth, adminFirestore } from './_lib/firebase-admin.js';

export const ACCOUNT_DELETION_GRACE_MS = 10 * 60_000;

const clean = value => String(value ?? '').trim();
const sha256 = value => createHash('sha256').update(clean(value)).digest('hex');

export function evaluateDeletionRisk({ decoded, userRecord, appCheckVerified, priorRequests = 0, now }) {
  const reasons = [];
  let score = 0;
  const authAge = Math.floor(now.getTime() / 1000) - Number(decoded.auth_time || 0);
  if (!appCheckVerified) { score += 35; reasons.push('app_check_unverified'); }
  if (!decoded.firebase?.sign_in_provider) { score += 40; reasons.push('provider_missing'); }
  if (authAge > 5 * 60) { score += 20; reasons.push('reauth_older_than_5m'); }
  const createdAt = Date.parse(userRecord?.metadata?.creationTime || '');
  if (Number.isFinite(createdAt) && now.getTime() - createdAt < 24 * 60 * 60_000) {
    score += 15; reasons.push('account_younger_than_24h');
  }
  if (priorRequests > 0) { score += 25; reasons.push('repeated_deletion_request'); }
  return { score, reasons, suspicious:score >= 50 };
}

export async function verifyDeletionAppCheck(appCheck, token) {
  if (!token || !appCheck) return false;
  try { await appCheck.verifyToken(token); return true; } catch { return false; }
}

export function deletionRequestFingerprint(req, pepper) {
  const forwarded = clean(req.headers?.['x-forwarded-for']).split(',')[0].trim();
  const ip = forwarded || clean(req.ip || req.socket?.remoteAddress) || 'unknown';
  return {
    ip_hash:sha256(`${pepper}:${ip}`),
    user_agent_hash:sha256(req.headers?.['user-agent']),
  };
}

async function telegramSecurityReport(env, request) {
  const token = clean(env.TELEGRAM_BOT_TOKEN);
  const chatId = clean(env.TELEGRAM_ALERT_CHAT_ID);
  if (!token || !chatId) throw new Error('telegram_alerts_not_configured');
  const text = [
    '⚠️ VLineups: подозрительное удаление аккаунта', '',
    `Request ID: ${request.id}`, `Risk score: ${request.risk_score}`,
    `Signals: ${(request.risk_reasons || []).join(', ') || 'none'}`,
    `IP fingerprint: ${clean(request.ip_hash).slice(0, 12)}`, '',
    'Аккаунт заблокирован и помещён в карантин. Данные не удалены.',
  ].join('\n');
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:'POST', headers:{ 'Content-Type':'application/json' },
    body:JSON.stringify({ chat_id:chatId, text }), signal:AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`telegram_send_failed:${response.status}`);
}

export async function finalizeDueAccountDeletions({
  db = adminFirestore(), auth = adminAuth(), now = new Date(), env = process.env,
  deleteAccountData, reporter = telegramSecurityReport,
} = {}) {
  if (typeof deleteAccountData !== 'function') throw new Error('delete_account_data_required');
  const snapshot = await db.collection('account_deletion_requests')
    .where('status', '==', 'scheduled').where('execute_after', '<=', Timestamp.fromDate(now))
    .limit(25).get();
  const results = [];
  for (const document of snapshot.docs) {
    const request = { id:document.id, ...document.data() };
    try {
      if (request.suspicious) {
        await auth.updateUser(request.uid, { disabled:true });
        await document.ref.set({ status:'quarantined', quarantined_at:Timestamp.fromDate(now) }, { merge:true });
        try {
          await reporter(env, request);
          await document.ref.set({ report_sent_at:Timestamp.fromDate(now) }, { merge:true });
        } catch (error) {
          await document.ref.set({ report_error:clean(error.message).slice(0, 160) }, { merge:true });
        }
        results.push({ id:document.id, status:'quarantined' });
      } else {
        const lineups = await deleteAccountData({
          db, auth, uid:request.uid, subjectId:request.subject_id, now,
        });
        await document.ref.set({ status:'completed', completed_at:Timestamp.fromDate(now), ...lineups }, { merge:true });
        results.push({ id:document.id, status:'completed' });
      }
    } catch (error) {
      await document.ref.set({
        last_error:clean(error.message).slice(0, 160), last_attempt_at:Timestamp.fromDate(now),
      }, { merge:true });
      results.push({ id:document.id, status:'error' });
    }
  }
  return results;
}
