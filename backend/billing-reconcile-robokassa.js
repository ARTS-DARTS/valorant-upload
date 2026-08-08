import { timingSafeEqual } from 'node:crypto';

import { Timestamp } from 'firebase-admin/firestore';

import { adminFirestore } from './_lib/firebase-admin.js';
import {
  fetchRobokassaOpState,
  loadRobokassaConfig,
} from './_lib/billing/robokassa.js';
import {
  applyRobokassaPayment,
  applyRobokassaPendingFailure,
  applyRobokassaReversal,
} from './billing-webhook-robokassa.js';

function fail(status, code) { return Object.assign(new Error(code), { status }); }
function clean(value) { return String(value ?? '').trim(); }

function loadReconciliationToken(env = process.env) {
  const value = clean(env.BILLING_RECONCILIATION_TOKEN);
  if (value.length < 32 || value.length > 512) throw fail(503, 'reconciliation_not_configured');
  return value;
}

function authorized(header, expected) {
  const supplied = clean(header);
  if (!supplied.startsWith('Bearer ')) return false;
  const left = Buffer.from(supplied.slice(7).trim(), 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function reconcileRobokassaOrder({
  db,
  order,
  provider,
  providerState,
  now,
}) {
  const invoiceId = String(order.provider_invoice_id ?? '');
  if (
    order.provider !== 'robokassa' ||
    !/^\d{1,19}$/.test(invoiceId) ||
    order.test_mode !== false
  ) {
    return { invoiceId, action: 'skipped' };
  }
  if (providerState.result_code !== 0) {
    const createdMillis = typeof order.created_at?.toMillis === 'function'
      ? order.created_at.toMillis()
      : new Date(order.created_at || 0).getTime();
    if (
      order.status === 'pending' &&
      Number.isFinite(createdMillis) &&
      now.getTime() - createdMillis >= 60 * 60_000
    ) {
      await db.collection('billing_orders').doc(invoiceId).set({
        status:'expired',
        expired_at:Timestamp.fromDate(now),
        updated_at:Timestamp.fromDate(now),
        expiration_reason:'provider_invoice_missing',
        provider_result_code:providerState.result_code,
      }, { merge:true });
      return { invoiceId, action:'expired', resultCode:providerState.result_code };
    }
    return { invoiceId, action: 'provider_result', resultCode: providerState.result_code };
  }
  if (
    providerState.shp?.Shp_order !== invoiceId ||
    providerState.amount_minor !== order.amount_minor
  ) {
    return { invoiceId, action: 'mismatch' };
  }
  if (providerState.state_code === 100 && order.status === 'pending') {
    const applied = await applyRobokassaPayment({
      db,
      provider,
      now,
      verified: {
        invoice_id: invoiceId,
        amount_minor: providerState.amount_minor,
        out_sum: providerState.out_sum,
        shp: providerState.shp,
        payment_method: providerState.payment_method,
        op_key: providerState.op_key,
      },
    });
    return { invoiceId, action: applied.requiresReview ? 'requires_review' : 'paid' };
  }
  if ([10, 60].includes(providerState.state_code) && order.status === 'pending') {
    await applyRobokassaPendingFailure({
      db, invoiceId, providerState: providerState.state_code, now,
    });
    return { invoiceId, action: 'failed' };
  }
  if (providerState.state_code === 60 && order.status === 'succeeded') {
    await applyRobokassaReversal({ db, invoiceId, providerState: 60, now });
    return { invoiceId, action: 'reversed' };
  }
  if (providerState.state_code === 100 && order.status === 'succeeded') {
    return { invoiceId, action: 'confirmed' };
  }
  return { invoiceId, action: 'pending', stateCode: providerState.state_code };
}

async function candidateOrders(db, perStatusLimit = 25) {
  const values = [];
  for (const status of ['pending', 'succeeded']) {
    const snapshot = await db.collection('billing_orders')
      .where('status', '==', status)
      .limit(perStatusLimit)
      .get();
    for (const doc of snapshot.docs) {
      const data = doc.data() || {};
      if (data.provider === 'robokassa' && data.test_mode === false) {
        values.push({ ...data, ref: doc.ref });
      }
    }
  }
  return values;
}

export function createRobokassaReconciliationHandler({
  db = null,
  loadProvider = loadRobokassaConfig,
  loadToken = loadReconciliationToken,
  fetchState = fetchRobokassaOpState,
  now = () => new Date(),
} = {}) {
  return async function robokassaReconciliationHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
    try {
      const token = loadToken();
      if (!authorized(req.headers.authorization, token)) {
        return res.status(401).json({ error: 'authentication_required' });
      }
      const provider = loadProvider();
      if (provider.testMode) throw fail(503, 'reconciliation_unavailable_in_test_mode');
      const firestore = db ?? adminFirestore();
      const serverNow = now();
      const results = [];
      for (const order of await candidateOrders(firestore)) {
        try {
          const providerState = await fetchState({
            config: provider,
            invoiceId: order.provider_invoice_id,
          });
          const result = await reconcileRobokassaOrder({
            db: firestore, order, provider, providerState, now: serverNow,
          });
          results.push(result);
          await order.ref.set({
            last_reconciled_at: Timestamp.fromDate(serverNow),
            last_reconcile_action: result.action,
          }, { merge: true });
        } catch (error) {
          console.error('robokassa order reconciliation error:', order.provider_invoice_id, error);
          results.push({ invoiceId: String(order.provider_invoice_id), action: 'error' });
        }
      }
      return res.status(200).json({
        ok: true,
        checked: results.length,
        actions: results.reduce((counts, item) => {
          counts[item.action] = (counts[item.action] || 0) + 1;
          return counts;
        }, {}),
      });
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error('robokassa reconciliation error:', error);
      return res.status(status).json({
        error: status >= 500 ? 'reconciliation_unavailable' : error.message,
      });
    }
  };
}

export default createRobokassaReconciliationHandler();
