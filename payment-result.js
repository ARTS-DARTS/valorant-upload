import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const app = initializeApp({
  apiKey:'AIzaSyA1ya7fO5ZSeeokEfRHikWwpBXeXYhm9ww',
  authDomain:'valorant-linemaps.firebaseapp.com',
  projectId:'valorant-linemaps',
  storageBucket:'valorant-linemaps.firebasestorage.app',
  messagingSenderId:'288103111419',
  appId:'1:288103111419:web:daca10a760282d40996e5e',
});
const auth = getAuth(app);
const params = new URLSearchParams(location.search);
const orderId = params.get('InvId') || params.get('orderId') || '';
const title = document.getElementById('result-title');
const copy = document.getElementById('result-copy');
const eyebrow = document.getElementById('result-eyebrow');
const panel = document.getElementById('order-panel');
const checkButton = document.getElementById('check-again');
let timer = null;
let attempts = 0;
const planNames = { ad_free:'Без рекламы', plus:'Плюс', sponsor:'Спонсор' };

function money(minor, currency) {
  return new Intl.NumberFormat('ru-RU', { style:'currency', currency:currency || 'RUB' }).format((minor || 0) / 100);
}

function date(value) {
  return value ? new Intl.DateTimeFormat('ru-RU', { day:'numeric', month:'long', year:'numeric' }).format(new Date(value)) : '—';
}

function showOrder(order, entitlement) {
  panel.hidden = false;
  document.getElementById('order-id').textContent = `№ ${order.id}`;
  document.getElementById('order-plan').textContent = planNames[order.plan_id] || order.plan_id || '—';
  document.getElementById('order-period').textContent = `${order.months} ${order.months === 1 ? 'месяц' : order.months < 5 ? 'месяца' : 'месяцев'}`;
  document.getElementById('order-amount').textContent = money(order.amount_minor, order.currency);
  document.getElementById('order-access').textContent = date(order.period_end || entitlement.access_until);
}

async function check(user) {
  if (!orderId) {
    title.textContent = 'Не найден номер заказа';
    copy.textContent = 'Вернись в приложение и открой покупку ещё раз.';
    checkButton.hidden = true;
    return;
  }
  checkButton.disabled = true;
  try {
    const token = await user.getIdToken();
    const response = await fetch(`/api/billing/order-status?orderId=${encodeURIComponent(orderId)}`, {
      headers:{ Authorization:`Bearer ${token}` },
      cache:'no-store',
    });
    if (response.status === 404) throw new Error('Заказ не найден в этом аккаунте.');
    if (!response.ok) throw new Error('Не удалось проверить платёж.');
    const data = await response.json();
    showOrder(data.order, data.entitlement);
    if (data.order.status === 'succeeded') {
      eyebrow.textContent = 'Платёж подтверждён';
      title.textContent = 'Уровень активирован';
      copy.textContent = 'Оплата подтверждена сервером. Новый уровень уже действует в приложении и кабинете.';
      clearTimeout(timer);
      checkButton.hidden = true;
      document.getElementById('open-app').hidden = false;
      return;
    }
    if (data.order.status === 'requires_review') {
      eyebrow.textContent = 'Нужна проверка';
      title.textContent = 'Платёж получен';
      copy.textContent = 'Платёж подтверждён, но заказ требует ручной проверки. Мы сохранили его и не потеряем.';
      clearTimeout(timer);
      checkButton.hidden = true;
      return;
    }
    if (['failed', 'reversed'].includes(data.order.status)) {
      location.replace(`/payment/fail?InvId=${encodeURIComponent(orderId)}`);
      return;
    }
    title.textContent = 'Платёж обрабатывается';
    copy.textContent = 'Robokassa вернула тебя на сайт, но серверное подтверждение ещё не пришло. Проверяем автоматически.';
    attempts += 1;
    if (attempts < 12) timer = setTimeout(() => check(user), 3000);
  } catch (error) {
    copy.textContent = error.message || 'Не удалось проверить платёж. Попробуй ещё раз.';
  } finally {
    checkButton.disabled = false;
  }
}

onAuthStateChanged(auth, user => {
  if (!user) {
    title.textContent = 'Войди в аккаунт';
    copy.textContent = 'Чтобы безопасно проверить заказ, вернись в кабинет и войди в тот аккаунт, с которого была покупка.';
    checkButton.hidden = true;
    return;
  }
  checkButton.addEventListener('click', () => check(user));
  check(user);
});
