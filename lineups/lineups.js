import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const app = getApps()[0] || initializeApp({ apiKey:'AIzaSyA1ya7fO5ZSeeokEfRHikWwpBXeXYhm9ww', authDomain:'valorant-linemaps.firebaseapp.com', projectId:'valorant-linemaps', storageBucket:'valorant-linemaps.firebasestorage.app', messagingSenderId:'288103111419', appId:'1:288103111419:web:daca10a760282d40996e5e' });
const auth = getAuth(app);
const el = id => document.getElementById(id);
const state = { user:null, entitlement:null, catalog:null, lineups:[], filters:{ map:'', agent:'', ability:'' }, months:1 };
const planCopy = {
  ad_free:{ level:'Уровень 1', title:'Без рекламы', tone:'mint', benefit:'Убирает рекламу в приложении и на сайте. Действия с наградой выполняются без просмотра рекламы.' },
  plus:{ level:'Уровень 2 · Для сайта', title:'Плюс', tone:'violet', benefit:'Всё из первого уровня, доступ к лайнапам на сайте, сохранённым фильтрам, поискам и заметкам.' },
  sponsor:{ level:'Уровень 3', title:'Спонсор', tone:'gold', benefit:'Всё из уровней 1–2, отправка без ожидания, двойной вес голосов и значок спонсора.' },
};

