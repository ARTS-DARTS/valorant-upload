import { FieldValue } from 'firebase-admin/firestore';
import { adminFirestore } from './_lib/firebase-admin.js';
import { adminRequestError, requireAdminRequest } from './_lib/admin-auth.js';

const limits = new Map();
const HOUR_MS = 60 * 60 * 1000;
const VALID_STATUSES = new Set(['new', 'in_progress', 'closed']);

function text(value, maxLength) {
  return String(value ?? '').trim().replace(/\r\n?/g, '\n').slice(0, maxLength);
}

function telegramHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export async function sendPartnerInquiryTelegram(input, {
  token = process.env.TELEGRAM_BOT_TOKEN,
  chatId = process.env.TELEGRAM_ALERT_CHAT_ID,
  fetchImpl = fetch,
} = {}) {
  if (!text(token, 300) || !text(chatId, 100)) return { sent:false, reason:'not_configured' };
  const line = (label, value) => value ? `<b>${label}:</b> ${telegramHtml(value)}` : '';
  const message = [
    '<b>📨 Новое рекламное предложение VLineups</b>',
    line('Имя', input.name), line('Компания', input.company), line('Контакт', input.contact),
    line('Продукт', input.website), line('Бюджет', input.budget), line('Сроки', input.timeline),
    '', '<b>Что хотят продвигать:</b>', telegramHtml(text(input.message, 2600)),
  ].filter((value, index, values) => value || (index > 0 && values[index - 1])).join('\n');
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ chat_id:chatId, text:message, parse_mode:'HTML', disable_web_page_preview:true }),
  });
  if (!response.ok) throw new Error(`telegram_send_failed:${response.status}`);
  return { sent:true };
}

export function normalizePartnerInquiry(body = {}) {
  return {
    name: text(body.name, 80),
    company: text(body.company, 120),
    contact: text(body.contact, 160),
    website: text(body.website, 300),
    message: text(body.message, 3000),
    budget: text(body.budget, 120),
    timeline: text(body.timeline, 120),
    website_confirm: text(body.website_confirm, 200),
  };
}

export function validatePartnerInquiry(input) {
  if (input.website_confirm) return 'spam_detected';
  if (input.name.length < 2) return 'name_required';
  if (input.contact.length < 3) return 'contact_required';
  if (input.message.length < 20) return 'message_too_short';
  if (input.website && !/^https?:\/\//i.test(input.website)) return 'website_invalid';
  return '';
}

function allowRequest(ip, now = Date.now()) {
  const key = String(ip || 'unknown').slice(0, 100);
  const recent = (limits.get(key) || []).filter(timestamp => now - timestamp < HOUR_MS);
  if (recent.length >= 3) return false;
  recent.push(now);
  limits.set(key, recent);
  if (limits.size > 5000) {
    for (const [storedKey, timestamps] of limits) {
      if (!timestamps.some(timestamp => now - timestamp < HOUR_MS)) limits.delete(storedKey);
    }
  }
  return true;
}

function serialize(doc) {
  const data = doc.data() || {};
  const iso = value => value?.toDate?.().toISOString?.() || null;
  return {
    id: doc.id,
    name: data.name || '',
    company: data.company || '',
    contact: data.contact || '',
    website: data.website || '',
    message: data.message || '',
    budget: data.budget || '',
    timeline: data.timeline || '',
    status: VALID_STATUSES.has(data.status) ? data.status : 'new',
    created_at: iso(data.created_at),
    updated_at: iso(data.updated_at),
  };
}

export function createPartnerInquiriesHandler({ db, requireAdmin = requireAdminRequest, notifyTelegram = sendPartnerInquiryTelegram } = {}) {
  return async function partnerInquiriesHandler(req, res) {
    try {
      const store = db || adminFirestore();
      if (req.method === 'POST') {
        if (!allowRequest(req.ip)) return res.status(429).json({ error: 'rate_limited' });
        const input = normalizePartnerInquiry(req.body);
        const validationError = validatePartnerInquiry(input);
        if (validationError === 'spam_detected') return res.status(201).json({ ok: true });
        if (validationError) return res.status(400).json({ error: validationError });
        delete input.website_confirm;
        const ref = await store.collection('partner_inquiries').add({
          ...input,
          status: 'new',
          source: 'partners_page',
          schema_version: 1,
          created_at: FieldValue.serverTimestamp(),
          updated_at: FieldValue.serverTimestamp(),
        });
        try {
          const delivery = await notifyTelegram(input);
          await ref.set({ telegram_alert_sent:delivery.sent === true, telegram_alert_at:delivery.sent ? FieldValue.serverTimestamp() : null }, { merge:true });
        } catch (error) {
          console.error('partner inquiry telegram alert failed', error);
          await ref.set({ telegram_alert_sent:false, telegram_alert_error:text(error?.message || error, 160) }, { merge:true }).catch(() => {});
        }
        return res.status(201).json({ ok: true, id: ref.id });
      }

      if (req.method === 'GET') {
        await requireAdmin(req, { db: store });
        const snapshot = await store.collection('partner_inquiries').orderBy('created_at', 'desc').limit(100).get();
        return res.status(200).json({ inquiries: snapshot.docs.map(serialize) });
      }

      if (req.method === 'PATCH') {
        await requireAdmin(req, { db: store });
        const id = text(req.body?.id, 160);
        const status = text(req.body?.status, 30);
        if (!id || !VALID_STATUSES.has(status)) return res.status(400).json({ error: 'invalid_update' });
        const ref = store.collection('partner_inquiries').doc(id);
        const snapshot = await ref.get();
        if (!snapshot.exists) return res.status(404).json({ error: 'not_found' });
        await ref.set({ status, updated_at: FieldValue.serverTimestamp() }, { merge: true });
        return res.status(200).json({ ok: true });
      }

      return res.status(405).json({ error: 'method_not_allowed' });
    } catch (error) {
      return adminRequestError(res, error, 'partner-inquiries');
    }
  };
}

export default createPartnerInquiriesHandler();
