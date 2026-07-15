import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
const ACTIVE_MS = 120_000;
const MIN_WRITE_MS = 35_000;
const MAX_PER_IP = 3;
const ALLOWED_ORIGINS = new Set(['https://vlineups.ru', 'https://www.vlineups.ru', 'https://arts-darts.github.io', 'http://localhost:3000']);
function clean(value) { return String(value ?? '').replace(/п»ї/g, '').trim(); }
function initFirebase() { if (getApps().length) return; const raw = clean(process.env.FIREBASE_SERVICE_ACCOUNT); if (!raw) throw new Error('Firebase service account env is empty'); initializeApp({ credential: cert(JSON.parse(raw)) }); }
function headers(req, res) { const origin = clean(req.headers.origin); if (ALLOWED_ORIGINS.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); }
function requestIp(req) { return clean(req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress).split(',')[0]; }
function ipHash(req) { const salt = clean(process.env.PRESENCE_HASH_SALT || process.env.FIREBASE_SERVICE_ACCOUNT).slice(0, 128); return crypto.createHash('sha256').update(`${salt}|${requestIp(req)}`).digest('hex').slice(0, 24); }
async function authorize(req) { const header = clean(req.headers.authorization); if (!header.startsWith('Bearer ')) throw Object.assign(new Error('Authentication required'), { status:401 }); initFirebase(); return getAuth().verifyIdToken(header.slice(7), true); }
async function heartbeat(req, res, decoded) { const db = getFirestore(); const ref = db.collection('site_presence').doc(decoded.uid); const now = Date.now(); await db.runTransaction(async tx => { const snap = await tx.get(ref); const previous = snap.data()?.last_seen?.toMillis?.() || 0; if (now - previous < MIN_WRITE_MS) return; tx.set(ref, { uid:decoded.uid, ip_hash:ipHash(req), last_seen:FieldValue.serverTimestamp(), updated_at:FieldValue.serverTimestamp() }, { merge:true }); }); res.status(200).json({ ok:true, next_in_ms:45_000 }); }
async function onlineCount(res, decoded) { const db = getFirestore(); const user = await db.collection('users').doc(decoded.uid).get(); if (clean(user.data()?.role).toLowerCase() !== 'admin') return res.status(403).json({ error:'Admin access required' }); const cutoff = Timestamp.fromMillis(Date.now() - ACTIVE_MS); const snap = await db.collection('site_presence').where('last_seen', '>=', cutoff).limit(1000).get(); const perIp = new Map(); let online = 0; for (const doc of snap.docs) { const hash = clean(doc.data()?.ip_hash) || `legacy:${doc.id}`; const used = perIp.get(hash) || 0; if (used >= MAX_PER_IP) continue; perIp.set(hash, used + 1); online += 1; } res.status(200).json({ online, window_seconds:ACTIVE_MS / 1000, capped_per_ip:MAX_PER_IP, sampled:snap.size >= 1000 }); }
export default async function handler(req, res) { headers(req, res); if (req.method === 'OPTIONS') return res.status(204).end(); if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error:'Method not allowed' }); try { const decoded = await authorize(req); return req.method === 'POST' ? await heartbeat(req, res, decoded) : await onlineCount(res, decoded); } catch (error) { const status = Number(error.status) || (error.code?.startsWith('auth/') ? 401 : 500); if (status >= 500) console.error('site-presence error:', error); return res.status(status).json({ error:status >= 500 ? 'Internal server error' : error.message }); } }