function money(minor) { return new Intl.NumberFormat('ru-RU', { style:'currency', currency:'RUB', maximumFractionDigits:0 }).format(Number(minor || 0) / 100); }
function esc(value) { const node=document.createElement('span'); node.textContent=String(value ?? ''); return node.innerHTML; }
async function token(force=false) { return state.user?.getIdToken(force); }
async function api(url, options={}) {
  const idToken = await token();
  const response = await fetch(url, { cache:'no-store', ...options, headers:{ ...(options.body ? {'Content-Type':'application/json'} : {}), Authorization:`Bearer ${idToken}`, ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `request_${response.status}`), { status:response.status });
  return data;
}

function show(id) { el(id).hidden=false; }
function hide(id) { el(id).hidden=true; }
function accountLabel() { return state.user?.displayName || state.user?.email || 'Аккаунт VLineups'; }

async function loadCatalog() {
  const response = await fetch('/api/billing/plans', { cache:'no-store' });
  if (!response.ok) throw new Error('catalog_unavailable');
  state.catalog = await response.json();
}

function renderTerms() {
  el('term-row').innerHTML = [1,3,6,12].map(months => `<button class="${state.months===months?'active':''}" type="button" data-months="${months}">${months} ${months===1?'месяц':months<5?'месяца':'месяцев'}</button>`).join('');
}

function offerFor(plan) { return plan.offers.find(offer => offer.months === state.months); }
function renderPlans() {
  if (!state.catalog) return;
  el('plan-grid').innerHTML = state.catalog.plans.map(plan => {
    const copy=planCopy[plan.plan_id]; const offer=offerFor(plan); const recommended=plan.plan_id==='plus';
    return `<article class="plan-card ${copy.tone} ${recommended?'recommended':''}">${recommended?'<div class="plan-ribbon">Открывает веб-лайнапы</div>':''}<span>${copy.level}</span><h3>${copy.title}</h3><p>${copy.benefit}</p><div class="plan-price"><strong>${money(offer.amount_minor)}</strong><small>за ${offer.period_days} дней</small></div>${offer.discount_bps?`<div class="plan-discount">Скидка ${offer.discount_bps/100}% · ${money(offer.amount_minor/state.months)} в месяц</div>`:'<div class="plan-discount neutral">Обычная цена за месяц</div>'}<button type="button" data-buy="${plan.plan_id}">${state.user?'Выбрать уровень':'Войти и выбрать'}</button></article>`;
  }).join('');
}

async function checkout(planId) {
  if (!state.user) { location.href='/?return=/lineups/'; return; }
  if (!el('billing-terms').checked) { el('billing-terms').focus(); el('billing-terms').closest('label').classList.add('attention'); return; }
  const plan=state.catalog.plans.find(item=>item.plan_id===planId); const offer=offerFor(plan); const button=document.querySelector(`[data-buy="${planId}"]`);
  button.disabled=true; button.textContent='Открываем оплату…';
  try {
    const result=await api('/api/billing/checkout',{ method:'POST', headers:{'Idempotency-Key':crypto.randomUUID().replaceAll('-','')}, body:JSON.stringify({planId,months:state.months,expectedAmountMinor:offer.amount_minor,termsVersion:state.catalog.terms_version}) });
    location.href=result.checkout_url;
  } catch (_) { button.disabled=false; button.textContent='Попробовать ещё раз'; }
}

function unique(field, items=state.lineups) { return [...new Set(items.map(item=>item[field]).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ru')); }
function filterButton(value, active, field) { return `<button type="button" class="${value===active?'active':''}" data-filter="${field}" data-value="${esc(value)}">${esc(value||'Все')}</button>`; }
function filteredLineups() { return state.lineups.filter(item => (!state.filters.map||item.map===state.filters.map)&&(!state.filters.agent||item.agent===state.filters.agent)&&(!state.filters.ability||item.ability===state.filters.ability)); }
function renderLibrary() {
  el('map-filter').innerHTML=filterButton('',state.filters.map,'map')+unique('map').map(x=>filterButton(x,state.filters.map,'map')).join('');
  const afterMap=state.lineups.filter(x=>!state.filters.map||x.map===state.filters.map);
  el('agent-filter').innerHTML=filterButton('',state.filters.agent,'agent')+unique('agent',afterMap).map(x=>filterButton(x,state.filters.agent,'agent')).join('');
  const afterAgent=afterMap.filter(x=>!state.filters.agent||x.agent===state.filters.agent);
  el('ability-filter').innerHTML=filterButton('',state.filters.ability,'ability')+unique('ability',afterAgent).map(x=>filterButton(x,state.filters.ability,'ability')).join('');
  const items=filteredLineups(); el('result-count').textContent=String(items.length);
  el('result-title').textContent=[state.filters.map,state.filters.agent,state.filters.ability].filter(Boolean).join(' · ')||'Все материалы';
  el('lineup-grid').innerHTML=items.length?items.map(item=>`<article class="lineup-card"><div class="lineup-card-visual">${item.screenshots[0]?`<img src="${esc(item.screenshots[0])}" alt="">`:'<div class="lineup-card-empty">V</div>'}<span>${esc(item.map||'Карта')}</span></div><div class="lineup-card-body"><div class="lineup-card-meta">${esc(item.agent||'Агент')} · ${esc(item.ability||'Способность')}</div><h3>${esc(item.title)}</h3><p>${esc(item.description||'Описание появится после открытия материала.')}</p><button type="button" data-play="${esc(item.id)}" ${item.has_video?'':'disabled'}>${item.has_video?'▶ Смотреть видео':'Видео не добавлено'}</button></div></article>`).join(''):'<div class="library-empty"><b>В этом сочетании пока пусто</b><span>Сбрось один из фильтров или выбери другого агента.</span></div>';
}

async function openVideo(id) {
  const item=state.lineups.find(value=>value.id===id); if(!item)return;
  const result=await api('/api/lineups/playback-token',{method:'POST',body:JSON.stringify({lineupId:id})});
  const video=el('protected-video'); video.src=result.playback_url; video.load();
  el('viewer-watermark').textContent=`${result.watermark} · VLINEUPS`;
  el('player-dialog-meta').textContent=`${item.map} · ${item.agent} · ${item.ability}`;
  el('player-dialog-title').textContent=item.title; el('player-dialog-description').textContent=item.description;
  el('lineup-player-dialog').showModal(); video.play().catch(()=>{});
}

async function boot(user) {
  state.user=user; el('viewer-account').textContent=user?accountLabel():'Гость';
  try { await loadCatalog(); } catch (_) {}
  if (!user) { hide('viewer-loading'); show('viewer-paywall'); el('premium-account-status').textContent='Войдите, чтобы проверить доступ'; renderTerms(); renderPlans(); return; }
  try {
    const me=await api('/api/billing/me'); state.entitlement=me.entitlement;
    const hasAccess=me.entitlement?.capabilities?.plus_tools===true;
    el('premium-account-status').textContent=me.entitlement.active?`${planCopy[me.entitlement.plan_id]?.title||'Подписка'} до ${new Date(me.entitlement.access_until).toLocaleDateString('ru-RU')}`:'Подписка не активна';
    if (!hasAccess) { hide('viewer-loading'); show('viewer-paywall'); renderTerms(); renderPlans(); return; }
    const data=await api('/api/lineups'); state.lineups=data.lineups||[]; hide('viewer-loading'); show('viewer-library'); renderLibrary();
  } catch (_) { hide('viewer-loading'); show('viewer-paywall'); renderTerms(); renderPlans(); }
}

document.addEventListener('click', event => {
  const month=event.target.closest('[data-months]'); if(month){state.months=Number(month.dataset.months);renderTerms();renderPlans();return;}
  const buy=event.target.closest('[data-buy]'); if(buy){checkout(buy.dataset.buy);return;}
  const filter=event.target.closest('[data-filter]'); if(filter){state.filters[filter.dataset.filter]=filter.dataset.value;if(filter.dataset.filter==='map'){state.filters.agent='';state.filters.ability='';}if(filter.dataset.filter==='agent')state.filters.ability='';renderLibrary();return;}
  const play=event.target.closest('[data-play]'); if(play)openVideo(play.dataset.play).catch(()=>{});
});
el('protected-video').addEventListener('contextmenu', event=>event.preventDefault());
el('player-dialog-close').addEventListener('click',()=>el('lineup-player-dialog').close());
el('lineup-player-dialog').addEventListener('close',()=>{const video=el('protected-video');video.pause();video.removeAttribute('src');video.load();});
onAuthStateChanged(auth, user=>boot(user));
