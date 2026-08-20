import { getApp, getApps, initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';

const config = { apiKey:'AIzaSyA1ya7fO5ZSeeokEfRHikWwpBXeXYhm9ww', authDomain:'valorant-linemaps.firebaseapp.com', projectId:'valorant-linemaps', appId:'1:288103111419:web:daca10a760282d40996e5e' };
const app = getApps().length ? getApp() : initializeApp(config);
const target = document.getElementById('author-reward-balance');
if (target) onAuthStateChanged(getAuth(app), async user => {
  if (!user) { target.textContent = 'Войди, чтобы увидеть баланс'; return; }
  try {
    const result = await httpsCallable(getFunctions(app, 'us-central1'), 'getRewardsDashboard')();
    const available = Number(result.data?.balance?.available_vp || 0);
    const tasks = Array.isArray(result.data?.tasks) ? result.data.tasks.length : 0;
    target.textContent = `Баланс: ${available} VP${tasks ? ` · активных заданий: ${tasks}` : ''}`;
  } catch { target.textContent = 'Баланс временно недоступен'; }
});
