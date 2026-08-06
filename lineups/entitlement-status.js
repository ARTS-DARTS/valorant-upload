import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const app = getApps()[0] || initializeApp({
  apiKey:'AIzaSyA1ya7fO5ZSeeokEfRHikWwpBXeXYhm9ww',
  authDomain:'valorant-linemaps.firebaseapp.com',
  projectId:'valorant-linemaps',
  storageBucket:'valorant-linemaps.firebasestorage.app',
  messagingSenderId:'288103111419',
  appId:'1:288103111419:web:daca10a760282d40996e5e',
});
const auth = getAuth(app);
const status = document.getElementById('premium-account-status');
const names = { ad_free:'Без рекламы', plus:'Плюс', sponsor:'Спонсор' };
let currentUser = null;
let refreshTimer = null;

function date(value) {
  const parsed = new Date(value || '');
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleDateString('ru-RU');
}

async function refreshEntitlement({ forceToken = false } = {}) {
  if (!status || !currentUser) return;
  try {
    const token = await currentUser.getIdToken(forceToken);
    const response = await fetch('/api/billing/me', {
      cache:'no-store', headers:{ Authorization:`Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`billing_${response.status}`);
    const data = await response.json();
    const entitlement = data.entitlement || {};
    status.textContent = entitlement.active
      ? `${names[entitlement.plan_id] || entitlement.plan_id} активен до ${date(entitlement.access_until)}`
      : 'Premium не активирован';
  } catch (_) {
    status.textContent = 'Не удалось проверить подписку';
  }
}

onAuthStateChanged(auth, user => {
  currentUser = user;
  clearInterval(refreshTimer);
  if (!user) {
    if (status) status.textContent = 'Войди в аккаунт для проверки Premium';
    return;
  }
  refreshEntitlement({ forceToken:true });
  refreshTimer = setInterval(refreshEntitlement, 30000);
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshEntitlement({ forceToken:true });
});
window.addEventListener('focus', () => refreshEntitlement({ forceToken:true }));
