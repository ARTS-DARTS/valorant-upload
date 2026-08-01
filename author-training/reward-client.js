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
const getTrainingProgress = httpsCallable(
  getFunctions(app, 'us-central1'),
  'getAuthorTrainingProgress',
);
const acknowledgeTrainingCriteria = httpsCallable(
  getFunctions(app, 'us-central1'),
  'acknowledgeAuthorTrainingCriteria',
);
const category = new URLSearchParams(location.search).get('category')
  || (location.pathname.includes('/wallbang') ? 'wallbang'
    : location.pathname.includes('/combo') ? 'combo'
      : location.pathname.includes('/defense') ? 'defense' : 'lineup');
let syncPromise = null;

window.acknowledgeAuthorTrainingCriteria = async revision => {
  const user = await authenticatedUser();
  if (!user) throw new Error('Чтобы сохранить ознакомление, войди в аккаунт');
  const result = await acknowledgeTrainingCriteria({ category, revision });
  return result.data || {};
};

function localProgressKeys(uid) {
  const keys = [
    `vl_category_training_${uid}_${category}`,
    `vlineups-training-${category}-${uid}`,
  ];
  if (category === 'lineup') {
    keys.push(`vlineups-training-lineup-${uid}`);
  }
  if (category === 'defense') {
    keys.push('vlineups-training-demo', 'vlineups-training-defense-max-step');
  }
  return [...new Set(keys)];
}

async function reconcileLocalProgress(user) {
  const result = await getTrainingProgress();
  const completed = result.data?.categories?.[category] === true;
  const resetAppliedKey = `author-training-reset-applied:${user.uid}:${category}`;
  if (completed) {
    sessionStorage.removeItem(resetAppliedKey);
    return;
  }

  const storedProgress = localProgressKeys(user.uid)
    .map(key => [key, localStorage.getItem(key)])
    .filter(([, value]) => value !== null);
  for (const [key] of storedProgress) localStorage.removeItem(key);
  if (storedProgress.length === 0) return;

  const onlyFreshDefenseState = category === 'defense'
    && storedProgress.every(([key, value]) => {
      if (key === 'vlineups-training-defense-max-step') return Number(value) === 0;
      if (key !== 'vlineups-training-demo') return false;
      try {
        const draft = JSON.parse(value);
        return Number(draft?.step || 0) === 0 && draft?.completed !== true;
      } catch (_) {
        return false;
      }
    });
  if (onlyFreshDefenseState) return;

  if (sessionStorage.getItem(resetAppliedKey) === '1') return;
  sessionStorage.setItem(resetAppliedKey, '1');
  location.reload();
}

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

authenticatedUser().then(user => {
  if (!user) return;
  reconcileLocalProgress(user).catch(error => {
    console.error('author training local progress reconcile failed', {
      category,
      code: error?.code,
      message: error?.message || String(error),
    });
  });
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
