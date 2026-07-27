import { getApp, getApps, initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';

const config = {
  apiKey: 'AIzaSyA1ya7fO5ZSeeokEfRHikWwpBXeXYhm9ww',
  authDomain: 'valorant-linemaps.firebaseapp.com',
  projectId: 'valorant-linemaps',
  storageBucket: 'valorant-linemaps.firebasestorage.app',
  messagingSenderId: '288103111419',
  appId: '1:288103111419:web:daca10a760282d40996e5e',
};
const app = getApps().length ? getApp() : initializeApp(config);
const auth = getAuth(app);
const completeTraining = httpsCallable(
  getFunctions(app, 'us-central1'),
  'completeAuthorTraining',
);
const category = new URLSearchParams(location.search).get('category')
  || (location.pathname.includes('/wallbang') ? 'wallbang'
    : location.pathname.includes('/combo') ? 'combo'
      : location.pathname.includes('/defense') ? 'defense' : 'lineup');
let syncPromise = null;

function authenticatedUser() {
  if (auth.currentUser) return Promise.resolve(auth.currentUser);
  return new Promise(resolve => {
    const unsubscribe = onAuthStateChanged(auth, user => {
      unsubscribe();
      resolve(user);
    });
  });
}

async function syncCompletion() {
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    const user = await authenticatedUser();
    if (!user) throw new Error('Чтобы сохранить прохождение, войди в аккаунт');
    const result = await completeTraining({ category });
    return result.data || {};
  })().catch(error => {
    syncPromise = null;
    console.error('author training completion sync failed', {
      category,
      code: error?.code,
      message: error?.message || String(error),
    });
    throw error;
  });
  return syncPromise;
}

window.addEventListener('author-training-completed', () => {
  syncCompletion().catch(() => {});
});

document.addEventListener('click', async event => {
  const link = event.target.closest('[data-training-return]');
  if (!link) return;
  event.preventDefault();
  const target = link.href;
  const original = link.textContent;
  link.setAttribute('aria-disabled', 'true');
  link.textContent = 'СОХРАНЯЕМ РЕЗУЛЬТАТ…';
  try {
    const result = await syncCompletion();
    const returnUrl = new URL(target, location.origin);
    returnUrl.searchParams.set('training_completed', category);
    returnUrl.searchParams.set('training_awarded', result.awarded === true ? '1' : '0');
    location.href = returnUrl;
  } catch (error) {
    link.removeAttribute('aria-disabled');
    link.textContent = original;
    window.alert(error?.message || 'Не удалось сохранить прохождение. Проверь интернет и попробуй ещё раз.');
  }
}, true);
