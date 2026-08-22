import { initializeApp }                    from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth,
         signInWithEmailAndPassword, signInWithCustomToken,
         signOut, onAuthStateChanged, reauthenticateWithPopup,
         reauthenticateWithCredential, GoogleAuthProvider, EmailAuthProvider }
                                             from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore, doc, collection, getDoc, setDoc, deleteDoc, writeBatch,
          serverTimestamp, onSnapshot, updateDoc, arrayUnion,
          query, where, getDocs, limit }      from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getFunctions, httpsCallable }
                                             from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';
import { initSiteVersionWatcher }             from './site-version-watcher.js?v=2026-07-30-global-update-v1';
import { undefinedPaths, withoutUndefined }   from './firestore-data.mjs?v=2026-08-19-firestore-safe-v1';
import {
  MAX_FREEZE_ANNOTATION_STROKES,
  createFreezeAnnotation,
  drawFreezeAnnotations,
  freezeAnnotationsSvg,
  normalizeFreezeAnnotations,
  updateFreezeAnnotation,
} from './video-frame-annotations.mjs?v=2026-08-11-vector-drawing-v1';
import {
  clampVideoViewerZoom,
  zoomVideoViewerAtPoint,
} from './video-viewer-zoom.mjs?v=2026-08-02-viewer-zoom-v1';
import {
  advanceVideoTimelinePlayback as sharedPlaybackPosition,
  buildVideoTimelineSegments as buildSharedTimelineSegments,
  outputTimeToScrubberValue as sharedOutputToScrubberValue,
  outputTimeToSourceTime as sharedOutputToSourceTime,
  scrubberValueToOutputTime as sharedScrubberToOutputTime,
  sourceTimeToOutputTime as sharedSourceToOutputTime,
  videoTimelineActiveFootageAt as sharedActiveFootageAt,
  videoTimelineEffectOutputStart as sharedEffectOutputStart,
  videoTimelineOutputDuration as sharedOutputDuration,
  videoTimelineSegmentAt as sharedSegmentAt,
  videoTimelineZoomStateAt as sharedZoomStateAt,
} from './video_timeline_core.mjs?v=2026-08-12-stable-duration-v1';
import {
  migrateVideoEditToProjectV3,
  reconcileVideoSourceDuration,
  stableVideoItemId,
} from './video_project_v3.mjs?v=2026-08-06-video-duration-reconcile-v1';
import { parseIsoBmffDuration } from './video_metadata_core.mjs?v=2026-08-11-duration-fallback-v1';
import {
  effectiveProgressPoints,
  entitlementHasCooldownBypass,
  remainingCooldownMs,
} from './cooldown-core.mjs?v=2026-08-08-cooldown-authority-v1';
import { createSocialWebsite } from './social-communication.mjs?v=2026-08-21-profile-fix-v1';
import {
  canSubmitForRewards,
  rewardActionErrorMessage,
  rewardProgramAccepting,
} from './reward-ui-policy.mjs?v=2026-08-21-paused-state-v1';

const cfg = {
  apiKey:            'AIzaSyA1ya7fO5ZSeeokEfRHikWwpBXeXYhm9ww',
  authDomain:        'valorant-linemaps.firebaseapp.com',
  projectId:         'valorant-linemaps',
  storageBucket:     'valorant-linemaps.firebasestorage.app',
  messagingSenderId: '288103111419',
  appId:             '1:288103111419:web:daca10a760282d40996e5e',
};

const app  = initializeApp(cfg);
const auth = getAuth(app);
const db   = getFirestore(app);
const functions = getFunctions(app, 'us-central1');
const socialWebsite = createSocialWebsite({ db, functions, toast: (...args) => toast(...args) });
const createSelectelVideoUpload = httpsCallable(functions, 'createSelectelVideoUpload');
const getRewardsDashboard = httpsCallable(functions, 'getRewardsDashboard');
const joinRewardProgram = httpsCallable(functions, 'joinRewardProgram');
const requestRewardPayout = httpsCallable(functions, 'requestRewardPayout');
const cancelRewardPayout = httpsCallable(functions, 'cancelRewardPayout');
const staffReviewRewardLineup = httpsCallable(functions, 'staffReviewRewardLineup');
const getRewardReviewContext = httpsCallable(functions, 'getRewardReviewContext');
const syncAuthorTrainingCriteriaNotifications = httpsCallable(
  functions,
  'syncAuthorTrainingCriteriaNotifications',
);
const UPLOAD_REQUIRED_VIEWS = 5;
const USER_TRACKING_START = new Date('2026-06-20T00:00:00Z');
const EDITOR_MAX_ZOOM = 2.2;
let rewardDashboard = null;
let rewardBusy = false;
let rewardDemandAgent = '';
let rewardDemandMap = '';
let rewardDemandRanking = 'map_pool';

function rewardStatusLabel(status) {
  return ({pending:'На проверке',approved:'Проверена',ready:'Код готов',revealed:'Код открыт',confirmed:'Завершена',rejected:'Отклонена',canceled:'Отменена'})[status] || status || '—';
}
function rewardHoldLabel(reason) {
  return ({duplicate_asset:'Найден похожий материал',fund_exhausted:'Фонд временно исчерпан',author_monthly_limit:'Достигнут месячный лимит автора',task_limit:'Лимит задания исчерпан'})[reason] || 'Требуется ручная проверка';
}
function rewardDate(value) {
  const seconds = Number(value?.seconds ?? value?._seconds ?? 0);
  return seconds ? new Date(seconds * 1000).toLocaleDateString('ru-RU') : '—';
}
function updateRewardSubmitOptIn() {
  const host = document.getElementById('reward-submit-optin');
  const input = document.getElementById('reward-submit-checkbox');
  const active = canSubmitForRewards(rewardDashboard);
  const becomingAvailable = active && !moderatorDraftSourceId && host?.hidden === true;
  if (host) host.hidden = !active || !!moderatorDraftSourceId;
  if (input) {
    if (!active || moderatorDraftSourceId) input.checked = false;
    else if (becomingAvailable) input.checked = true;
  }
}
function rewardDemandRows(value) {
  return Object.values(value || {}).filter(row => row && typeof row === 'object');
}
function isRealRewardMap(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[—–-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return ![
    'выбери карту', 'выберите карту', 'choose map', 'select map',
    'harita seç', 'elige un mapa', 'selecione o mapa',
  ].includes(normalized);
}
function rewardDemandIcon(agentName) {
  const agent = agentsList.find(item => item.displayName === agentName);
  return proxiedValorantUrl(agent?.displayIconSmall || agent?.displayIcon || '');
}
function rewardDemandAbilityIcon(agentName, abilityName) {
  const normalized = value => String(value || '').trim().toLocaleLowerCase('ru-RU');
  const agent = agentsList.find(item => normalized(item.displayName) === normalized(agentName));
  const ability = (agent?.abilities || []).find(item => normalized(item.displayName) === normalized(abilityName));
  return proxiedValorantUrl(ability?.displayIcon || '');
}
function renderRewardDemand(deficits) {
  const globalRows = rewardDemandRows(deficits?.global);
  const mapRows = rewardDemandRows(deficits?.map_pool).filter(row => isRealRewardMap(row.map));
  const subscriberCounts = deficits?.agent_notification_subscribers || {};
  const activeMaps = (rewardDashboard?.settings?.active_map_pool || [])
    .map(value => String(value || '').trim()).filter(isRealRewardMap);
  if (!globalRows.length && !mapRows.length) return '';
  const groups = new Map();
  mapRows.forEach(row => {
    const agent = String(row.agent || '').trim();
    if (!agent) return;
    if (!groups.has(agent)) groups.set(agent, []);
    groups.get(agent).push(row);
  });
  const globalByAgent = new Map();
  globalRows.forEach(row => {
    const agent = String(row.agent || '').trim();
    if (!agent) return;
    if (!globalByAgent.has(agent)) globalByAgent.set(agent, []);
    globalByAgent.get(agent).push(row);
    if (!groups.has(agent)) groups.set(agent, []);
  });
  const agentPriority = agent => {
    const rows = rewardDemandRanking === 'global' ? (globalByAgent.get(agent) || []) : (groups.get(agent) || []);
    return {
      score: rows.length ? Math.max(...rows.map(row => Number(row.priority_score || 0))) : 0,
      deficitCount: rows.filter(row => row.deficit === true).length,
      minCount: rows.length ? Math.min(...rows.map(row => Number(row.count || 0))) : 9999,
      subscribers: Number(rows[0]?.agent_subscribers ?? subscriberCounts[String(agent).trim().toLowerCase()] ?? subscriberCounts[agent] ?? 0),
    };
  };
  const agents = [...groups.keys()].sort((a,b) => {
    const ap=agentPriority(a), bp=agentPriority(b);
    return bp.score-ap.score || bp.subscribers-ap.subscribers || bp.deficitCount-ap.deficitCount || ap.minCount-bp.minCount || a.localeCompare(b,'ru');
  });
  if (!agents.includes(rewardDemandAgent)) rewardDemandAgent=agents[0]||'';
  const agentRows=groups.get(rewardDemandAgent)||[];
  const mapPriority=map=>{
    const rows=agentRows.filter(row=>row.map===map);
    return {
      score:rows.length?Math.max(...rows.map(row=>Number(row.priority_score||0))):0,
      deficitCount:rows.filter(row=>row.deficit===true).length,
      minCount:rows.length?Math.min(...rows.map(row=>Number(row.count||0))):9999,
    };
  };
  const maps=[...new Set([...activeMaps,...agentRows.map(row=>String(row.map||'').trim()).filter(isRealRewardMap)])].sort((a,b)=>{
    const ap=mapPriority(a),bp=mapPriority(b);
    return bp.score-ap.score || bp.deficitCount-ap.deficitCount || ap.minCount-bp.minCount || a.localeCompare(b,'ru');
  });
  if (!maps.includes(rewardDemandMap)) rewardDemandMap=maps[0]||'';
  const abilities=agentRows.filter(row=>row.map===rewardDemandMap).sort((a,b)=>Number(b.priority_score||0)-Number(a.priority_score||0)||Number(a.count||0)-Number(b.count||0));
  const agentButtons=agents.map((agent,index)=>{
    const icon=rewardDemandIcon(agent), selected=agent===rewardDemandAgent;
    const opacity=Math.max(.34,1-(index/Math.max(1,agents.length-1))*.66);
    const subscribers=agentPriority(agent).subscribers;
    return `<button class="reward-demand-agent${selected?' selected':''}" type="button" data-demand-agent="${esc(agent)}" title="${esc(agent)} · уведомления: ${subscribers}" aria-label="${esc(agent)}, уведомления: ${subscribers}" aria-pressed="${selected}" style="--demand-opacity:${opacity.toFixed(2)}">${icon?`<img src="${esc(icon)}" alt="">`:`<span>${esc(agent.slice(0,1)||'?')}</span>`}</button>`;
  }).join('');
  const mapButtons=maps.map((map,index)=>`<button class="reward-demand-map${map===rewardDemandMap?' selected':''}${mapPriority(map).deficitCount?' priority':''}" type="button" data-demand-map="${esc(map)}" aria-pressed="${map===rewardDemandMap}">${esc(map)}${mapPriority(map).deficitCount?`<small>приоритет ${index+1}</small>`:''}</button>`).join('');
  const abilityCard=row=>{
    const count=Number(row.count||0), urgent=count===0;
    const icon=rewardDemandAbilityIcon(row.agent||rewardDemandAgent,row.ability);
    return `<article class="reward-demand-ability${urgent?' urgent':''}"><span class="reward-demand-ability-icon">${icon?`<img src="${esc(icon)}" alt="">`:'✦'}</span><span class="reward-demand-count">${count}</span><div><strong>${esc(row.ability||'Способность')}</strong><small>${esc(row.side||'any')}</small></div><b>${urgent?'МАКС. ПРИОРИТЕТ':`Уже есть: ${count}`}</b></article>`;
  };
  const sideGroups=[
    { key:'attack', label:'Атака', icon:'⚔' },
    { key:'defense', label:'Защита', icon:'◆' },
    { key:'any', label:'Любая сторона', icon:'◎' },
  ].map(group=>({ ...group, rows:abilities.filter(row=>String(row.side||'any').toLowerCase()===group.key) }))
    .filter(group=>group.key!=='any'||group.rows.length);
  const abilityGroups=sideGroups.map(group=>`<section class="reward-demand-side-group${group.key==='any'?' neutral':''}"><header><span>${group.icon}</span><strong>${group.label}</strong><b>${group.rows.length}</b></header><div>${group.rows.map(abilityCard).join('')||'<p>Дефицитных способностей нет</p>'}</div></section>`).join('');
  return `<section class="reward-demand"><header><div><span>РАДАР СПРОСА</span><h3>Что сейчас нужно сообществу</h3></div><div class="reward-demand-totals" role="group" aria-label="Режим оценки дефицита"><button type="button" data-demand-ranking="map_pool" class="${rewardDemandRanking==='map_pool'?'selected':''}" aria-pressed="${rewardDemandRanking==='map_pool'}"><b>${mapRows.filter(row=>row.deficit===true).length}</b><small>Маппул</small></button><button type="button" data-demand-ranking="global" class="${rewardDemandRanking==='global'?'selected':''}" aria-pressed="${rewardDemandRanking==='global'}"><b>${globalRows.filter(row=>row.deficit===true).length}</b><small>Общее</small></button></div></header><div class="reward-demand-mode-note">${rewardDemandRanking==='map_pool'?'Порядок учитывает дефицит агента и способности на каждой карте.':'Порядок учитывает общий дефицит способности без привязки к карте.'}</div><div class="reward-demand-stage"><label>1 · АГЕНТ · ПО ПРИОРИТЕТУ И ПОДПИСКАМ</label><div class="reward-demand-agents">${agentButtons}</div></div><div class="reward-demand-stage"><div class="reward-demand-stage-head"><label>2 · ВЕСЬ АКТИВНЫЙ МАППУЛ · ПРИОРИТЕТНЫЕ КАРТЫ ПЕРВЫМИ</label></div><div class="reward-demand-maps">${mapButtons}</div></div><div class="reward-demand-stage"><label>3 · СПОСОБНОСТЬ</label><div class="reward-demand-side-columns">${abilityGroups||'<div class="reward-empty">Для этой карты пока нет данных по способностям выбранного агента.</div>'}</div></div></section>`;
}
function renderRewardDialog() {
  const host = document.getElementById('reward-dialog-body'); if(!host) return;
  const data = rewardDashboard;
  if (!data) { host.innerHTML='<div class="reward-loading">Загружаем защищённый баланс…</div>'; return; }
  const membership=data.membership||{}, settings=data.settings||{};
  const accepting = rewardProgramAccepting(settings);
  if (membership.status !== 'active' || membership.terms_current !== true) {
    host.innerHTML = accepting
      ? `<div class="reward-join"><div><h3>${membership.status === 'active' ? 'Условия обновились' : 'Вступить в программу'}</h3><p>Участие добровольное. Награда начисляется только за лайнапы, которые ты сам отметишь при отправке. Программа доступна только для регионов Россия и Турция.</p></div><label>Регион Riot-аккаунта<select class="finput" id="reward-region"><option value="RU">Россия (RU)</option><option value="TR">Турция (TR)</option></select></label><label class="reward-terms-check"><input type="checkbox" id="reward-terms-accepted"><span>Я прочитал и принимаю <a href="${esc(settings.terms_url||'/rewards')}" target="_blank" rel="noopener">условия ${esc(settings.terms_version||'')}</a></span></label><button class="reward-action primary" type="button" data-reward-action="join">Принять и участвовать</button></div>`
      : `<div class="reward-join"><div><h3>Программа пока закрыта</h3><p>${esc(settings.program_message || 'Программа наград пока не принимает участников. Мы сообщим, когда участие откроется.')}</p></div><a class="reward-action" href="${esc(settings.terms_url||'/rewards')}" target="_blank" rel="noopener">Открыть условия</a></div>`;
    return;
  }
  const balance=data.balance||{}, payouts=data.payouts||[], ledger=data.ledger||[], held=data.held_claims||[];
  const denominations=(settings.denominations||[475]).filter(value=>Number(value)<=Number(balance.available_vp||0));
  const activePayout=payouts.find(item=>['pending','approved','ready','revealed'].includes(item.status));
  const payoutStatusCopy=activePayout ? ({
    pending:'Заявка отправлена и ожидает проверки.',
    approved:`Заявка одобрена. Покупаем код для региона ${esc(activePayout.region||membership.region||'')}.`,
    ready:'Код готов. Открой его один раз в Android-приложении VLineups.',
    revealed:'Код уже был открыт. Заверши подтверждение получения в Android-приложении.',
  })[activePayout.status] : '';
  const payoutAction = !accepting
    ? '<div class="reward-empty">Программа временно не принимает новые заявки. Баланс и история сохранены.</div>'
    : activePayout
      ? `<div class="reward-payout-progress"><strong>${Number(activePayout.amount_vp||0)} VP · ${esc(rewardStatusLabel(activePayout.status))}</strong><span>${payoutStatusCopy}</span>${activePayout.status==='pending'?`<button class="reward-action" data-reward-action="cancel" data-payout-id="${esc(activePayout.id)}">Отменить заявку</button>`:''}</div>`
      : denominations.length
        ? `<div class="reward-payout-ready"><div><span>Доступный номинал</span><strong>${Number(denominations[0])} VP</strong><small>Регион кода: ${esc(membership.region||'—')}</small></div><div class="reward-actions"><select class="finput" id="reward-payout-amount" aria-label="Номинал кода">${denominations.map(value=>`<option value="${Number(value)}">${Number(value)} VP</option>`).join('')}</select><button class="reward-action primary" data-reward-action="payout">Запросить код</button></div></div><p class="reward-payout-note">После проверки купим совместимый код. Обычно это занимает до ${Number(settings.fulfillment_sla_hours||24)} часов. Код открывается один раз в Android-приложении.</p>`
        : `<div class="reward-empty">До минимального номинала не хватает VP. Доступно сейчас: ${Number(balance.available_vp||0)} VP.</div>`;
  host.innerHTML=`<div class="reward-dashboard"><section class="reward-balance"><div><strong>${Number(balance.available_vp||0)} VP</strong><small>Доступно · ${Number(balance.reserved_vp||0)} VP в заявках · ${Number(balance.earned_vp||0)} VP заработано</small></div><a class="reward-action" href="/rewards" target="_blank" rel="noopener">Условия</a></section><section class="reward-panel"><h3>ПОЛУЧИТЬ КОД</h3>${payoutAction}</section>${renderRewardDemand(data.deficits)}${held.length?`<section class="reward-panel"><h3>ОЖИДАЮТ ПРОВЕРКИ</h3><div class="reward-list">${held.map(item=>`<div class="reward-item"><div><b>${Number(item.amount_vp||0)} VP · ${esc(item.lineup_id||'')}</b><small>${esc(rewardHoldLabel(item.reason))}</small></div></div>`).join('')}</div></section>`:''}<section class="reward-panel"><h3>ЗАЯВКИ</h3><div class="reward-list">${payouts.map(item=>`<div class="reward-item"><div><b>${Number(item.amount_vp||0)} VP · ${esc(item.region||'')}</b><small>${rewardStatusLabel(item.status)} · ${rewardDate(item.created_at)}${item.status==='approved'&&item.fulfillment_due_at?` · ожидаем код до ${rewardDate(item.fulfillment_due_at)}`:''}${item.review_reason?` · ${esc(item.review_reason)}`:''}</small>${['ready','revealed'].includes(item.status)?'<small>Код готов. Откройте его в Android-приложении VLineups.</small>':''}</div><div class="reward-actions">${item.status==='pending'?`<button class="reward-action" data-reward-action="cancel" data-payout-id="${esc(item.id)}">Отменить</button>`:''}</div></div>`).join('')||'<div class="reward-empty">Заявок пока нет</div>'}</div></section><section class="reward-panel"><h3>ИСТОРИЯ НАЧИСЛЕНИЙ</h3><div class="reward-list">${ledger.map(item=>`<div class="reward-item"><div><b>${esc(item.title||'Лайнап')}</b><small>${rewardDate(item.created_at)} · база ${Number(item.components?.base||0)} VP, дефицит +${Number(item.components?.global_deficit||0)+Number(item.components?.map_pool_deficit||0)} VP, качество +${Number(item.components?.quality||0)} VP, задание +${Number(item.components?.task||0)} VP</small></div><strong>${Number(item.amount_vp||0)>=0?'+':''}${Number(item.amount_vp||0)} VP</strong></div>`).join('')||'<div class="reward-empty">Первое начисление VP появится после одобрения отмеченного лайнапа.</div>'}</div></section></div>`;
}
async function loadRewardDashboard({render=false}={}) {
  if(!currentUser) return;
  try { rewardDashboard=(await getRewardsDashboard()).data; const balance=document.getElementById('author-reward-balance'); if(balance) balance.textContent=`${Number(rewardDashboard?.balance?.available_vp||0)} VP · открыть`; renderCabinetVpStats(); }
  catch(error){ console.warn('rewards dashboard',error); const balance=document.getElementById('author-reward-balance'); if(balance) balance.textContent='Баланс временно недоступен'; }
  updateRewardSubmitOptIn(); if(render) renderRewardDialog();
}

let rewardModalScrollY = 0;
let rewardModalBodyStyle = null;
function setRewardModalOpen(open) {
  const modal = document.getElementById('reward-modal');
  if (!modal) return;
  if (open && modal.hidden) {
    rewardModalScrollY = window.scrollY;
    rewardModalBodyStyle = {
      position:document.body.style.position, top:document.body.style.top,
      left:document.body.style.left, right:document.body.style.right,
      width:document.body.style.width, overflow:document.body.style.overflow,
    };
    document.body.style.position = 'fixed';
    document.body.style.top = `-${rewardModalScrollY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.width = '100%';
    document.body.style.overflow = 'hidden';
    modal.hidden = false;
    return;
  }
  if (!open && !modal.hidden) {
    modal.hidden = true;
    Object.assign(document.body.style, rewardModalBodyStyle || {
      position:'', top:'', left:'', right:'', width:'', overflow:'',
    });
    rewardModalBodyStyle = null;
    window.scrollTo(0, rewardModalScrollY);
  }
}
document.getElementById('author-reward-open')?.addEventListener('click', async()=>{ setRewardModalOpen(true); renderRewardDialog(); await loadRewardDashboard({render:true}); });
document.getElementById('cabinet-vp-open')?.addEventListener('click', async()=>{ setRewardModalOpen(true); renderRewardDialog(); await loadRewardDashboard({render:true}); });
document.getElementById('reward-close')?.addEventListener('click',()=>setRewardModalOpen(false));
document.getElementById('reward-modal')?.addEventListener('click',async event=>{
  if(event.target.id==='reward-modal'){setRewardModalOpen(false);return;}
  const demandAgent=event.target.closest('[data-demand-agent]');
  if(demandAgent){rewardDemandAgent=demandAgent.dataset.demandAgent||'';rewardDemandMap='';renderRewardDialog();return;}
  const demandMap=event.target.closest('[data-demand-map]');
  if(demandMap){rewardDemandMap=demandMap.dataset.demandMap||'';renderRewardDialog();return;}
  const demandRanking=event.target.closest('[data-demand-ranking]');
  if(demandRanking){rewardDemandRanking=demandRanking.dataset.demandRanking==='global'?'global':'map_pool';rewardDemandAgent='';rewardDemandMap='';renderRewardDialog();return;}
  const button=event.target.closest('[data-reward-action]'); if(!button||rewardBusy)return; rewardBusy=true; button.disabled=true;
  try {
    const action=button.dataset.rewardAction, payoutId=button.dataset.payoutId;
    if(['join','payout'].includes(action) && !rewardProgramAccepting(rewardDashboard?.settings)) throw new Error('Программа наград пока не принимает участников');
    if(action==='join'){ if(!document.getElementById('reward-terms-accepted')?.checked) throw new Error('Сначала прими условия программы'); await joinRewardProgram({accepted:true,terms_version:rewardDashboard.settings.terms_version,region:document.getElementById('reward-region').value}); toast('Участие в программе включено','s'); }
    if(action==='payout'){ await requestRewardPayout({amount_vp:Number(document.getElementById('reward-payout-amount').value),idempotency_key:crypto.randomUUID()}); toast('Заявка создана','s'); }
    if(action==='cancel'){ await cancelRewardPayout({payout_id:payoutId}); toast('Заявка отменена, VP возвращены','s'); }
    await loadRewardDashboard({render:true});
  } catch(error){ toast('Операция не выполнена: '+rewardActionErrorMessage(error),'e'); }
  finally{rewardBusy=false;button.disabled=false;}
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !document.getElementById('reward-modal')?.hidden) setRewardModalOpen(false);
});

const siteSounds = {
  notification: new Audio('/assets/audio/notification.mp3?v=1'),
  update: new Audio('/assets/audio/site-update.mp3?v=1'),
};
siteSounds.notification.volume = 0.7;
siteSounds.update.volume = 0.65;
Object.values(siteSounds).forEach(sound => { sound.preload = 'auto'; });
let siteAudioUnlocked = false;
let siteAudioUnlockPromise = null;
const pendingSiteSounds = new Set();
const SITE_SOUNDS_ENABLED_KEY = 'vl_site_sounds_enabled';
let siteSoundsEnabled = localStorage.getItem(SITE_SOUNDS_ENABLED_KEY) !== '0';

function isExpectedAudioBlock(error) {
  const name = String(error?.name || '');
  const message = String(error?.message || error || '');
  return name === 'NotAllowedError'
    || /didn['’]t interact with the document|user gesture|notallowederror/i.test(message);
}

function updateSiteSoundButton() {
  const button = document.getElementById('header-sound-test');
  if (!button) return;
  button.textContent = siteSoundsEnabled ? '🔊' : '🔇';
  button.classList.toggle('is-muted', !siteSoundsEnabled);
  button.setAttribute('aria-pressed', String(siteSoundsEnabled));
  button.setAttribute('aria-label', siteSoundsEnabled ? 'Выключить звуки сайта' : 'Включить звуки сайта');
  button.title = siteSoundsEnabled ? 'Выключить звуки сайта' : 'Включить звуки сайта';
}

function setSiteSoundsEnabled(enabled) {
  siteSoundsEnabled = !!enabled;
  localStorage.setItem(SITE_SOUNDS_ENABLED_KEY, siteSoundsEnabled ? '1' : '0');
  if (!siteSoundsEnabled) {
    pendingSiteSounds.clear();
    Object.values(siteSounds).forEach(sound => {
      sound.pause();
      sound.currentTime = 0;
    });
  }
  updateSiteSoundButton();
}

function playSiteSound(name, queueWhenLocked = true) {
  if (!siteSoundsEnabled) return;
  const sound = siteSounds[name];
  if (!sound) return;
  if (!siteAudioUnlocked) {
    if (queueWhenLocked) pendingSiteSounds.add(name);
    return;
  }
  sound.currentTime = 0;
  sound.play().catch(error => {
    siteAudioUnlocked = false;
    if (queueWhenLocked) pendingSiteSounds.add(name);
    if (!isExpectedAudioBlock(error)) {
      logUploadError(error, { action:'site_sound_play_failed', sound:name, ready_state:sound.readyState, network_state:sound.networkState });
    }
    console.warn('site sound blocked', name, error?.name || error);
  });
}

function unlockSiteAudio() {
  if (!siteSoundsEnabled) return Promise.resolve(false);
  if (siteAudioUnlocked || siteAudioUnlockPromise) return siteAudioUnlockPromise;
  const attempts = Object.entries(siteSounds).map(([name, sound]) => {
    const volume = sound.volume;
    sound.volume = 0;
    return sound.play().then(() => {
      sound.pause();
      sound.currentTime = 0;
      sound.volume = volume;
      return name;
    }).catch(error => {
      sound.volume = volume;
      if (!isExpectedAudioBlock(error)) {
        logUploadError(error, { action:'site_sound_unlock_failed', sound:name, ready_state:sound.readyState, network_state:sound.networkState });
      }
      return null;
    });
  });
  siteAudioUnlockPromise = Promise.all(attempts).then(results => {
    siteAudioUnlocked = results.some(Boolean);
    if (!siteAudioUnlocked) return;
    const queued = [...pendingSiteSounds];
    pendingSiteSounds.clear();
    queued.forEach(name => playSiteSound(name, false));
  }).finally(() => { siteAudioUnlockPromise = null; });
  return siteAudioUnlockPromise;
}

document.addEventListener('pointerdown', unlockSiteAudio, { once:true, capture:true });
document.addEventListener('keydown', unlockSiteAudio, { once:true, capture:true });
updateSiteSoundButton();

const DESCRIPTION_SAMPLES = [
  {
    title: 'Defense setup',
    text: 'Общий вид позиции (1 фото), установка камеры (2 фото), расположение растяжек (3 фото), зона обзора и результат при входе соперника (4 фото).',
  },
  {
    title: 'Corner + wall',
    text: 'Подходим в угол ящика и стены (1 фото), целимся прицелом (2 фото), нажимаем ЛКМ и получаем результат (3 фото).',
  },
  {
    title: 'Corner + crosshair',
    text: 'Подходим в угол (1 фото), наводим прицел на ориентир (2 фото), целимся способностью (3 фото), нажимаем ЛКМ и получаем результат (4 фото).',
  },
  {
    title: 'Wall + sign',
    text: 'Подходим в упор к стене (1 фото), затем целимся на верхнюю часть таблички (2 фото), прыжок + ЛКМ (3 фото), результат прилетает на Site (4 фото).',
  },
  {
    title: 'Flower bounce',
    text: 'Подходим в упор к углу (1 фото), затем целимся на цветы (2 фото), ставим отскок как на скриншоте (3 фото), получаем результат (4 фото).',
  },
  {
    title: 'Sova lineup',
    text: 'Встаём в угол (1 фото), целимся по ориентиру (2 фото), натягиваем тетиву с нужной силой (3 фото), стрела прилетает в отмеченную зону (4 фото).',
  },
  {
    title: 'Viper lineup',
    text: 'Становимся в упор к стене (1 фото), совмещаем прицел с ориентиром (2 фото), бросаем молли ЛКМ (3 фото), состав падает на Spike (4 фото).',
  },
  {
    title: 'Killjoy lineup',
    text: 'Подходим к отмеченной позиции (1 фото), целимся в угол текстуры (2 фото), бросаем гранату (3 фото), наносварм раскрывается на пленте (4 фото).',
  },
  {
    title: 'Post plant',
    text: 'После установки Spike отходим в безопасную позицию (1 фото), целимся по ориентиру (2 фото), бросаем способность (3 фото), лайнап закрывает дефьюз (4 фото).',
  },
  {
    title: 'Retake utility',
    text: 'Занимаем позицию для ретейка (1 фото), целимся в указанный ориентир (2 фото), используем способность (3 фото), она очищает отмеченную зону (4 фото).',
  },
  {
    title: 'Default impact',
    text: 'Подходим в упор к дефолту (1 фото), целимся способностью по ориентиру (2 фото), нажимаем ЛКМ (3 фото), получаем стабильный результат (4 фото).',
  },
  {
    title: 'Tube window',
    text: 'Подходим к трубе (1 фото), ставим прицел на окно (2 фото), используем способность с приближением (3 фото), получаем попадание в нужную точку (4 фото).',
  },
];

// ── Utils ─────────────────────────────────────────────────────────────────────
function rangeConfigId(map, agent, ability) {
  return (String(map || '') + '__' + String(agent || '') + '__' + String(ability || '')).replace(/[\\/. ]/g, '_');
}

function repairMojibake(value) {
  const s = String(value ?? '').trim();
  if (!s || !/[ÐÑР]/.test(s)) return s;
  try {
    const cp1251 = 'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–— ™љ›њќћџ ЎўЈ¤Ґ¦§Ё©Є«¬­®Ї°±Ііґµ¶·ё№є»јЅѕїАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя';
    const bytes = [];
    for (const ch of s) {
      const code = ch.charCodeAt(0);
      if (code < 128) {
        bytes.push(code);
        continue;
      }
      const idx = cp1251.indexOf(ch);
      if (idx < 0) return s;
      bytes.push(0x80 + idx);
    }
    const repaired = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
    return /[А-Яа-яЁё]/.test(repaired) ? repaired : s;
  } catch (_) {
    return s;
  }
}

function firstText(...values) {
  for (const value of values) {
    const s = repairMojibake(value);
    if (s) return s;
  }
  return '';
}

function normalizeContentCategory(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw === 'smoke') return 'wallbang';
  return raw;
}

const UPLOAD_IMPLEMENTED_CONTENT_TYPES = new Set([
  'lineup',
  'combo',
  'wallbang',
  'defense',
]);
const DEFAULT_WALLBANG_WEAPONS = ['Vandal', 'Phantom', 'Guardian', 'Ares', 'Odin'];
const DEFENSE_EXCLUDED_AGENTS = new Set(['Iso', 'Jett', 'Neon', 'Phoenix', 'Raze', 'Reyna', 'Waylay', 'Yoru']);
const UPLOAD_CONFIG_CACHE_KEY = 'vl_upload_reference_config_v1';
let uploadCategoryAccess = {
  lineup_visible: true,
  lineup_enabled: true,
  lineup_staff_enabled: false,
  combo_visible: true,
  combo_enabled: false,
  combo_staff_enabled: false,
  wallbang_visible: true,
  wallbang_enabled: false,
  wallbang_staff_enabled: false,
  defense_visible: true,
  defense_enabled: false,
  defense_staff_enabled: false,
};
let uploadWeaponWhitelist = [...DEFAULT_WALLBANG_WEAPONS];
let uploadDefenseAgents = new Set();
const agentCategoryAvailability = new Map();
const agentCategoryLoadPromises = new Map();
const agentCategoryAbilityConfigs = new Map();
let uploadCategoryAccessUnsub = null;
let uploadConfigVersionsUnsub = null;
let uploadConfigVersions = {};
let agentCategoryConfigGeneration = 0;
let uploadCategoryAccessReady = false;

function uploadCategoryFlag(category) {
  const normalized = normalizeContentCategory(category);
  if (
    canCurrentUserModerate() &&
    uploadCategoryAccess[`${normalized}_staff_enabled`] === true
  ) return true;
  if (normalized === 'lineup') return uploadCategoryAccess.lineup_enabled !== false;
  if (normalized === 'combo') return uploadCategoryAccess.combo_enabled === true;
  if (normalized === 'wallbang') return uploadCategoryAccess.wallbang_enabled === true;
  if (normalized === 'defense') return uploadCategoryAccess.defense_enabled === true;
  return false;
}

function canSubmitContentCategory(value) {
  const normalized = normalizeContentCategory(value);
  return UPLOAD_IMPLEMENTED_CONTENT_TYPES.has(normalized) && uploadCategoryFlag(normalized);
}

function categoryNeedsAgent(category = selectedCategory) {
  return normalizeContentCategory(category) !== 'wallbang';
}

function categoryNeedsAbility(category = selectedCategory) {
  return normalizeContentCategory(category) === 'lineup';
}

function agentAllowedForCategory(agent, category = selectedCategory) {
  if (normalizeContentCategory(category) !== 'defense') return true;
  // The platform-specific agent config is the source of truth now. The
  // legacy defense_agents list is only a fallback until site configs load.
  if (agentCategoryAvailability.has('defense')) return true;
  if (uploadDefenseAgents.size > 0) return uploadDefenseAgents.has(agent?.displayName || '');
  const roleName = String(agent?.role?.displayName || agent?.role?.displayNameLocalized || '').toLowerCase();
  if (roleName.includes('duelist') || roleName.includes('дуэлян')) return false;
  return !DEFENSE_EXCLUDED_AGENTS.has(agent?.displayName || '');
}

function agentsForCurrentCategory() {
  const category = normalizeContentCategory(selectedCategory);
  const availability = agentCategoryAvailability.get(category);
  return agentsList.filter(agent =>
    agentAllowedForCategory(agent, category) &&
    (!availability || availability.get(agent.displayName) !== false)
  );
}

function applyUploadCategoryAccess(data = {}) {
  const activeCategory = normalizeContentCategory(selectedCategory || '');
  const activeWasEnabled = activeCategory
    ? uploadCategoryFlag(activeCategory)
    : false;
  uploadCategoryAccess = {
    lineup_visible: data.lineup_visible !== false,
    lineup_enabled: data.lineup_enabled !== false,
    lineup_staff_enabled: data.lineup_staff_enabled === true,
    combo_visible: data.combo_visible !== false,
    combo_enabled: data.combo_enabled === true,
    combo_staff_enabled: data.combo_staff_enabled === true,
    wallbang_visible: data.wallbang_visible !== false,
    wallbang_enabled: data.wallbang_enabled === true,
    wallbang_staff_enabled: data.wallbang_staff_enabled === true,
    defense_visible: data.defense_visible !== false,
    defense_enabled: data.defense_enabled === true,
    defense_staff_enabled: data.defense_staff_enabled === true,
  };
  const activeIsEnabled = activeCategory
    ? uploadCategoryFlag(activeCategory)
    : false;

  if (
    uploadCategoryAccessReady &&
    activeCategory &&
    activeWasEnabled &&
    !activeIsEnabled
  ) {
    const saved = saveCurrentDraftCopy(
      'Доступ к категории закрыт. Работа сохранена в черновики',
    );
    resetUploadForm();
    if (!saved) {
      toast('Доступ к категории закрыт. Форма очищена', 'w');
    }
  }
  uploadCategoryAccessReady = true;
  updateUploadCategoryButtons();
  renderAuthorTrainingProgress();
}

function watchUploadCategoryAccess(reference, initialSnapshot) {
  uploadCategoryAccessUnsub?.();
  uploadCategoryAccessUnsub = null;
  if (initialSnapshot?.exists()) {
    applyUploadCategoryAccess(initialSnapshot.data());
  } else {
    applyUploadCategoryAccess({});
  }
  uploadCategoryAccessUnsub = onSnapshot(
    reference,
    snapshot => {
      applyUploadCategoryAccess(snapshot.exists() ? snapshot.data() : {});
    },
    error => console.warn('watchUploadCategoryAccess', error.message),
  );
}

function agentConfigId(name) { return String(name || '').replaceAll('/', '_'); }

function agentAbilityEnabled(agent, ability, category = selectedCategory) {
  const normalizedCategory = normalizeContentCategory(category);
  const stored = agentCategoryAbilityConfigs.get(`${normalizedCategory}|${agent?.displayName || ''}`);
  if (!stored) return true;
  const normalizedAbility = normalizeAbilityName(agent.displayName, ability.displayName, ability.slot);
  return stored[normalizedAbility] !== false && stored[ability.displayName] !== false;
}

function loadAgentCategoryAvailability(category = selectedCategory, { force = false } = {}) {
  const normalized = normalizeContentCategory(category);
  if (!normalized || normalized === 'wallbang') return Promise.resolve();
  if (force) {
    agentCategoryAvailability.delete(normalized);
    for (const key of agentCategoryAbilityConfigs.keys()) {
      if (key.startsWith(`${normalized}|`)) agentCategoryAbilityConfigs.delete(key);
    }
  }
  if (agentCategoryAvailability.has(normalized)) return Promise.resolve();
  if (agentCategoryLoadPromises.has(normalized)) return agentCategoryLoadPromises.get(normalized);
  const generation = agentCategoryConfigGeneration;
  const promise = Promise.all(agentsList.map(async agent => {
    let snap = await getDoc(doc(db, 'agents_config', agentConfigId(agent.displayName), 'categories', `${normalized}__site`));
    if (!snap.exists()) snap = await getDoc(doc(db, 'agents_config', agentConfigId(agent.displayName), 'categories', normalized));
    const data = snap.exists() ? snap.data() : {};
    const abilities = data.abilities || {};
    return [agent.displayName, data.visible !== false, abilities];
  })).then(entries => {
    if (generation !== agentCategoryConfigGeneration) return;
    const availabilityEntries = entries.map(([name, enabled]) => [name, enabled]);
    entries.forEach(([name, , abilities]) => {
      agentCategoryAbilityConfigs.set(`${normalized}|${name}`, abilities);
    });
    agentCategoryAvailability.set(normalized, new Map(availabilityEntries));
    if (normalizeContentCategory(selectedCategory) !== normalized) return;
    const selectedStillAllowed = !selectedAgent || availabilityEntries.some(([name, enabled]) => name === selectedAgent && enabled);
    if (!selectedStillAllowed) {
      selectedAgent = null;
      selectedAbility = null;
      document.getElementById('abilities-row').innerHTML = '<span class="ability-empty-hint">Сначала выбери агента</span>';
    }
    renderAgentsGrid();
    validateForm();
  }).catch(error => {
    console.warn('agent category config', normalized, error);
  }).finally(() => {
    if (agentCategoryLoadPromises.get(normalized) === promise) {
      agentCategoryLoadPromises.delete(normalized);
    }
  });
  agentCategoryLoadPromises.set(normalized, promise);
  return promise;
}

function softlyRevealTechnicalUpdate(element) {
  if (!element || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  element.getAnimations().forEach(animation => animation.cancel());
  element.animate(
    [
      { opacity: .55, transform: 'translateY(4px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ],
    { duration: 240, easing: 'cubic-bezier(.22,1,.36,1)' },
  );
}

async function refreshUploadReferenceConfigs(changedFields, nextVersions) {
  const refreshWeapons = changedFields.includes('weapon_whitelist');
  const refreshDefense = changedFields.includes('defense_agents');
  const refreshMap = changedFields.includes('map_annotations');
  try {
    const [weaponsSnap, defenseSnap] = await Promise.all([
      refreshWeapons ? getDoc(doc(db, 'settings', 'weapon_whitelist')) : null,
      refreshDefense ? getDoc(doc(db, 'settings', 'defense_agents')) : null,
    ]);
    if (refreshWeapons) {
      uploadWeaponWhitelist = weaponsSnap?.exists() && Array.isArray(weaponsSnap.data().weapons)
        ? weaponsSnap.data().weapons.filter(Boolean)
        : [...DEFAULT_WALLBANG_WEAPONS];
      renderWallbangWeapons();
      softlyRevealTechnicalUpdate(document.getElementById('wallbang-weapons'));
      validateForm();
    }
    if (refreshDefense) {
      uploadDefenseAgents = new Set(
        defenseSnap?.exists() && Array.isArray(defenseSnap.data().agents)
          ? defenseSnap.data().agents.filter(Boolean)
          : [],
      );
      if (normalizeContentCategory(selectedCategory) === 'defense') renderAgentsGrid();
    }
    if (refreshWeapons || refreshDefense) {
      let cached = {};
      try { cached = JSON.parse(localStorage.getItem(UPLOAD_CONFIG_CACHE_KEY) || '{}') || {}; } catch (_) {}
      try {
        localStorage.setItem(UPLOAD_CONFIG_CACHE_KEY, JSON.stringify({
          ...cached,
          weaponVersion: String(nextVersions.weapon_whitelist || ''),
          defenseVersion: String(nextVersions.defense_agents || ''),
          weapons: uploadWeaponWhitelist,
          defenseAgents: [...uploadDefenseAgents],
        }));
      } catch (_) {}
    }
    if (refreshMap) {
      mapAnnotationsPromise = null;
      mapAnnotationsReady = false;
      await loadMapAnnotations();
      softlyRevealTechnicalUpdate(document.getElementById('map-site-labels'));
    }
  } catch (error) {
    console.warn('refreshUploadReferenceConfigs', error.message);
  }
}

function watchUploadConfigVersions(reference, initialData = {}) {
  uploadConfigVersionsUnsub?.();
  uploadConfigVersionsUnsub = null;
  uploadConfigVersions = { ...initialData };
  uploadConfigVersionsUnsub = onSnapshot(
    reference,
    snapshot => {
      const nextVersions = snapshot.exists() ? snapshot.data() : {};
      const watchedFields = ['ability_config', 'weapon_whitelist', 'defense_agents', 'map_annotations'];
      const changedFields = watchedFields.filter(field =>
        String(nextVersions[field] || '') !== String(uploadConfigVersions[field] || '')
      );
      if (!changedFields.length) return;
      uploadConfigVersions = { ...nextVersions };
      if (changedFields.includes('ability_config')) {
        agentCategoryConfigGeneration += 1;
        agentCategoryAvailability.clear();
        agentCategoryAbilityConfigs.clear();
        agentCategoryLoadPromises.clear();
        const activeCategory = normalizeContentCategory(selectedCategory);
        if (!activeCategory || activeCategory === 'wallbang' || !agentsList.length) {
          renderAgentsGrid();
        } else {
          loadAgentCategoryAvailability(activeCategory, { force: true });
        }
      }
      void refreshUploadReferenceConfigs(changedFields, nextVersions);
    },
    error => console.warn('watchUploadConfigVersions', error.message),
  );
}

function selectedWallbangWeapons() {
  return [...document.querySelectorAll('#wallbang-weapons input[type="checkbox"]:checked')]
    .map(input => input.value)
    .filter(Boolean);
}

function defenseSiteValue() {
  return (document.getElementById('defense-site')?.value || '').trim();
}

const THREE_SITE_MAPS = new Set(['Haven', 'Lotus']);

function defenseSitesForMap(mapName) {
  if (!mapName) return [];
  return THREE_SITE_MAPS.has(mapName) ? ['A', 'B', 'C'] : ['A', 'B'];
}

function renderDefenseSiteOptions(preferredValue = '') {
  const input = document.getElementById('defense-site');
  const picker = document.getElementById('defense-site-row');
  if (!input || !picker) return;
  const mapName = document.getElementById('sel-map')?.value || '';
  const sites = defenseSitesForMap(mapName);
  const requested = String(preferredValue || input.value || '').trim().toUpperCase();
  input.value = sites.includes(requested) ? requested : '';
  picker.innerHTML = sites.length
    ? sites.map(site => `<button class="pill-btn ${input.value === site ? 'selected' : ''}" type="button" data-defense-site="${site}">${site} Site</button>`).join('')
    : '<span class="defense-site-empty">Сначала выбери карту</span>';
}

document.getElementById('defense-site-row')?.addEventListener('click', event => {
  const button = event.target.closest('[data-defense-site]');
  if (!button) return;
  const input = document.getElementById('defense-site');
  input.value = button.dataset.defenseSite || '';
  event.currentTarget.querySelectorAll('[data-defense-site]').forEach(item => {
    item.classList.toggle('selected', item === button);
  });
  validateForm();
  _saveDraft();
});

function defenseNumberValue() {
  // Internal sequence value retained only for backwards-compatible payloads.
  return 1;
}

function hasValidDefenseZoom() {
  return !!(
    defenseZoomArea &&
    Number.isFinite(defenseZoomArea.x) &&
    Number.isFinite(defenseZoomArea.y) &&
    defenseZoomArea.width > 0 &&
    defenseZoomArea.height > 0
  );
}

function categoryExtrasValid(category = selectedCategory) {
  const normalized = normalizeContentCategory(category);
  if (normalized === 'wallbang') {
    return selectedWallbangWeapons().length > 0 && wallbangTargetX !== null && wallbangTargetY !== null;
  }
  if (normalized === 'defense') {
    return !!defenseSiteValue() && hasValidDefenseZoom() && defenseAbilities.length > 0;
  }
  if (normalized === 'lineup') {
    return extraAbilityTrajectories.every(item =>
      item?.ability && normalizeTrajectoryPoints(item.trajectory).length >= 2
    );
  }
  return true;
}

window.getUploadProductionProgressState = function() {
  const category = normalizeContentCategory(selectedCategory || '');
  const mapReady = !!document.getElementById('sel-map')?.value;
  const categoryReady = !!category;
  const agentReady = !categoryNeedsAgent(category) || !!selectedAgent;
  const videoReady = !!videoUrl;
  const screenshotsReady = screenshots.length > 0 &&
    !screenshots.some(item => item.uploading);
  const abilityReady = !categoryNeedsAbility(category) || !!selectedAbility;
  const positionReady = category === 'defense' || markerX !== null;
  const editorReady = screenshotsReady &&
    abilityReady &&
    positionReady &&
    categoryExtrasValid(category);
  const titleValue = document.getElementById('inp-title')?.value.trim() || '';
  const descriptionValue = document.getElementById('inp-desc')?.value.trim() || '';
  const titleReady = titleValue.length > 0 && titleValue.length <= 100 && !hasCyrillic(titleValue);
  const descriptionReady = descriptionValue.length <= 1000;
  // The submit button intentionally stays clickable to show missing fields.
  // Its data-ready flag is the actual full-form validation result.
  const submitReady = document.getElementById('btn-submit')?.dataset.ready === 'true';
  const ready = [
    mapReady && categoryReady && agentReady,
    videoReady,
    editorReady,
    titleReady && descriptionReady,
    submitReady,
  ];
  return {
    category,
    ready,
    count: ready.filter(Boolean).length,
  };
};

function renderWallbangWeapons() {
  const grid = document.getElementById('wallbang-weapons');
  if (!grid) return;
  const selected = new Set(selectedWallbangWeapons());
  const weapons = uploadWeaponWhitelist.length ? uploadWeaponWhitelist : DEFAULT_WALLBANG_WEAPONS;
  grid.innerHTML = weapons.map(weapon => `
    <label class="weapon-check">
      <input type="checkbox" value="${esc(weapon)}" ${selected.has(weapon) ? 'checked' : ''}>
      <span>${esc(weapon)}</span>
    </label>
  `).join('');
  grid.querySelectorAll('input').forEach(input => {
    input.addEventListener('change', () => { validateForm(); _saveDraft(); });
  });
}

function abilityPlacementLimit(agentName, abilityName, slot = '') {
  const key = `${agentName || ''} ${abilityName || ''} ${slot || ''}`.toLowerCase();
  if (/clove/.test(key) && /ruse|улов|дым|smoke/.test(key)) return 2;
  if (/brimstone/.test(key) && /sky smoke|дым/.test(key)) return 3;
  if (/omen/.test(key) && /dark cover|тёмн|темн/.test(key)) return 2;
  if (/viper/.test(key) && /toxic screen|завес/.test(key)) return 1;
  if (/viper/.test(key) && /poison cloud|облак/.test(key)) return 1;
  if (/cypher/.test(key) && /trapwire|растяж/.test(key)) return 2;
  if (/cypher/.test(key) && /cyber cage|клет/.test(key)) return 2;
  if (/killjoy/.test(key) && /alarmbot|бот/.test(key)) return 1;
  if (/killjoy/.test(key) && /turret|турел/.test(key)) return 1;
  if (/killjoy/.test(key) && /nanoswarm|нанос/.test(key)) return 2;
  if (/deadlock/.test(key) && /sonic|звуков|датчик|сенсор|sensor/.test(key)) return 2;
  if (/sage/.test(key) && /barrier|барьер|стен/.test(key)) return 1;
  if (/sage/.test(key) && /slow|замед/.test(key)) return 2;
  if (/vyse/.test(key) && /razorvine|лоз/.test(key)) return 2;
  if (/vyse/.test(key) && /shear|стен/.test(key)) return 1;
  if (/ultimate/.test(String(slot).toLowerCase())) return 1;
  return 1;
}

function defensePlacementShape(agentName, abilityName, slot = '') {
  const key = `${agentName || ''} ${abilityName || ''} ${slot || ''}`.toLowerCase();
  if (/deadlock/.test(key) && /barrier mesh|барьер|сетка/.test(key)) {
    return { kind: 'mesh_burst', points: 1, radius: 0.097, source: 'valoplant' };
  }
  if (/deadlock/.test(key) && /gravnet|гравинет|грав.*сет/.test(key)) {
    return { kind: 'net_area', points: 1, radius: 0.04335, source: 'valoplant' };
  }
  if (/deadlock/.test(key) && /sonic|звуков|датчик|сенсор|sensor/.test(key)) {
    return { kind: 'sensor_rect', points: 2, width: 0.12, height: 0.08, rotation: 0, anchor: 'edge_midpoints', source: 'range_config' };
  }
  if (/cypher/.test(key) && /trapwire|растяж/.test(key)) {
    return { kind: 'line_segment', points: 2 };
  }
  if (/cypher/.test(key) && /cyber cage|киберклет|клетк|cage/.test(key)) {
    return { kind: 'circle_area', points: 1, radius: 0.026, source: 'valoplant-adjusted' };
  }
  if (/viper/.test(key) && /toxic screen|завес/.test(key)) {
    return { kind: 'line_segment', points: 2 };
  }
  if (/viper/.test(key) && /poison cloud|ядовит.*облак|облак/.test(key)) {
    return { kind: 'circle_area', points: 1, radius: 0.015275, theme: 'viper' };
  }
  if (/viper/.test(key) && /snake bite|змеин|укус/.test(key)) {
    return { kind: 'circle_area', points: 1, radius: 0.0165, theme: 'viper' };
  }
  if (/viper/.test(key) && /viper.*pit|гнезд.*гадюк|ultimate/.test(key)) {
    return { kind: 'circle_area', points: 1, radius: 0.0475, theme: 'viper-ult' };
  }
  if (/sage/.test(key) && /barrier|барьер|стен/.test(key)) {
    return { kind: 'wall_sections', points: 2, width: 0.16, height: 0.032, rotation: 0, anchor: 'edge_midpoints', source: 'range_config' };
  }
  return { kind: 'point', points: 1 };
}

function selectedAgentAbilities() {
  const agent = agentsList.find(a => a.displayName === selectedAgent);
  if (!agent) return [];
  return (agent.abilities || [])
    .filter(ab => ab.displayIcon && ab.slot !== 'Passive' && agentAbilityEnabled(agent, ab, selectedCategory))
    .map(ab => ({
      agent: agent.displayName,
      ability: normalizeAbilityName(agent.displayName, ab.displayName, ab.slot),
      slot: ab.slot || '',
      icon: proxiedValorantUrl(ab.displayIcon || ''),
      limit: abilityPlacementLimit(agent.displayName, normalizeAbilityName(agent.displayName, ab.displayName, ab.slot), ab.slot || ''),
      shape: defensePlacementShape(agent.displayName, normalizeAbilityName(agent.displayName, ab.displayName, ab.slot), ab.slot || ''),
    }));
}

function abilityEffectShape(agentName, abilityName, slot = '') {
  const key = `${agentName || ''} ${abilityName || ''} ${slot || ''}`.toLowerCase();
  if (/viper/.test(key) && /toxic screen|токсичн.*завес|завес/.test(key)) {
    return { effect_shape: 'line', effect_width: 0.018 };
  }
  if (/sova/.test(key) && /hunter|гнев охот/.test(key)) {
    return { effect_shape: 'none', effect_width: 0 };
  }
  return { effect_shape: 'circle', effect_width: 0 };
}

function extraTrajectoriesEnabled(category = selectedCategory) {
  return normalizeContentCategory(category) === 'lineup';
}

function normalizeTrajectoryPoints(points) {
  return (Array.isArray(points) ? points : [])
    .map(p => ({ x: Number(p?.x), y: Number(p?.y) }))
    .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
    .map(p => ({ x: clamp01(p.x), y: clamp01(p.y) }));
}

function normalizeExtraAbilityItem(item, index = 0) {
  const ability = String(item?.ability || '').trim();
  if (!ability) return null;
  const catalog = selectedAgentAbilities().find(ab => ab.ability === ability);
  const effect = abilityEffectShape(selectedAgent, ability, item?.slot || catalog?.slot || '');
  return {
    order: Number(item?.order || index + 1),
    ability,
    slot: item?.slot || catalog?.slot || '',
    // The ability name is the source of truth. Older drafts could carry the
    // primary ability icon in an extra trajectory, so prefer the live catalog.
    icon: catalog?.icon || item?.icon || '',
    trajectory: normalizeTrajectoryPoints(item?.trajectory),
    sova_charge: Math.max(0, Math.min(3, Number(item?.sova_charge ?? item?.sovaCharge ?? 3))),
    sova_bounces: Math.max(0, Math.min(2, Number(item?.sova_bounces ?? item?.sovaBounces ?? 0))),
    range_radius: Number(item?.range_radius || 0),
    effect_shape: effect.effect_shape || item?.effect_shape || 'circle',
    effect_width: Number(effect.effect_width ?? item?.effect_width ?? 0),
    note: item?.note || '',
  };
}

function activeExtraAbility() {
  return Number.isInteger(selectedExtraAbilityIndex)
    ? extraAbilityTrajectories[selectedExtraAbilityIndex] || null
    : null;
}

function activeTrajectoryPoints() {
  return activeExtraAbility()?.trajectory || trajectoryPoints;
}

function setActiveTrajectoryPoints(points) {
  const extra = activeExtraAbility();
  if (extra) extra.trajectory = points;
  else trajectoryPoints = points;
}

function trajectoryFromMarkerFor(points = trajectoryPoints) {
  const clean = normalizeTrajectoryPoints(points);
  if (markerX === null || markerY === null || !clean.length) return clean;
  const path = clean.map(p => ({ ...p }));
  path[0] = { x: markerX, y: markerY };
  return path;
}

function trajectoryForSave(item = null) {
  const points = normalizeTrajectoryPoints(item?.trajectory ?? trajectoryPoints);
  return item ? points : trajectoryFromMarkerFor(points);
}

function extraAbilityIcon(item) {
  if (!item) return '';
  const ability = String(item.ability || '').trim();
  const catalog = selectedAgentAbilities().find(ab => ab.ability === ability);
  return catalog?.icon || item.icon || '';
}

function limitPrimaryAbilityExtras(items = extraAbilityTrajectories) {
  let primaryCopies = 0;
  return (Array.isArray(items) ? items : []).filter(item => {
    if (item?.ability !== selectedAbility) return true;
    primaryCopies += 1;
    return primaryCopies <= 1;
  }).slice(0, 2).map((item, index) => ({ ...item, order: index + 1 }));
}

function extraSovaParametersHtml(item, index) {
  if (!isSovaArrowSelection(selectedAgent, item.ability)) return '';
  const charge = Math.max(0, Math.min(3, Number(item.sova_charge ?? 3)));
  const bounces = Math.max(0, Math.min(2, Number(item.sova_bounces ?? 0)));
  return `
    <div class="sova-shot-panel extra-sova-shot-panel">
      <div class="sova-shot-heading">🏹 ПАРАМЕТРЫ · ДОП. ${index + 1}</div>
      <label class="sova-shot-control">
        <span class="sova-shot-label">Сила натяжения</span>
        <div class="sova-charge-slider ${charge >= 3 ? 'is-max' : ''}">
          <input type="range" min="0" max="3" step="0.05" value="${charge}"
            data-extra-sova-charge="${index}" style="--sova-charge-pct:${charge / 3 * 100}%" aria-label="Сила натяжения дополнительной стрелы ${index + 1}">
          <div class="sova-charge-ticks" aria-hidden="true"><span></span><span></span></div>
          <span class="sova-charge-caption">ЗАРЯД</span>
        </div>
      </label>
      <div class="sova-bounce-row">
        <span class="sova-bounce-label">ОТСКОКИ</span>
        <div class="sova-bounce-picker">
          <button type="button" class="${bounces >= 1 ? 'active' : ''}" data-extra-sova-bounce="${index}" data-bounce="1" aria-label="Первый отскок"><span class="bounce-diamond"></span></button>
          <button type="button" class="${bounces >= 2 ? 'active' : ''}" data-extra-sova-bounce="${index}" data-bounce="2" aria-label="Второй отскок"><span class="bounce-diamond"></span></button>
        </div>
      </div>
    </div>`;
}

function renderExtraAbilityPanel() {
  const panel = document.getElementById('extra-abilities-panel');
  const toolbox = document.getElementById('lineup-toolbox');
  const mapContainer = document.getElementById('map-container');
  const picker = document.getElementById('extra-ability-picker');
  const list = document.getElementById('extra-ability-list');
  const sovaPanels = document.getElementById('extra-sova-shot-panels');
  if (!panel || !picker || !list) return;
  extraAbilityTrajectories = limitPrimaryAbilityExtras();
  const enabled = extraTrajectoriesEnabled() && !!selectedAgent && !!selectedAbility;
  panel.toggleAttribute('hidden', !enabled);
  toolbox?.toggleAttribute('hidden', !enabled);
  mapContainer?.classList.toggle('lineup-workbench', enabled);
  if (!enabled) {
    picker.innerHTML = '';
    list.innerHTML = '';
    if (sovaPanels) sovaPanels.innerHTML = '';
    return;
  }
  if (sovaPanels) {
    sovaPanels.innerHTML = extraAbilityTrajectories
      .map((item, idx) => extraSovaParametersHtml(item, idx))
      .join('');
  }
  // The same ability may have several independent throws (for example,
  // Sova's two Shock Darts). Keep the primary ability available so it can be
  // added as Extra 1 and Extra 2 with its own trajectory each time.
  const abilities = selectedAgentAbilities();
  const atLimit = extraAbilityTrajectories.length >= 2;
  picker.innerHTML = abilities.length
    ? abilities.map(ab => {
        const primaryCopyExists = ab.ability === selectedAbility &&
          extraAbilityTrajectories.some(item => item.ability === selectedAbility);
        return `
          <button class="ability-btn extra-ability-pick" type="button"
            data-extra-add="${esc(ab.ability)}" title="${primaryCopyExists ? 'Основная и дополнительная траектории уже добавлены' : `Добавить: ${esc(ab.ability)}`}" ${(atLimit || primaryCopyExists) ? 'disabled' : ''}>
            <img src="${esc(ab.icon)}" alt="">
            <span>${esc(ab.ability.split(' ')[0])}</span>
          </button>
        `;
      }).join('')
    : '<span style="color:var(--text2);font-size:12px;">Нет доступных доп. абилок</span>';
  picker.querySelectorAll('[data-extra-add]').forEach(btn => {
    btn.addEventListener('click', () => addExtraAbilityByName(btn.dataset.extraAdd || ''));
  });
  const mainCatalog = selectedAgentAbilities().find(ab => ab.ability === selectedAbility);
  const mainPoints = normalizeTrajectoryPoints(trajectoryPoints).length;
  const mainRow = `
    <div class="extra-ability-item ${selectedExtraAbilityIndex === null ? 'selected' : ''}">
      <span class="extra-ability-num">★</span>
      <button class="extra-ability-main" type="button" data-extra-main title="Рисовать основную траекторию">
        ${mainCatalog?.icon ? `<img src="${esc(mainCatalog.icon)}" alt="">` : ''}
        <span>
          <span class="extra-ability-name">Основная · ${esc(selectedAbility)}</span>
          <span class="extra-ability-meta">${mainPoints >= 2 ? `${mainPoints} точек` : 'траектория не задана'}</span>
        </span>
      </button>
      <span></span>
    </div>`;
  list.innerHTML = mainRow + (extraAbilityTrajectories.length
    ? extraAbilityTrajectories.map((item, idx) => {
        const points = normalizeTrajectoryPoints(item.trajectory).length;
        const selected = selectedExtraAbilityIndex === idx;
        return `
          <div class="extra-ability-item ${selected ? 'selected' : ''}" data-extra-index="${idx}">
            <span class="extra-ability-num">${idx + 1}</span>
            <button class="extra-ability-main" type="button" data-extra-select="${idx}" title="Рисовать траекторию: ${esc(item.ability)}">
              ${extraAbilityIcon(item) ? `<img src="${esc(extraAbilityIcon(item))}" alt="">` : ''}
              <span>
                <span class="extra-ability-name">${esc(item.ability)}</span>
                <span class="extra-ability-meta">${points >= 2 ? `${points} точек` : 'траектория не задана'}</span>
              </span>
            </button>
            <span class="extra-ability-actions">
              <button class="extra-ability-action" type="button" data-extra-up="${idx}" title="Выше">↑</button>
              <button class="extra-ability-action" type="button" data-extra-down="${idx}" title="Ниже">↓</button>
              <button class="extra-ability-action" type="button" data-extra-remove="${idx}" title="Удалить">×</button>
            </span>
          </div>
        `;
      }).join('')
    : '<span style="color:var(--text2);font-size:12px;">Нажми абилку выше, чтобы добавить доп. траекторию</span>');
  list.querySelector('[data-extra-main]')?.addEventListener('click', () => {
    selectedExtraAbilityIndex = null;
    if (markerX !== null && markerY !== null) setMarkerPosition(markerX, markerY);
    updateMarkerIcon();
    setMapMode('trajectory');
    renderExtraAbilityPanel();
    renderSovaShotPanel();
    renderTrajectory();
    _saveDraft();
  });
  list.querySelectorAll('[data-extra-select]').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedExtraAbilityIndex = Number(btn.dataset.extraSelect);
      const start = activeExtraAbility()?.trajectory?.[0];
      if (start) setMarkerPosition(start.x, start.y);
      updateMarkerIcon();
      setMapMode(start ? 'trajectory' : 'position');
      renderExtraAbilityPanel();
      renderSovaShotPanel();
      renderTrajectory();
      _saveDraft();
    });
  });
  list.querySelectorAll('[data-extra-remove]').forEach(btn => {
    btn.addEventListener('click', event => {
      event.stopPropagation();
      const idx = Number(btn.dataset.extraRemove);
      extraAbilityTrajectories.splice(idx, 1);
      extraAbilityTrajectories.forEach((item, orderIdx) => { item.order = orderIdx + 1; });
      if (selectedExtraAbilityIndex === idx) selectedExtraAbilityIndex = null;
      else if (selectedExtraAbilityIndex > idx) selectedExtraAbilityIndex -= 1;
      renderExtraAbilityPanel();
      renderSovaShotPanel();
      renderTrajectory();
      validateForm(); _saveDraft();
    });
  });
  list.querySelectorAll('[data-extra-up],[data-extra-down]').forEach(btn => {
    btn.addEventListener('click', event => {
      event.stopPropagation();
      const isUp = btn.hasAttribute('data-extra-up');
      const idx = Number(isUp ? btn.dataset.extraUp : btn.dataset.extraDown);
      const next = isUp ? idx - 1 : idx + 1;
      if (next < 0 || next >= extraAbilityTrajectories.length) return;
      [extraAbilityTrajectories[idx], extraAbilityTrajectories[next]] = [extraAbilityTrajectories[next], extraAbilityTrajectories[idx]];
      extraAbilityTrajectories.forEach((item, orderIdx) => { item.order = orderIdx + 1; });
      if (selectedExtraAbilityIndex === idx) selectedExtraAbilityIndex = next;
      else if (selectedExtraAbilityIndex === next) selectedExtraAbilityIndex = idx;
      renderExtraAbilityPanel();
      renderTrajectory();
      _saveDraft();
    });
  });
  sovaPanels?.querySelectorAll('[data-extra-sova-charge]').forEach(input => {
    input.addEventListener('input', () => {
      const item = extraAbilityTrajectories[Number(input.dataset.extraSovaCharge)];
      if (!item) return;
      item.sova_charge = Math.max(0, Math.min(3, Number(input.value) || 0));
      input.style.setProperty('--sova-charge-pct', `${item.sova_charge / 3 * 100}%`);
      input.closest('.sova-charge-slider')?.classList.toggle('is-max', item.sova_charge >= 3);
      _saveDraft();
    });
  });
  sovaPanels?.querySelectorAll('[data-extra-sova-bounce]').forEach(button => {
    button.addEventListener('click', event => {
      event.stopPropagation();
      const item = extraAbilityTrajectories[Number(button.dataset.extraSovaBounce)];
      if (!item) return;
      const bounce = Number(button.dataset.bounce);
      item.sova_bounces = item.sova_bounces === bounce ? bounce - 1 : bounce;
      renderExtraAbilityPanel();
      _saveDraft();
    });
  });
}

function addExtraAbilityByName(abilityName) {
  if (!extraTrajectoriesEnabled()) return;
  if (extraAbilityTrajectories.length >= 2) {
    toast('Пока максимум 2 дополнительные траектории', 'w');
    return;
  }
  const ab = selectedAgentAbilities().find(item => item.ability === abilityName);
  if (!ab) {
    toast('Выбери дополнительную абилку', 'w');
    return;
  }
  const effect = abilityEffectShape(selectedAgent, ab.ability, ab.slot);
  extraAbilityTrajectories.push({
    order: extraAbilityTrajectories.length + 1,
    ability: ab.ability,
    slot: ab.slot || '',
    icon: ab.icon || '',
    trajectory: [],
    sova_charge: 3,
    sova_bounces: 0,
    range_radius: 0,
    effect_shape: effect.effect_shape,
    effect_width: effect.effect_width,
    note: '',
  });
  selectedExtraAbilityIndex = extraAbilityTrajectories.length - 1;
  setMapMode('position');
  renderExtraAbilityPanel();
  renderSovaShotPanel();
  renderTrajectory();
  validateForm(); _saveDraft();
}

function placedDefenseCount(abilityName) {
  return defenseAbilities.filter(item => item.ability === abilityName).length;
}

function normalizedWallSections(value) {
  const sections = [...new Set((Array.isArray(value) ? value : [1,2,3,4]).map(Number))]
    .filter(section => Number.isInteger(section) && section >= 1 && section <= 4)
    .sort((a,b) => a-b);
  return sections.length ? sections : [1];
}

function isSageWallShape(item) {
  return defenseShapeKind(item) === 'wall_sections';
}

function selectedSageWallItem() {
  const placed = Number.isInteger(selectedDefenseMarkerIndex) ? defenseAbilities[selectedDefenseMarkerIndex] : null;
  if (placed && isSageWallShape(placed)) return placed;
  return selectedDefenseAbility?.shape?.kind === 'wall_sections' ? selectedDefenseAbility : null;
}

function renderSageWallOptions() {
  const panel = document.getElementById('sage-wall-options');
  if (!panel) return;
  const item = selectedSageWallItem();
  panel.hidden = !item;
  if (!item) return;
  const active = normalizedWallSections(item.active_sections);
  panel.querySelectorAll('[data-wall-section]').forEach(button => {
    button.setAttribute('aria-pressed', String(active.includes(Number(button.dataset.wallSection))));
  });
  const count = document.getElementById('sage-wall-section-count');
  if (count) count.textContent = `${active.length} из 4 секций`;
  const handlesToggle = document.getElementById('sage-wall-handles-toggle');
  if (handlesToggle) {
    handlesToggle.textContent = sageWallHandlesHidden ? 'Показать точки' : 'Скрыть точки';
    handlesToggle.setAttribute('aria-pressed', String(sageWallHandlesHidden));
  }
  if (abilityName === selectedAbility && extraAbilityTrajectories.some(item => item.ability === selectedAbility)) {
    toast('Для основной способности доступна только одна дополнительная траектория', 'w');
    return;
  }
}

document.getElementById('sage-wall-handles-toggle')?.addEventListener('click', event => {
  event.preventDefault();
  event.stopPropagation();
  sageWallHandlesHidden = !sageWallHandlesHidden;
  renderSageWallOptions();
  renderDefenseAbilityMarkers();
  _saveDraft();
});

document.getElementById('sage-wall-options')?.addEventListener('click', event => {
  const button = event.target.closest('[data-wall-section]');
  const item = selectedSageWallItem();
  if (!button || !item) return;
  const section = Number(button.dataset.wallSection);
  const active = normalizedWallSections(item.active_sections);
  const next = active.includes(section) ? active.filter(value => value !== section) : [...active, section];
  if (!next.length) {
    toast('У стены должна остаться хотя бы одна секция', 'w');
    return;
  }
  item.active_sections = normalizedWallSections(next);
  renderSageWallOptions();
  renderDefenseAbilityMarkers();
  validateForm(); _saveDraft();
});

function renderDefenseAbilityPanel() {
  const row = document.getElementById('defense-ability-row');
  const list = document.getElementById('defense-placed-list');
  if (!row || !list) return;
  const abilities = selectedAgentAbilities();
  renderSageWallOptions();
  if (!abilities.length) {
    row.innerHTML = '<span style="color:var(--text2);font-size:13px;">Сначала выбери агента защиты</span>';
    list.innerHTML = '';
    return;
  }
  if (selectedDefenseAbility && !abilities.some(ab => ab.ability === selectedDefenseAbility.ability)) {
    selectedDefenseAbility = null;
  }
  row.innerHTML = abilities.map(ab => {
    const count = placedDefenseCount(ab.ability);
    const reached = count >= ab.limit;
    const selected = selectedDefenseAbility?.ability === ab.ability;
    return `
      <button class="defense-ability-btn ${selected ? 'selected' : ''} ${reached ? 'limit-reached' : ''}" type="button"
        draggable="false" data-defense-ability="${esc(ab.ability)}" title="${esc(ab.ability)}: ${count}/${ab.limit}">
        <img src="${esc(ab.icon)}" alt="">
        <span>${esc(ab.ability.split(' ')[0])}</span>
        <small>${count}/${ab.limit}</small>
      </button>
    `;
  }).join('');
  row.querySelectorAll('[data-defense-ability]').forEach(btn => {
    btn.addEventListener('click', () => {
      const ab = abilities.find(item => item.ability === btn.dataset.defenseAbility);
      if (!ab) return;
      if (placedDefenseCount(ab.ability) >= ab.limit) {
        toast('Лимит этой способности уже достигнут', 'w');
        return;
      }
      selectedDefenseAbility = ab;
      setMapMode('defenseAbility');
      renderDefenseAbilityPanel();
    });
    btn.addEventListener('pointerdown', event => {
      const ab = abilities.find(item => item.ability === btn.dataset.defenseAbility);
      if (!ab || placedDefenseCount(ab.ability) >= ab.limit) return;
      beginDefenseAbilityDrag(event, ab);
    });
    btn.addEventListener('dragstart', event => {
      const ab = abilities.find(item => item.ability === btn.dataset.defenseAbility);
      if (!ab || placedDefenseCount(ab.ability) >= ab.limit) {
        event.preventDefault();
        return;
      }
      selectedDefenseAbility = ab;
      event.dataTransfer?.setData('text/plain', ab.ability);
      event.dataTransfer?.setData('application/x-defense-ability', ab.ability);
      event.dataTransfer.effectAllowed = 'copy';
      setMapMode('defenseAbility');
      renderDefenseAbilityPanel();
    });
  });
  list.innerHTML = defenseAbilities.length
    ? defenseAbilities.map((item, idx) => `
        <span class="defense-placed-chip ${selectedDefenseMarkerIndex === idx ? 'selected' : ''}" data-select-defense-ability="${idx}" title="${idx + 1}. ${esc(item.ability)}">
          <span class="defense-placed-num">${idx + 1}</span>
          ${item.icon ? `<img src="${esc(item.icon)}" alt="">` : `<span>${esc(item.ability.slice(0, 1))}</span>`}
          ${defenseShapeKind(item) === 'mesh_burst' ? `
            <button type="button" data-resize-defense-ability="${idx}" data-resize-direction="-1" title="Уменьшить пропорционально">−</button>
            <button type="button" data-resize-defense-ability="${idx}" data-resize-direction="1" title="Увеличить пропорционально">+</button>
          ` : ''}
          <button type="button" data-remove-defense-ability="${idx}">×</button>
        </span>
      `).join('')
    : '<span style="color:var(--text2);font-size:12px;">Точек сетапа пока нет</span>';
  list.querySelectorAll('[data-select-defense-ability]').forEach(chip => {
    chip.addEventListener('click', event => {
      if (event.target.closest('[data-remove-defense-ability]')) return;
      selectedDefenseMarkerIndex = Number(chip.dataset.selectDefenseAbility);
      renderDefenseAbilityPanel();
      renderDefenseAbilityMarkers();
    });
  });
  list.querySelectorAll('[data-remove-defense-ability]').forEach(btn => {
    btn.addEventListener('click', event => {
      event.stopPropagation();
      const removed = Number(btn.dataset.removeDefenseAbility);
      defenseAbilities.splice(removed, 1);
      if (selectedDefenseMarkerIndex === removed) selectedDefenseMarkerIndex = null;
      else if (selectedDefenseMarkerIndex > removed) selectedDefenseMarkerIndex -= 1;
      renderDefenseAbilityPanel();
      renderDefenseAbilityMarkers();
      validateForm(); _saveDraft();
    });
  });
  list.querySelectorAll('[data-resize-defense-ability]').forEach(btn => {
    btn.addEventListener('click', event => {
      event.stopPropagation();
      const idx = Number(btn.dataset.resizeDefenseAbility);
      const item = defenseAbilities[idx];
      if (!item || defenseShapeKind(item) !== 'mesh_burst') return;
      const direction = Number(btn.dataset.resizeDirection) || 0;
      const current = Number(item.shape_radius || 0.097);
      item.shape_radius = Math.max(0.045, Math.min(0.16, current + direction * 0.008));
      selectedDefenseMarkerIndex = idx;
      renderDefenseAbilityPanel();
      renderDefenseAbilityMarkers();
      validateForm(); _saveDraft();
    });
  });
}

function renderDefenseAbilityMarkers() {
  const host = document.getElementById('defense-ability-markers');
  if (!host) return;
  const shapeItems = [...defenseAbilities, ...(defenseLineDraft ? [defenseLineDraft] : [])];
  const lines = shapeItems.map((item, idx) => {
    const points = normalizedDefensePoints(item);
    const kind = defenseShapeKind(item);
    if (kind === 'mesh_burst') {
      const center = mapPointToPercent(defenseAbilityCenter(item));
      const canonical = defensePlacementShape(selectedAgent, item.ability, item.slot);
      const radius = Math.max(2, Number(item.shape_radius || canonical.radius || 0.097) * 100);
      const diagonal = radius / Math.sqrt(2);
      const nodes = [[-diagonal, -diagonal], [diagonal, -diagonal], [-diagonal, diagonal], [diagonal, diagonal]];
      return nodes.map(([dx, dy]) => `
        <line class="defense-shape-line-bg" x1="${center.left}%" y1="${center.top}%" x2="${center.left + dx}%" y2="${center.top + dy}%"></line>
        <line class="defense-shape-line mesh" x1="${center.left}%" y1="${center.top}%" x2="${center.left + dx}%" y2="${center.top + dy}%"></line>
        <circle class="defense-mesh-node" cx="${center.left + dx}%" cy="${center.top + dy}%" r="0.75%"></circle>
      `).join('');
    }
    if (kind === 'net_area') {
      const center = mapPointToPercent(defenseAbilityCenter(item));
      const canonical = defensePlacementShape(selectedAgent, item.ability, item.slot);
      const radius = Math.max(2, Number(canonical.radius || 0.04335) * 100);
      return `<circle class="defense-area-shape net" cx="${center.left}%" cy="${center.top}%" r="${radius}%"></circle>
        <circle class="defense-area-net-grid" cx="${center.left}%" cy="${center.top}%" r="${radius}%"></circle>`;
    }
    if (kind === 'sensor_area' || kind === 'sensor_rect' || kind === 'wall_sections') {
      const canonical = defensePlacementShape(selectedAgent, item.ability, item.slot);
      const points = normalizedDefensePoints(item);
      const height = Math.max(.01, Number(item.shape_height || canonical.height || .08));
      const a = points[0], b = points[1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const length = Math.max(.001, Math.hypot(dx, dy));
      const normal = { x:-dy / length * height / 2, y:dx / length * height / 2 };
      const content = mapContentRect();
      const corners = [
        { x:a.x+normal.x, y:a.y+normal.y },
        { x:b.x+normal.x, y:b.y+normal.y },
        { x:b.x-normal.x, y:b.y-normal.y },
        { x:a.x-normal.x, y:a.y-normal.y },
      ].map(mapPointToPercent).map(point => ({ x:point.left * content.wrapWidth / 100, y:point.top * content.wrapHeight / 100 }));
      if (kind === 'wall_sections') {
        const active = normalizedWallSections(item.active_sections);
        const ux = (b.x - a.x) / 4, uy = (b.y - a.y) / 4;
        return active.map(section => {
          const offset = section - 1;
          const start = { x:a.x + ux * offset, y:a.y + uy * offset };
          const end = { x:a.x + ux * (offset + 1), y:a.y + uy * (offset + 1) };
          const block = [
            {x:start.x+normal.x,y:start.y+normal.y},{x:end.x+normal.x,y:end.y+normal.y},
            {x:end.x-normal.x,y:end.y-normal.y},{x:start.x-normal.x,y:start.y-normal.y},
          ].map(mapPointToPercent).map(point => ({x:point.left * content.wrapWidth / 100,y:point.top * content.wrapHeight / 100}));
          return `<polygon class="defense-wall-section" points="${block.map(point => `${point.x},${point.y}`).join(' ')}"></polygon>`;
        }).join('');
      }
      return `<polygon class="defense-sensor-zone" points="${corners.map(point => `${point.x},${point.y}`).join(' ')}"></polygon>`;
    }
    if (kind === 'circle_area') {
      const center = mapPointToPercent(defenseAbilityCenter(item));
      const canonical = defensePlacementShape(selectedAgent, item.ability, item.slot);
      const radius = Math.max(2, Number(item.shape_radius || canonical.radius || 0.026) * 100);
      const theme = canonical.theme || 'cyber-cage';
      return `<circle class="defense-area-shape ${theme}" cx="${center.left}%" cy="${center.top}%" r="${radius}%"></circle>`;
    }
    if (kind !== 'line_segment' || points.length < 2) return '';
    const a = mapPointToPercent(points[0]);
    const b = mapPointToPercent(points[1]);
    const draft = idx >= defenseAbilities.length;
    return `
      <line class="defense-shape-line-bg" x1="${a.left}%" y1="${a.top}%" x2="${b.left}%" y2="${b.top}%"></line>
      <line class="defense-shape-line ${draft ? 'draft' : ''}" x1="${a.left}%" y1="${a.top}%" x2="${b.left}%" y2="${b.top}%"></line>
    `;
  }).join('');
  const draftAnchors = defenseLineDraft && defenseShapeKind(defenseLineDraft) === 'line_segment'
    ? normalizedDefensePoints(defenseLineDraft).map((point, pointIdx) => {
        const pos = mapPointToPercent(point);
        return `<div class="defense-line-anchor draft" style="left:${pos.left}%;top:${pos.top}%;"></div>`;
      }).join('')
    : '';
    const markers = defenseAbilities.map((item, idx) => {
    const shapeKind = defenseShapeKind(item);
    const isLine = shapeKind === 'line_segment';
    const isSensor = shapeKind === 'sensor_rect' || shapeKind === 'wall_sections';
    const hasEndpoints = isLine || isSensor;
    const markerShape = defensePlacementShape(selectedAgent, item.ability, item.slot);
    const isBareArea = defenseShapeKind(item) === 'circle_area' && !markerShape.theme;
    const points = normalizedDefensePoints(item);
    const center = defenseAbilityCenter(item);
    const centerPos = mapPointToPercent(center);
    const hideWallAnchors = shapeKind === 'wall_sections' && sageWallHandlesHidden;
    const anchors = hasEndpoints && !hideWallAnchors ? points.map((point, pointIdx) => {
      const pos = mapPointToPercent(point);
      const sensorRole = isSensor ? (pointIdx === 0 ? ' sensor-pivot' : ' sensor-rotate') : '';
      const title = isSensor ? (pointIdx === 0 ? 'Белая точка: переместить сенсор' : 'Красная точка: повернуть и изменить длину') : `Край ${pointIdx + 1}: ${item.ability}`;
      return `<div class="defense-line-anchor${sensorRole} ${selectedDefenseMarkerIndex === idx ? 'selected' : ''}" data-defense-line-index="${idx}" data-defense-line-point="${pointIdx}" style="left:${pos.left}%;top:${pos.top}%;" title="${esc(title)}"></div>`;
    }).join('') : '';
    const meshAnchors = ['mesh_burst','sensor_area'].includes(defenseShapeKind(item)) && selectedDefenseMarkerIndex === idx
      ? [[-1,-1],[1,-1],[-1,1],[1,1]].map(([sx,sy]) => { const r=Number(item.shape_radius||markerShape.radius||.097)*100/Math.sqrt(2); return `<div class="defense-line-anchor selected" data-defense-radius-index="${idx}" style="left:${centerPos.left+sx*r}%;top:${centerPos.top+sy*r}%;" title="Изменить размер"></div>`; }).join('') : '';
    const centerMarker = isSensor ? '' : `
      <div class="defense-ability-marker ${isLine ? 'line-center' : ''} ${isBareArea ? 'bare-area-handle' : ''} ${selectedDefenseMarkerIndex === idx ? 'selected' : ''}" data-defense-marker-index="${idx}" style="left:${centerPos.left}%;top:${centerPos.top}%;" title="${esc(item.ability)} #${idx + 1}">
        ${isBareArea ? '' : (item.icon ? `<img src="${esc(item.icon)}" alt="">` : `<span>${idx + 1}</span>`)}
      </div>`;
    return `${anchors}${meshAnchors}${centerMarker}`;
  }).join('');
  host.innerHTML = `<svg class="defense-shape-lines" aria-hidden="true">
    <defs><pattern id="deadlock-net-grid" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <path d="M 0 0 L 0 7 M 3.5 0 L 3.5 7" class="defense-net-pattern-line"></path>
    </pattern></defs>${lines}</svg>${draftAnchors}${markers}`;
}

function moveDefenseAbilityTo(index, x, y) {
  const item = defenseAbilities[index];
  if (!item) return;
  const oldCenter = defenseAbilityCenter(item);
  if (['line_segment','sensor_rect','wall_sections'].includes(defenseShapeKind(item))) {
    const dx = x - oldCenter.x;
    const dy = y - oldCenter.y;
    item.points = normalizedDefensePoints(item).map((point, pointIndex) => ({
      ...(['sensor_rect','wall_sections'].includes(defenseShapeKind(item)) ? { role: pointIndex === 0 ? 'pivot' : 'rotation' } : {}),
      x: clamp01(point.x + dx),
      y: clamp01(point.y + dy),
    }));
  }
  item.x = x;
  item.y = y;
  renderDefenseAbilityMarkers();
  validateForm(); _saveDraft();
}

function setAbilityDragGhostPosition(event) {
  if (!defenseAbilityDrag?.ghost) return;
  defenseAbilityDrag.ghost.style.left = `${event.clientX}px`;
  defenseAbilityDrag.ghost.style.top = `${event.clientY}px`;
}

function removeAbilityDragGhost() {
  defenseAbilityDrag?.ghost?.remove();
}

function safeSetPointerCapture(element, pointerId) {
  if (!element || pointerId == null || typeof element.setPointerCapture !== 'function') return;
  try {
    element.setPointerCapture(pointerId);
  } catch (_) {
    // Pointer could already be released before a delayed handler runs.
  }
}

function safeReleasePointerCapture(element, pointerId) {
  if (!element || pointerId == null || typeof element.releasePointerCapture !== 'function') return;
  try {
    if (typeof element.hasPointerCapture !== 'function' || element.hasPointerCapture(pointerId)) {
      element.releasePointerCapture(pointerId);
    }
  } catch (_) {
    // Releasing an already lost pointer is harmless.
  }
}

function beginDefenseAbilityDrag(event, ability) {
  if (event.button !== undefined && event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  selectedDefenseAbility = ability;
  setMapMode('defenseAbility');
  const ghost = document.createElement('div');
  ghost.className = 'ability-drag-ghost';
  ghost.innerHTML = ability.icon ? `<img src="${esc(ability.icon)}" alt="">` : '';
  document.body.appendChild(ghost);
  defenseAbilityDrag = {
    ability,
    pointerId: event.pointerId,
    ghost,
    moved: false,
  };
  setAbilityDragGhostPosition(event);
  safeSetPointerCapture(event.currentTarget, event.pointerId);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function mapPointToPercent(point) {
  const content = mapContentRect();
  return {
    left: (content.left + clamp01(point.x) * content.width) / content.wrapWidth * 100,
    top: (content.top + clamp01(point.y) * content.height) / content.wrapHeight * 100,
  };
}

function defenseShapeKind(item) {
  const stored = item?.shape_kind || item?.shape?.kind;
  const agent = item?.agent || selectedAgent;
  const canonical = defensePlacementShape(agent, item?.ability, item?.slot);
  const hasCanonicalGeometry = canonical.kind !== 'point' || /^deadlock$/i.test(String(agent || '').trim());
  // Repair drafts created while the global Sonic Sensor fallback was
  // accidentally applied to every Deadlock ability.
  if (hasCanonicalGeometry) return canonical.kind;
  if (stored && stored !== 'point') return stored;
  // Older saved setups stored Sonic Sensor as a plain point; upgrade its
  // presentation on read without requiring a Firestore migration.
  return canonical.kind || stored || 'point';
}

function normalizedDefensePoints(item) {
  const points = Array.isArray(item?.points) ? item.points : [];
  const clean = points
    .map(point => ({ x: Number(point?.x), y: Number(point?.y) }))
    .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map(point => ({ x: clamp01(point.x), y: clamp01(point.y) }));
  if (clean.length >= 2) return clean.slice(0, 2);
  const x = Number.isFinite(Number(item?.x)) ? clamp01(item.x) : 0.5;
  const y = Number.isFinite(Number(item?.y)) ? clamp01(item.y) : 0.5;
  if (['sensor_rect','wall_sections'].includes(defenseShapeKind(item))) {
    const canonical = defensePlacementShape(item?.agent || selectedAgent, item?.ability, item?.slot);
    const width = Math.max(.01, Number(item?.shape_width || canonical.width || .12));
    const rotation = Number(item?.shape_rotation ?? canonical.rotation ?? 0) * Math.PI / 180;
    const dx = Math.cos(rotation) * width / 2;
    const dy = Math.sin(rotation) * width / 2;
    return [{ x:clamp01(x-dx), y:clamp01(y-dy) }, { x:clamp01(x+dx), y:clamp01(y+dy) }];
  }
  return [{ x, y }, { x: clamp01(x + 0.08), y }];
}

function defenseAbilityCenter(item) {
  const points = normalizedDefensePoints(item);
  if (['line_segment','sensor_rect','wall_sections'].includes(defenseShapeKind(item)) && points.length >= 2) {
    return {
      x: clamp01((points[0].x + points[1].x) / 2),
      y: clamp01((points[0].y + points[1].y) / 2),
    };
  }
  return {
    x: Number.isFinite(Number(item?.x)) ? clamp01(item.x) : 0.5,
    y: Number.isFinite(Number(item?.y)) ? clamp01(item.y) : 0.5,
  };
}

function setDefenseAbilityEndpoint(item, pointIndex, nextPoint) {
  if (!item || ![0,1].includes(pointIndex)) return;
  const kind = defenseShapeKind(item);
  let points = normalizedDefensePoints(item);
  const map = document.getElementById('sel-map')?.value || '';
  const configured = ['sensor_rect','wall_sections'].includes(kind)
    ? configuredDefenseShapeCache.get(rangeConfigId(map, selectedAgent, item.ability))
    : null;
  const lockedWidth = ['sensor_rect','wall_sections'].includes(kind)
    ? Math.max(.01, Number(configured?.width || item.shape_width || .12))
    : 0;
  const lockedHeight = ['sensor_rect','wall_sections'].includes(kind)
    ? Math.max(.01, Number(configured?.height || item.shape_height || .08))
    : 0;
  if (['sensor_rect','wall_sections'].includes(kind)) {
    const currentDx=points[1].x-points[0].x,currentDy=points[1].y-points[0].y;
    const currentLength=Math.max(.001,Math.hypot(currentDx,currentDy));
    const center={x:(points[0].x+points[1].x)/2,y:(points[0].y+points[1].y)/2};
    const dx=currentDx/currentLength*lockedWidth/2,dy=currentDy/currentLength*lockedWidth/2;
    points=[{x:center.x-dx,y:center.y-dy},{x:center.x+dx,y:center.y+dy}];
  }
  if (['sensor_rect','wall_sections'].includes(kind) && pointIndex === 0) {
    const requestedDx = nextPoint.x - points[0].x;
    const requestedDy = nextPoint.y - points[0].y;
    const minX = Math.min(points[0].x, points[1].x), maxX = Math.max(points[0].x, points[1].x);
    const minY = Math.min(points[0].y, points[1].y), maxY = Math.max(points[0].y, points[1].y);
    const dx = Math.max(-minX, Math.min(1-maxX, requestedDx));
    const dy = Math.max(-minY, Math.min(1-maxY, requestedDy));
    points = points.map(point => ({ x:point.x+dx, y:point.y+dy }));
  } else if (['sensor_rect','wall_sections'].includes(kind)) {
    const dx=nextPoint.x-points[0].x,dy=nextPoint.y-points[0].y;
    const length=Math.hypot(dx,dy);
    if (length < .001) return;
    const candidate={x:points[0].x+dx/length*lockedWidth,y:points[0].y+dy/length*lockedWidth};
    if (candidate.x < 0 || candidate.x > 1 || candidate.y < 0 || candidate.y > 1) return;
    points[1]=candidate;
  } else {
    points[pointIndex] = { x:clamp01(nextPoint.x), y:clamp01(nextPoint.y) };
  }
  item.points = points.map((point, index) => ({
    ...(['sensor_rect','wall_sections'].includes(kind) ? { role:index === 0 ? 'pivot' : 'rotation' } : {}),
    x:clamp01(point.x), y:clamp01(point.y),
  }));
  const center = defenseAbilityCenter({ ...item, points:item.points });
  item.x = center.x;
  item.y = center.y;
  if (['sensor_rect','wall_sections'].includes(kind)) {
    const dx = item.points[1].x - item.points[0].x;
    const dy = item.points[1].y - item.points[0].y;
    item.shape_width = lockedWidth;
    item.shape_height = lockedHeight;
    item.shape_rotation = Math.atan2(dy,dx) * 180 / Math.PI;
    item.shape_anchor = 'edge_midpoints';
  }
}

function serializedDefenseAbilities() {
  return defenseAbilities.map((item, idx) => ({
    ability:item.ability,
    slot:item.slot || '',
    icon:item.icon || '',
    x:item.x,
    y:item.y,
    shape_kind:defenseShapeKind(item),
    shape_radius:Number(item.shape_radius || 0),
    shape_anchor:item.shape_anchor || '',
    shape_width:Number(item.shape_width || 0),
    shape_height:Number(item.shape_height || 0),
    shape_rotation:Number(item.shape_rotation || 0),
    active_sections:isSageWallShape(item) ? normalizedWallSections(item.active_sections) : [],
    section_count:isSageWallShape(item) ? normalizedWallSections(item.active_sections).length : 0,
    points:['line_segment','sensor_rect','wall_sections'].includes(defenseShapeKind(item))
      ? normalizedDefensePoints(item).map((point, pointIndex) => ({
          ...(['sensor_rect','wall_sections'].includes(defenseShapeKind(item)) ? { role:pointIndex === 0 ? 'pivot' : 'rotation' } : {}),
          x:point.x, y:point.y,
        }))
      : [],
    order:idx + 1,
  }));
}

function defenseSubmissionPayload() {
  return {
    site:defenseSiteValue(),
    number:defenseNumberValue(),
    zoom_area:defenseZoomArea,
    abilities:serializedDefenseAbilities(),
  };
}

const configuredDefenseShapeCache = new Map();

function configuredDefenseShapeFromData(data, fallback = {}) {
  const points = Array.isArray(data?.points) ? data.points : [];
  const pivot = points.find(point => point?.role === 'pivot') || points[0];
  const rotationPoint = points.find(point => point?.role === 'rotation') || points[1];
  const pointAngle = pivot && rotationPoint
    ? Math.atan2(Number(rotationPoint.y) - Number(pivot.y), Number(rotationPoint.x) - Number(pivot.x)) * 180 / Math.PI
    : 0;
  return {
    ...fallback,
    kind: data?.shape_kind || fallback.kind,
    anchor: data?.shape_anchor || fallback.anchor || 'edge_midpoints',
    width: Number(data?.shape_width || fallback.width || 0.12),
    height: Number(data?.shape_height || fallback.height || 0.08),
    rotation: Number.isFinite(Number(data?.shape_rotation)) ? Number(data.shape_rotation) : pointAngle,
  };
}

async function getConfiguredDefenseShape(map, agent, ability, fallback = {}) {
  if (!map || !agent || !ability) return fallback;
  // range_config stores the adjustable Sonic Sensor rectangle. It must never
  // replace the canonical geometry of Barrier Mesh, GravNet or Annihilation.
  if (!['sensor_rect','wall_sections'].includes(fallback.kind)) return fallback;
  const requestedKey = rangeConfigId(map, agent, ability);
  if (configuredDefenseShapeCache.has(requestedKey)) return configuredDefenseShapeCache.get(requestedKey);
  const candidates = [...new Set([ability, ...abilityAliasesFor(ability)].filter(Boolean))];
  for (const candidate of candidates) {
    const key = rangeConfigId(map, agent, candidate);
    try {
      const snap = await getDoc(doc(db, 'range_config', key));
      if (!snap.exists()) continue;
      const configured = configuredDefenseShapeFromData(snap.data(), fallback);
      configuredDefenseShapeCache.set(requestedKey, configured);
      configuredDefenseShapeCache.set(key, configured);
      return configured;
    } catch (error) {
      console.warn('getConfiguredDefenseShape', candidate, error.message);
    }
  }
  const globalKey=`__${fallback.kind}_shape__${agent}`;
  if (configuredDefenseShapeCache.has(globalKey)) {
    const configured=configuredDefenseShapeCache.get(globalKey);
    configuredDefenseShapeCache.set(requestedKey,configured);
    return configured;
  }
  try {
    const snap=await getDocs(query(collection(db,'range_config'),where('agent','==',agent),limit(200)));
    const matches=snap.docs
      .map(item=>item.data())
      .filter(data=>data.shape_kind===fallback.kind && defensePlacementShape(agent,data.ability).kind===fallback.kind)
      .sort((a,b)=>(b.updatedAt?.toMillis?.()||0)-(a.updatedAt?.toMillis?.()||0));
    if(matches.length){
      const configured=configuredDefenseShapeFromData(matches[0],fallback);
      configuredDefenseShapeCache.set(globalKey,configured);
      configuredDefenseShapeCache.set(requestedKey,configured);
      return configured;
    }
  } catch(error) {
    console.warn('getConfiguredDefenseShape global fallback',ability,error.message);
  }
  configuredDefenseShapeCache.set(requestedKey, fallback);
  return fallback;
}

async function syncConfiguredDefenseAbilityShapes() {
  const map = document.getElementById('sel-map')?.value || '';
  if (!map || !selectedAgent || !defenseAbilities.length) return;
  let changed = false;
  await Promise.all(defenseAbilities.map(async item => {
    const fallback = defensePlacementShape(selectedAgent, item.ability, item.slot);
    if (!['sensor_rect','wall_sections'].includes(fallback.kind)) return;
    const configured = await getConfiguredDefenseShape(map, selectedAgent, item.ability, fallback);
    const center = defenseAbilityCenter(item);
    const width = Math.max(.01, Number(configured.width || fallback.width || .12));
    const currentPoints = normalizedDefensePoints(item);
    const currentDx = currentPoints[1].x - currentPoints[0].x;
    const currentDy = currentPoints[1].y - currentPoints[0].y;
    const hasStoredDirection = Array.isArray(item.points) && item.points.length >= 2 && Math.hypot(currentDx,currentDy) > .001;
    const rotation = hasStoredDirection
      ? Math.atan2(currentDy,currentDx) * 180 / Math.PI
      : Number(configured.rotation ?? fallback.rotation ?? 0);
    const radians = rotation * Math.PI / 180;
    const dx = Math.cos(radians) * width / 2;
    const dy = Math.sin(radians) * width / 2;
    Object.assign(item, {
      x:center.x, y:center.y,
      shape_kind:fallback.kind,
      shape_anchor:configured.anchor || 'edge_midpoints',
      shape_width:width,
      shape_height:Math.max(.01, Number(configured.height || fallback.height || .08)),
      shape_rotation:rotation,
      active_sections:fallback.kind === 'wall_sections' ? normalizedWallSections(item.active_sections) : [],
      section_count:fallback.kind === 'wall_sections' ? normalizedWallSections(item.active_sections).length : 0,
      points:[
        { role:'pivot', x:clamp01(center.x-dx), y:clamp01(center.y-dy) },
        { role:'rotation', x:clamp01(center.x+dx), y:clamp01(center.y+dy) },
      ],
    });
    changed = true;
  }));
  if (changed) {
    renderDefenseAbilityPanel();
    renderDefenseAbilityMarkers();
    validateForm();
    _saveDraft();
  }
}

async function placeDefenseAbilityAt(x, y, options = {}) {
  const chosenAbility = selectedDefenseAbility;
  if (!chosenAbility) {
    toast('Выбери способность сетапа', 'w');
    return false;
  }
  if (placedDefenseCount(chosenAbility.ability) >= chosenAbility.limit) {
    toast('Лимит этой способности уже достигнут', 'w');
    return false;
  }
  const map = document.getElementById('sel-map')?.value || '';
  const configuredShape = options.shapeKind
    ? chosenAbility.shape
    : await getConfiguredDefenseShape(map, selectedAgent, chosenAbility.ability, chosenAbility.shape || {});
  const shapeKind = options.shapeKind || configuredShape?.kind || chosenAbility.shape?.kind || 'point';
  const points = shapeKind === 'line_segment'
    ? normalizedDefensePoints({ x, y, points: options.points })
    : [];
  const center = shapeKind === 'line_segment'
    ? defenseAbilityCenter({ shape_kind: shapeKind, points })
    : { x, y };
  const shapeWidth = Number(options.shapeWidth || configuredShape?.width || 0);
  const shapeHeight = Number(options.shapeHeight || configuredShape?.height || 0);
  const shapeRotation = Number(options.shapeRotation ?? configuredShape?.rotation ?? 0);
  const sensorPoints = ['sensor_rect','wall_sections'].includes(shapeKind) ? (() => {
    const radians = shapeRotation * Math.PI / 180;
    const dx = Math.cos(radians) * shapeWidth / 2;
    const dy = Math.sin(radians) * shapeWidth / 2;
    return [
      { role:'pivot', x:clamp01(center.x - dx), y:clamp01(center.y - dy) },
      { role:'rotation', x:clamp01(center.x + dx), y:clamp01(center.y + dy) },
    ];
  })() : points;
  defenseAbilities.push({
    ability: chosenAbility.ability,
    slot: chosenAbility.slot,
    icon: chosenAbility.icon,
    x: clamp01(center.x),
    y: clamp01(center.y),
    shape_kind: shapeKind,
    shape_radius: Number(options.shapeRadius || configuredShape?.radius || chosenAbility.shape?.radius || 0),
    shape_anchor: configuredShape?.anchor || 'edge_midpoints',
    shape_width: shapeWidth,
    shape_height: shapeHeight,
    shape_rotation: shapeRotation,
    active_sections: shapeKind === 'wall_sections' ? normalizedWallSections(options.activeSections) : [],
    section_count: shapeKind === 'wall_sections' ? normalizedWallSections(options.activeSections).length : 0,
    points: sensorPoints,
    order: defenseAbilities.length + 1,
  });
  selectedDefenseMarkerIndex = defenseAbilities.length - 1;
  if (selectedDefenseAbility?.ability === chosenAbility.ability && placedDefenseCount(chosenAbility.ability) >= chosenAbility.limit) {
    selectedDefenseAbility = null;
    setMapMode('position');
  }
  renderDefenseAbilityPanel();
  renderDefenseAbilityMarkers();
  validateForm(); _saveDraft();
  return true;
}

function setElementMapBox(el, area) {
  if (!el || !area) return;
  const content = mapContentRect();
  el.style.display = '';
  el.style.left = ((content.left + area.x * content.width) / content.wrapWidth * 100) + '%';
  el.style.top = ((content.top + area.y * content.height) / content.wrapHeight * 100) + '%';
  el.style.width = (area.width * content.width / content.wrapWidth * 100) + '%';
  el.style.height = (area.height * content.height / content.wrapHeight * 100) + '%';
}

function renderCategoryMapExtras() {
  const target = document.getElementById('wallbang-target-marker');
  const zoom = document.getElementById('defense-zoom-box');
  const isWallbang = normalizeContentCategory(selectedCategory) === 'wallbang';
  if (target) {
    if (isWallbang && wallbangTargetX !== null && wallbangTargetY !== null) {
      const content = mapContentRect();
      target.style.display = '';
      target.style.left = ((content.left + wallbangTargetX * content.width) / content.wrapWidth * 100) + '%';
      target.style.top = ((content.top + wallbangTargetY * content.height) / content.wrapHeight * 100) + '%';
    } else {
      target.style.display = 'none';
    }
  }
  if (zoom) {
    if (hasValidDefenseZoom()) setElementMapBox(zoom, defenseZoomArea);
    else zoom.style.display = 'none';
  }
  const wbStatus = document.getElementById('wallbang-target-status');
  if (wbStatus) {
    wbStatus.textContent = wallbangTargetX !== null
      ? `Точка попадания: ${wallbangTargetX.toFixed(3)}, ${wallbangTargetY.toFixed(3)}`
      : 'Поставь точку, куда должен прилететь прострел.';
  }
  const dzStatus = document.getElementById('defense-zoom-status');
  if (dzStatus) {
    dzStatus.textContent = hasValidDefenseZoom()
      ? `Zoom: x ${defenseZoomArea.x.toFixed(3)}, y ${defenseZoomArea.y.toFixed(3)}, w ${defenseZoomArea.width.toFixed(3)}, h ${defenseZoomArea.height.toFixed(3)}`
      : 'Нажми Zoom и выдели прямоугольник на карте.';
  }
}

function updateCategoryUi() {
  const normalized = normalizeContentCategory(selectedCategory || '');
  if (normalized !== 'lineup' || selectedRoundSide !== 'attack') {
    spikeUsage = null;
    spikeX = spikeY = null;
    if (mapMode === 'spike') mapMode = 'position';
  }
  if (normalized && agentsList.length) loadAgentCategoryAvailability(normalized);
  if (normalized === 'defense') {
    const selected = agentsList.find(agent => agent.displayName === selectedAgent);
    if (selected && !agentAllowedForCategory(selected, normalized)) {
      selectedAgent = null;
      selectedAbility = null;
      selectedDefenseAbility = null;
      selectedDefenseMarkerIndex = null;
      defenseAbilities = [];
      document.getElementById('abilities-row').innerHTML = '<span style="color:var(--text2);font-size:13px;">Сначала выбери агента</span>';
    }
  }
  const showAgent = !!normalized && normalized !== 'wallbang';
  const showAbility = normalized === 'lineup';
  const agentCard = document.getElementById('agents-grid')?.closest('.card');
  const agentTitle = agentCard?.previousElementSibling;
  const abilityCard = document.getElementById('abilities-row')?.closest('.card');
  const abilityTitle = abilityCard?.previousElementSibling;
  if (agentCard) agentCard.style.display = showAgent ? '' : 'none';
  if (agentTitle?.classList?.contains('section-title')) agentTitle.style.display = showAgent ? '' : 'none';
  if (abilityCard) abilityCard.style.display = showAbility ? '' : 'none';
  if (abilityTitle?.classList?.contains('section-title')) abilityTitle.style.display = showAbility ? '' : 'none';
  document.getElementById('extra-abilities-panel')?.toggleAttribute('hidden', !showAbility || !selectedAgent || !selectedAbility);
  document.getElementById('lineup-toolbox')?.toggleAttribute('hidden', !showAbility || !selectedAgent || !selectedAbility);
  document.getElementById('wallbang-extra')?.toggleAttribute('hidden', normalized !== 'wallbang');
  document.getElementById('defense-extra')?.toggleAttribute('hidden', normalized !== 'defense');
  document.getElementById('defense-ability-panel')?.toggleAttribute('hidden', normalized !== 'defense');
  document.getElementById('defense-toolbox')?.toggleAttribute('hidden', normalized !== 'defense');
  document.getElementById('map-container')?.classList.toggle('lineup-workbench', showAbility && !!selectedAgent && !!selectedAbility);
  document.getElementById('map-container')?.classList.toggle('defense-workbench', normalized === 'defense');
  const mapTitle = document.getElementById('map-section-title');
  if (mapTitle) {
    if (normalized === 'defense') mapTitle.textContent = '🛡 КАРТА СЕТАПА';
    else if (normalized === 'wallbang') mapTitle.textContent = '💥 ТОЧКИ ПРОСТРЕЛА';
    else mapTitle.textContent = '📍 МЕТКА НА КАРТЕ';
  }
  if (normalized !== 'wallbang' && mapMode === 'target') setMapMode('position');
  if (normalized === 'wallbang' && mapMode === 'trajectory') setMapMode('position');
  if (normalized !== 'defense' && (mapMode === 'zoom' || mapMode === 'defenseAbility')) setMapMode('position');
  if (normalized === 'defense') {
    trajectoryPoints = [];
    markerX = markerY = null;
    document.getElementById('map-marker').style.display = 'none';
    renderTrajectory();
    renderDefenseAbilityPanel();
  }
  renderAgentsGrid();
  renderExtraAbilityPanel();
  setMapMode(mapMode);
  renderCategoryMapExtras();
  renderSpikeControls();
  renderDefenseAbilityMarkers();
  validateForm();
}

function updateUploadCategoryButtons() {
  document.querySelectorAll('#cat-row .pill-btn').forEach(btn => {
    const category = normalizeContentCategory(btn.dataset.val);
    const implemented = UPLOAD_IMPLEMENTED_CONTENT_TYPES.has(category);
    const enabled = implemented && uploadCategoryFlag(category);
    btn.disabled = !enabled;
    btn.classList.toggle('locked', !enabled);
    btn.title = enabled
      ? ''
      : (implemented ? 'Категория закрыта в настройках сайта' : 'Комбо пока закрыто: нужна отдельная модель');
    if (!enabled && selectedCategory === category) {
      btn.classList.remove('selected');
      selectedCategory = null;
    }
  });
  updateCategoryUi();
}

async function loadUploadCategoryConfig() {
  let cached = {};
  try { cached = JSON.parse(localStorage.getItem(UPLOAD_CONFIG_CACHE_KEY) || '{}') || {}; } catch (_) {}
  try {
    const versionsReference = doc(db, 'settings', 'config_versions');
    const versionsSnap = await getDoc(versionsReference);
    const versions = versionsSnap.exists() ? versionsSnap.data() : {};
    watchUploadConfigVersions(versionsReference, versions);
    const weaponVersion = String(versions.weapon_whitelist || '');
    const defenseVersion = String(versions.defense_agents || '');
    const useCachedWeapons = weaponVersion && cached.weaponVersion === weaponVersion && Array.isArray(cached.weapons);
    const useCachedDefense = defenseVersion && cached.defenseVersion === defenseVersion && Array.isArray(cached.defenseAgents);
    const siteAccessReference = doc(db, 'settings', 'category_access_site');
    const [accessSnap, weaponsSnap, defenseSnap] = await Promise.all([
      getDoc(siteAccessReference),
      useCachedWeapons ? Promise.resolve(null) : getDoc(doc(db, 'settings', 'weapon_whitelist')),
      useCachedDefense ? Promise.resolve(null) : getDoc(doc(db, 'settings', 'defense_agents')),
    ]);
    watchUploadCategoryAccess(siteAccessReference, accessSnap);
    if (useCachedWeapons) {
      uploadWeaponWhitelist = cached.weapons.filter(Boolean);
    } else if (weaponsSnap?.exists() && Array.isArray(weaponsSnap.data().weapons)) {
      uploadWeaponWhitelist = weaponsSnap.data().weapons.filter(Boolean);
    }
    if (useCachedDefense) {
      uploadDefenseAgents = new Set(cached.defenseAgents.filter(Boolean));
    } else if (defenseSnap?.exists() && Array.isArray(defenseSnap.data().agents)) {
      uploadDefenseAgents = new Set(defenseSnap.data().agents.filter(Boolean));
    }
    try {
      localStorage.setItem(UPLOAD_CONFIG_CACHE_KEY, JSON.stringify({
        weaponVersion, defenseVersion,
        weapons: uploadWeaponWhitelist,
        defenseAgents: [...uploadDefenseAgents],
      }));
    } catch (_) {}
  } catch (e) {
    console.warn('loadUploadCategoryConfig', e.message);
    if (Array.isArray(cached.weapons)) uploadWeaponWhitelist = cached.weapons.filter(Boolean);
    if (Array.isArray(cached.defenseAgents)) uploadDefenseAgents = new Set(cached.defenseAgents.filter(Boolean));
  }
  renderWallbangWeapons();
  updateUploadCategoryButtons();
}

function toSafeErrorMessage(error) {
  const code = String(error?.code || '').toLowerCase();
  const msg = String(error?.message || error || '');
  if (code.includes('permission-denied') || /permission|permission-denied|insufficient/i.test(msg)) {
    if (!canCurrentUserUpload()) return uploadGateMessage();
    return 'Сервер не принял лайнап. Обнови страницу и попробуй ещё раз. Ошибка уже записана в логи.';
  }
  return msg || 'Неизвестная ошибка';
}

async function logUploadError(error, context = {}) {
  if (!auth.currentUser) return;
  const payload = {
    source: 'upload_site',
    message: String(error?.message || error || 'Unknown upload site error').slice(0, 1000),
    code: String(error?.code || '').slice(0, 100),
    stack: String(error?.stack || '').slice(0, 4000),
    context,
    user_name: currentUserProfile?.name || currentUserProfile?.username || currentUserProfile?.displayName || auth.currentUser.displayName || '',
    user_email: currentUserProfile?.email || currentUserProfile?.user_email || auth.currentUser.email || '',
    appVersion: 'upload-site',
    url: location.href,
    userAgent: navigator.userAgent,
  };
  try {
    const token = await auth.currentUser.getIdToken();
    const response = await fetch('/api/client-error', {
      method:'POST',
      credentials:'same-origin',
      headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
      body:JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`client-error endpoint ${response.status}`);
  } catch (backendError) {
    console.warn('logUploadError backend', backendError.message);
    try {
      await Promise.race([
        setDoc(doc(collection(db, 'app_errors')), {
          type:'web', ...payload,
          uid:auth.currentUser.uid, user_id:auth.currentUser.uid,
          platform:'web', timestamp:serverTimestamp(), received_via:'firestore_fallback',
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Firestore log timeout')), 2500)),
      ]);
    } catch (firestoreError) {
      console.warn('logUploadError firestore fallback', firestoreError.message);
    }
  }
}

function diagnosticTimestamp(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value);
}

function userDiagnostics(profile = currentUserProfile || {}) {
  const info = userTrialInfo(profile);
  const role = String(profile.role || 'user');
  return {
    uid: auth.currentUser?.uid || '',
    name: profile.name || profile.username || profile.displayName || auth.currentUser?.displayName || '',
    email: profile.email || profile.user_email || auth.currentUser?.email || '',
    role,
    is_admin_or_moderator: role === 'admin' || role === 'moderator',
    can_upload: role === 'admin' || role === 'moderator' || info.verified,
    gate_message: role === 'admin' || role === 'moderator' || info.verified ? '' : uploadGateMessage(),
    lineups_viewed: info.viewed,
    approved_lineups: Number(profile.approved_lineups || 0),
    bonus_lineups: Number(profile.bonus_lineups || 0),
    verified_not_fake: !!profile.verified_not_fake,
    pre_tracking: info.preTracking,
    created_at: diagnosticTimestamp(profile.created_at),
    last_seen: diagnosticTimestamp(profile.last_seen),
  };
}

function submitFormDiagnostics({ title = '', desc = '', map = '', ability = '', contentType = '' } = {}) {
  const reasons = [];
  if (!currentUser) reasons.push('no_current_user');
  if (!map) reasons.push('missing_map');
  if (categoryNeedsAgent(contentType || selectedCategory) && !selectedAgent) reasons.push('missing_agent');
  if (categoryNeedsAbility(contentType || selectedCategory) && !ability) reasons.push('missing_normalized_ability');
  if (categoryNeedsAbility(contentType || selectedCategory) && !selectedAbility) reasons.push('missing_selected_ability');
  if (!selectedCategory) reasons.push('missing_category');
  if (!canSubmitContentCategory(contentType || selectedCategory)) reasons.push('content_type_closed');
  if (!selectedDifficulty) reasons.push('missing_difficulty');
  if (!title.trim()) reasons.push('missing_title');
  if (title.length > 100) reasons.push('title_too_long');
  if (desc.length > 1000) reasons.push('description_too_long');
  if (normalizeContentCategory(contentType || selectedCategory) !== 'defense' && (markerX === null || markerY === null)) reasons.push('missing_marker');
  if (!categoryExtrasValid(contentType || selectedCategory)) reasons.push('missing_category_extras');
  if (screenshots.some(s => s.uploading)) reasons.push('screenshots_uploading');
  return {
    client_ok: reasons.length === 0,
    client_block_reasons: reasons,
    title_length: title.length,
    description_length: desc.length,
    has_video: !!videoUrl,
    screenshots_total: screenshots.length,
    screenshots_uploaded: screenshots.filter(s => s.cloudUrl).length,
    marker_x: markerX,
    marker_y: markerY,
    trajectory_points: trajectoryPoints.length,
    wallbang_weapons: selectedWallbangWeapons(),
    wallbang_target_x: wallbangTargetX,
    wallbang_target_y: wallbangTargetY,
    defense_site: defenseSiteValue(),
    defense_zoom_area: defenseZoomArea,
    defense_abilities: defenseAbilities.length,
  };
}

function userTrialInfo(u = {}) {
  const viewed = Number(u.lineups_viewed || 0);
  const approved = Number(u.approved_lineups || 0);
  const created = u.created_at?.toDate?.() ?? null;
  const preTracking = created !== null && created < USER_TRACKING_START;
  const verified = !!u.verified_not_fake || viewed >= UPLOAD_REQUIRED_VIEWS || approved > 0 || preTracking;
  return { viewed, approved, verified, preTracking };
}

function uploadGateMessage() {
  const viewed = Number(currentUserProfile?.lineups_viewed || 0);
  const left = Math.max(0, UPLOAD_REQUIRED_VIEWS - viewed);
  if (left <= 0) {
    return 'Просмотры уже выполнены. Обнови страницу и попробуй отправить ещё раз.';
  }
  return `Чтобы выкладывать лайнапы, сначала посмотри ${UPLOAD_REQUIRED_VIEWS} лайнапов в приложении. Осталось: ${left}. Спасибо!`;
}

function canCurrentUserUpload() {
  const role = String(currentUserProfile?.role || 'user');
  return role === 'admin' || role === 'moderator' || userTrialInfo(currentUserProfile || {}).verified;
}

function safePlay(player) {
  if (!player || !player.isConnected) return;
  const source = player.currentSrc || player.src;
  if (!source) return;
  const playPromise = player?.play?.();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch(error => {
      const msg = String(error?.message || error || '');
      if (
        error?.name === 'NotSupportedError'
        || /no supported source|element has no supported sources|interrupted by a call to pause|interrupted by a new load request|play\(\) request was interrupted/i.test(msg)
      ) {
        return;
      }
      logUploadError(error, { action: 'media_play' });
    });
  }
}

function updateUploadGate() {
  const box = document.getElementById('upload-gate');
  if (!box) return;
  if (!currentUser || canCurrentUserUpload()) {
    box.style.display = 'none';
    box.textContent = '';
    return;
  }
  box.style.display = 'block';
  box.textContent = uploadGateMessage();
}

window.addEventListener('error', event => {
  logUploadError(event.error || event.message, {
    action: 'window_error',
    filename: event.filename,
    line: event.lineno,
    column: event.colno,
  });
});

window.addEventListener('unhandledrejection', event => {
  logUploadError(event.reason || 'Unhandled rejection', { action: 'unhandledrejection' });
});

function initGlobalSiteVersionWatcher() {
  initSiteVersionWatcher({
    onUpdate:() => playSiteSound('update'),
    beforeReload:async () => {
      if (moderatorDraftSourceId) {
        const saved = await flushModeratorAutosave({ reportError:true });
        if (!saved) return false;
      }
      return true;
    },
  });
}

window.addEventListener('pagehide', () => {
  if (moderatorDraftSourceId && moderatorAutosaveDirty) {
    flushModeratorAutosave({ keepalive:true }).catch(() => {});
  }
});

function renderDescriptionSamples() {
  const list = document.getElementById('description-samples-list');
  if (!list) return;
  list.innerHTML = DESCRIPTION_SAMPLES.map((sample, index) => `
    <article class="sample-card">
      <h3>${esc(sample.title)}</h3>
      <p>${esc(sample.text)}</p>
      <div class="sample-actions">
        <button class="copy-id-btn" type="button" data-description-copy="${index}">Скопировать</button>
        <button class="copy-id-btn" type="button" data-description-replace="${index}">Заменить</button>
      </div>
    </article>
  `).join('');
}

function openDescriptionSamples() {
  renderDescriptionSamples();
  const drawer = document.getElementById('description-samples-drawer');
  if (!drawer) return;
  drawer.classList.add('show');
  drawer.setAttribute('aria-hidden', 'false');
}

function closeDescriptionSamples() {
  const drawer = document.getElementById('description-samples-drawer');
  if (!drawer) return;
  drawer.classList.remove('show');
  drawer.setAttribute('aria-hidden', 'true');
}

function initDescriptionSamples() {
  renderDescriptionSamples();
  document.getElementById('btn-description-samples')?.addEventListener('click', openDescriptionSamples);
  document.getElementById('btn-close-description-samples')?.addEventListener('click', closeDescriptionSamples);
  document.getElementById('description-samples-drawer')?.addEventListener('click', event => {
    if (event.target.id === 'description-samples-drawer') closeDescriptionSamples();
    const copyBtn = event.target.closest('[data-description-copy]');
    const replaceBtn = event.target.closest('[data-description-replace]');
    if (copyBtn) {
      const sample = DESCRIPTION_SAMPLES[Number(copyBtn.dataset.descriptionCopy)];
      copyTextToClipboard(sample?.text || '')
        .then(() => toast('Описание скопировано', 's'))
        .catch(() => toast('Не удалось скопировать', 'e'));
    }
    if (replaceBtn) {
      const sample = DESCRIPTION_SAMPLES[Number(replaceBtn.dataset.descriptionReplace)];
      setDescriptionValue(sample?.text || '');
      closeDescriptionSamples();
      toast('Описание заменено', 's');
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeDescriptionSamples();
  });
}

async function getConfiguredRangeRadius(map, agent, ability, abilityAliases = []) {
  if (!map || !agent || !ability) return 0;
  const names = [...new Set([ability, ...abilityAliases].filter(Boolean).map(String))];
  for (const name of names) {
    try {
      const snap = await getDoc(doc(db, 'range_config', rangeConfigId(map, agent, name)));
      const radius = Number(snap.data()?.range_radius || 0);
      if (Number.isFinite(radius) && radius > 0) return radius;
    } catch (e) {
      console.warn('getConfiguredRangeRadius', name, e.message);
    }
  }
  return 0;
}

function toast(msg, type = 'i') {
  const container = document.getElementById('toasts');
  if (container.children.length >= 4) container.firstChild?.remove();
  const el = document.createElement('div');
  el.className = `toast ${type}`; el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function setDescriptionValue(text) {
  const desc = document.getElementById('inp-desc');
  if (!desc) return;
  desc.value = String(text || '').slice(0, 1000);
  const counter = document.getElementById('desc-count');
  if (counter) counter.textContent = desc.value.length;
  _saveDraft();
}
function copyTextToClipboard(text) {
  const value = String(text || '');
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.left = '-9999px';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  return ok ? Promise.resolve() : Promise.reject(new Error('copy failed'));
}
function hasCyrillic(text) {
  return /[А-Яа-яЁё]/.test(String(text || ''));
}
function fmtTime(s) {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2,'0')}`;
}
function videoContentType(file) {
  if (file.type) return file.type;
  if (/\.mov$/i.test(file.name)) return 'video/quicktime';
  if (/\.webm$/i.test(file.name)) return 'video/webm';
  return 'video/mp4';
}
function transparentPreviewWarning(fileNameOrUrl = '') {
  const value = String(fileNameOrUrl || '').toLowerCase();
  if (!value.endsWith('.mov')) return '';
  return 'MOV/QuickTime с альфой хранится как мастер-файл, но браузерный предпросмотр часто показывает его чёрным. Для прозрачного оверлея на сайте загрузи WebM VP9/VP8 с alpha.';
}

// ── Cloudinary ────────────────────────────────────────────────────────────────
function compressImage(file) {
  if (file.size < 300 * 1024) return Promise.resolve(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const MAX = 1280;
      let w = img.naturalWidth, h = img.naturalHeight;
      if (w > MAX || h > MAX) { const s = MAX / Math.max(w,h); w = Math.round(w*s); h = Math.round(h*s); }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob(blob => { if (blob) resolve(blob); else reject(new Error('toBlob вернул null')); }, 'image/jpeg', 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Ошибка загрузки изображения')); };
    img.src = url;
  });
}

function uploadToCloudinary(blob, onProgress) {
  const fd = new FormData();
  fd.append('file', blob, 'screenshot.jpg');
  fd.append('upload_preset', '4343242');
  fd.append('folder', 'lineups_screenshots');
  let xhr;
  const promise = new Promise((resolve, reject) => {
    xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://api.cloudinary.com/v1_1/djxgwkbqn/image/upload');
    xhr.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText).secure_url); }
        catch { reject(new Error('Неверный ответ Cloudinary')); }
      } else { reject(new Error('Cloudinary ' + xhr.status)); }
    };
    xhr.onerror = () => reject(new Error('Сетевая ошибка'));
    xhr.onabort = () => reject(new Error('canceled'));
    xhr.send(fd);
  });
  promise.abort = () => xhr?.abort();
  return promise;
}

const nearbyTitleCache = new Map();
let titleSuggestionTimer = null;
let titleSuggestionGeneration = 0;

function lineupDestinationPoints(data) {
  const paths = [data?.trajectory, ...(Array.isArray(data?.extra_abilities) ? data.extra_abilities.map(item => item?.trajectory) : [])];
  return paths.map(normalizeTrajectoryPoints).filter(points => points.length).map(points => points[points.length - 1]);
}

function currentLineupDestination() {
  const extraPaths = extraAbilityTrajectories.map(item => normalizeTrajectoryPoints(item?.trajectory)).filter(points => points.length);
  const points = extraPaths.length ? extraPaths[extraPaths.length - 1] : normalizeTrajectoryPoints(trajectoryPoints);
  return points.length ? points[points.length - 1] : null;
}

async function loadNearbyTitleCandidates(mapName) {
  if (nearbyTitleCache.has(mapName)) return nearbyTitleCache.get(mapName);
  const promise = getDocs(query(collection(db, 'lineups'), where('map', '==', mapName), limit(160)))
    .then(snap => snap.docs.map(item => item.data()).filter(data => {
      const status = String(data?.status || '').toLowerCase();
      return String(data?.title || '').trim() && ['approved', 'hot', 'pending'].includes(status);
    }))
    .catch(error => {
      logUploadError(error, { action: 'nearby_title_suggestions_load', map: mapName });
      return [];
    });
  nearbyTitleCache.set(mapName, promise);
  return promise;
}

function applySuggestedTitle(title) {
  const input = document.getElementById('inp-title');
  if (!input || !title) return;
  input.value = title;
  document.getElementById('title-count').textContent = title.length;
  validateForm();
  _saveDraft();
}

function applySuggestedDescription(description) {
  if (!description) return;
  setDescriptionValue(description);
  validateForm();
  _saveDraft();
}

function renderPointSuggestions(hostId, values, { label, kind }) {
  const host = document.getElementById(hostId);
  if (!host) return;
  if (!values.length) {
    host.hidden = true;
    host.innerHTML = '';
    return;
  }
  host.hidden = false;
  const dataAttr = kind === 'description' ? 'data-description-suggestion' : 'data-title-suggestion';
  host.innerHTML = `<div class="point-suggestions-label"><b>✦ ${esc(label)}</b><span>Ничего не подставляется автоматически</span></div><div class="point-suggestions-list">${values.map(value => `<button class="point-suggestion" type="button" ${dataAttr}="${esc(value)}">${esc(value)}</button>`).join('')}</div>`;
  host.querySelectorAll(`[${dataAttr}]`).forEach(button => button.addEventListener('click', () => {
    const value = button.getAttribute(dataAttr) || '';
    if (kind === 'description') applySuggestedDescription(value);
    else applySuggestedTitle(value);
  }));
}

function renderNearbyCopySuggestions(items) {
  const titles = [...new Set(items.map(item => item.title).filter(Boolean))].slice(0, 3);
  const descriptions = [...new Set(items.map(item => item.description).filter(Boolean))].slice(0, 3);
  renderPointSuggestions('title-suggestions', titles, { label: 'Предложенные названия по точке', kind: 'title' });
  renderPointSuggestions('description-suggestions', descriptions, { label: 'Предложенные описания по точке', kind: 'description' });
}

async function updateNearbyTitleSuggestions() {
  const generation = ++titleSuggestionGeneration;
  const mapName = document.getElementById('sel-map')?.value || '';
  const destination = currentLineupDestination();
  if (!mapName || !destination) {
    renderNearbyCopySuggestions([]);
    return;
  }
  const candidates = await loadNearbyTitleCandidates(mapName);
  if (generation !== titleSuggestionGeneration) return;
  const ranked = candidates.map(data => {
    const distances = lineupDestinationPoints(data).map(point => Math.hypot(point.x - destination.x, point.y - destination.y));
    return {
      title: String(data.title || '').trim(),
      description: String(data.description || '').trim(),
      distance: distances.length ? Math.min(...distances) : Infinity,
    };
  }).filter(item => item.distance <= 0.09).sort((a, b) => a.distance - b.distance);
  renderNearbyCopySuggestions(ranked);
}

function scheduleNearbyTitleSuggestions() {
  clearTimeout(titleSuggestionTimer);
  titleSuggestionTimer = setTimeout(updateNearbyTitleSuggestions, 320);
}

function uploadCompatibleLineupVideo(file, onProgress) {
  const fd = new FormData();
  fd.append('file', file, file.name || 'lineup-video.mp4');
  fd.append('upload_preset', '4343242');
  fd.append('folder', 'lineups_videos');
  let xhr;
  const promise = new Promise((resolve, reject) => {
    xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://api.cloudinary.com/v1_1/djxgwkbqn/video/upload');
    xhr.upload.onprogress = event => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`Cloudinary video upload error: ${xhr.status}`));
        return;
      }
      try {
        const result = JSON.parse(xhr.responseText);
        if (!result.version || !result.public_id) throw new Error('Неполный ответ Cloudinary');
        resolve(
          `https://res.cloudinary.com/djxgwkbqn/video/upload/` +
          `c_limit,h_1080,w_1920/` +
          `f_mp4,vc_h264:main:4.1,ac_aac,fps_1-30,fl_progressive,q_auto:good/` +
          `v${result.version}/${result.public_id}.mp4`,
        );
      } catch (error) {
        reject(error);
      }
    };
    xhr.onerror = () => reject(new Error('Сетевая ошибка загрузки видео'));
    xhr.onabort = () => reject(new Error('canceled'));
    xhr.send(fd);
  });
  promise.abort = () => xhr?.abort();
  return promise;
}

function uploadVideoToSelectel(file, onProgress) {
  // Normalize user video before its URL reaches a lineup. Directly storing the
  // source preserved 1080p/120 FPS and codecs unsupported by some Android
  // hardware decoders.
  return uploadCompatibleLineupVideo(file, onProgress);

  /* Legacy direct-to-Selectel uploader retained temporarily for rollback.
  const fileName  = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  let xhr = null;
  let aborted = false;

  const promise = new Promise(async (resolve, reject) => {
    try {
      const contentType = videoContentType(file);
      const signed = await createSelectelVideoUpload({
        fileName,
        contentType,
        sizeBytes: file.size,
      });
      const uploadUrl = signed.data?.uploadUrl;
      const publicUrl = signed.data?.publicUrl;
      if (!uploadUrl || !publicUrl) {
        throw new Error('Сервер не вернул ссылку загрузки');
      }

      if (aborted) { reject(new Error('canceled')); return; }

      xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl);
      xhr.setRequestHeader('Content-Type', contentType);
      xhr.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(publicUrl);
        else reject(new Error('Selectel upload error: ' + xhr.status + ' ' + xhr.responseText));
      };
      xhr.onerror = () => reject(new Error('Сетевая ошибка'));
      xhr.onabort = () => reject(new Error('canceled'));
      xhr.send(file);
    } catch (e) { reject(e); }
  });

  promise.abort = () => { aborted = true; xhr?.abort(); };
  return promise;
  */
}

// ── State ─────────────────────────────────────────────────────────────────────
let currentUser      = null;
let currentUserProfile = null;
let agentsList       = [];
let mapsData         = [];
let selectedAgent    = null;
let selectedAbility  = null;
let sovaCharge = 3;
let sovaBounces = 0;

function isSovaArrowSelection(agent = selectedAgent, ability = selectedAbility) {
  const agentKey = String(agent || '').trim().toLowerCase();
  const abilityKey = String(ability || '').trim().toLowerCase();
  return (agentKey === 'sova' || agentKey === 'сова') &&
    (/shock|recon|шок|развед|стрел/.test(abilityKey));
}

function renderSovaShotPanel() {
  const panel = document.getElementById('sova-shot-panel');
  if (!panel) return;
  panel.hidden = !isSovaArrowSelection();
  const charge = sovaCharge;
  const bounces = sovaBounces;
  const heading = document.getElementById('sova-shot-heading');
  if (heading) heading.textContent = '🏹 ПАРАМЕТРЫ · ОСНОВНАЯ';
  const range = document.getElementById('sova-charge-range');
  if (range) {
    range.value = String(charge);
    range.style.setProperty('--sova-charge-pct', `${Math.max(0, Math.min(100, charge / 3 * 100))}%`);
    range.closest('.sova-charge-slider')?.classList.toggle('is-max', charge >= 3);
  }
  panel.querySelectorAll('[data-sova-bounce-index]').forEach(button => {
    button.classList.toggle('active', Number(button.dataset.sovaBounceIndex) <= bounces);
  });
}

document.getElementById('sova-charge-range')?.addEventListener('input', event => {
  sovaCharge = Math.max(0, Math.min(3, Number(event.target.value) || 0));
  renderSovaShotPanel(); _saveDraft();
});
document.getElementById('sova-bounce-picker')?.addEventListener('click', event => {
  const button = event.target.closest('[data-sova-bounce-index]');
  if (!button) return;
  const index = Math.max(1, Math.min(2, Number(button.dataset.sovaBounceIndex) || 1));
  sovaBounces = sovaBounces === index ? index - 1 : index;
  renderSovaShotPanel(); _saveDraft();
});
let selectedCategory = null;
let selectedDifficulty = null;
let selectedRoundSide = null;
let spikeUsage = null;
let spikeX = null, spikeY = null;
let markerX = null, markerY = null;
let trajectoryPoints = [];
let extraAbilityTrajectories = [];
let selectedExtraAbilityIndex = null;
let wallbangTargetX = null, wallbangTargetY = null;
let defenseZoomStart = null;
let defenseZoomArea = null;
let defenseZoomDrag = null;
let defenseZoomJustSelected = false;
let selectedDefenseAbility = null;
let defenseAbilities = [];
let defenseAbilityDrag = null;
let defenseLineDraft = null;
let defenseLineJustCreated = false;
let selectedDefenseMarkerIndex = null;
let sageWallHandlesHidden = false;
let mapMode = 'position';
let videoUrl = null;
let localVideoPreviewUrl = '';
let knownVideoDuration = 0;
let fullVideoLoadController = null;
let fullVideoLoadSequence = 0;
let moderatorVideoRemovalRequested = false;
let videoXhr = null;
let videoEdit = createDefaultVideoEdit();
let screenshots = [];
let currentUserLineups = [];
let authorMaterials = [];
let authorMaterialsLoaded = false;
let authorMaterialsLoading = false;
let authorMaterialsError = '';
let materialEditorId = '';
let materialVideoUploading = false;
let materialVideoUploadSeq = 0;
let materialVideoUploadRequest = null;
let activeWorkspaceTab = 'upload';
let myLineupsStatusFilter = 'all';
let myLineupsSearch = '';
let resubmissionSourceId = '';
let moderatorDraftSourceId = '';
let moderatorRewardOptIn = false;
const MODERATOR_EDIT_SESSION_KEY = 'vl_active_moderator_edit_id';
let moderatorResumeAttempted = false;
let moderatorSelectedAuthor = null;
let moderatorAuthorMatches = [];
let moderatorAuthorTimer = null;
let moderatorAuthorSearchSequence = 0;
let moderationController = null;
let moderationModulePromise = null;
let pendingLineupDeepLink = new URLSearchParams(window.location.search).get('lineup') || '';
const CATEGORY_TRAINING_PATHS = {
  lineup: '/author-training/lineups/',
  defense: '/author-training/defense/',
  combo: '/author-training/combo/',
  wallbang: '/author-training/wallbang/',
};
const CATEGORY_FORM_GUIDES = {
  lineup: {
    title: 'Лайнап: как заполнить?',
    description: 'Пройди форму сверху вниз: выбери данные лайнапа, подготовь видео и кадры, разметь карту, добавь описание и отправь материал.',
    steps: ['Заполни основу', 'Подготовь видео', 'Добавь кадры', 'Разметь карту', 'Опиши и отправь'],
    important: [
      'Записывай видео в 1920×1080 (Full HD), качество графики — не ниже «Среднего».',
      'Покажи стартовую позицию, ориентир прицела, сам бросок и конечный результат.',
      'Не вырезай движение, подготовку броска и момент использования способности.',
      'Карта, агент, способность и название должны точно соответствовать записи.',
      'Скриншоты должны идти по порядку повторения лайнапа и оставаться читаемыми.',
    ],
    video: '/author-training/lineup-form-guide.mp4',
    color: '#38bdf8',
  },
  defense: {
    title: 'Защита: как заполнить?',
    description: 'Собери понятный сетап: где стоят способности, какую зону они держат и что происходит при активации.',
    steps: ['Выбери карту', 'Покажи зону', 'Расставь способности', 'Займи позицию', 'Покажи активацию'],
    important: [
      'Записывай видео в 1920×1080 (Full HD), качество графики — не ниже «Среднего».',
      'Сначала покажи общий вид плента и зону, которую удерживает сетап.',
      'Отдельно и разборчиво покажи установку каждой способности.',
      'Покажи итоговую позицию игрока после установки всего сетапа.',
      'Заверши запись полной активацией и результатом при входе соперника.',
    ],
    video: '/author-training/defense-form-guide.mp4',
    color: '#ff4655',
  },
  combo: {
    title: 'Комбо: как заполнить?',
    description: 'Объясни связку без лишних слов: кто начинает, в каком порядке действуют игроки и когда срабатывает комбинация.',
    steps: ['Выбери агентов', 'Покажи позиции', 'Задай порядок', 'Попади в тайминг', 'Покажи результат'],
    important: [
      'Укажи всех агентов и способности, которые участвуют в комбинации.',
      'Покажи исходную позицию каждого участника до начала действий.',
      'Сохрани правильный порядок использования способностей и реальный тайминг.',
      'Не скрывай монтажом момент запуска или взаимодействия способностей.',
      'В конце обязательно покажи полный результат комбинации.',
    ],
    video: '/author-training/combo-form-guide.mp4',
    color: '#ffb23f',
  },
  wallbang: {
    title: 'Прострел: как заполнить?',
    description: 'Докажи прострел одним понятным фрагментом: оружие, позиция, точка прицела и нанесённый урон.',
    steps: ['Выбери оружие', 'Покажи позицию', 'Покажи стену', 'Зафиксируй прицел', 'Подтверди урон'],
    important: [
      'Покажи выбранное оружие, карту и точную стартовую позицию.',
      'Стена и ориентир прицела должны быть хорошо видны до выстрела.',
      'Не меняй позицию или настройки между показом ориентира и выстрелом.',
      'Запись должна подтверждать попадание и нанесённый противнику урон.',
      'Качество видео должно позволять повторить прострел без догадок.',
    ],
    video: '/author-training/wallbang-form-guide.mp4',
    color: '#ff5e91',
  },
};
const LINEUP_FORM_GUIDE_FIRST_VIEW_KEY = 'vl_lineup_form_guide_b8c491d_seen';
let categoryTrainingGateActive = false;
let activeCategoryFormGuide = null;

function renderCategoryFormGuide() {
  const category = normalizeContentCategory(selectedCategory || '');
  const config = CATEGORY_FORM_GUIDES[category];
  const guide = document.getElementById('category-form-guide');
  if (!guide) return;
  guide.hidden = !config;
  if (!config) return;
  guide.style.setProperty('--guide-accent', config.color);
  const title = document.getElementById('category-form-guide-title');
  if (title) title.textContent = config.title;
}

function closeCategoryFormGuide() {
  const modal = document.getElementById('category-form-guide-modal');
  const video = modal?.querySelector('video');
  if (video) {
    video.pause();
    video.removeAttribute('src');
    video.removeAttribute('data-guide-src');
    video.load();
    video.hidden = true;
  }
  const important = document.getElementById('category-form-guide-important');
  const importantButton = document.getElementById('category-form-guide-important-toggle');
  if (important) important.hidden = true;
  if (importantButton) importantButton.setAttribute('aria-expanded', 'false');
  if (modal) modal.hidden = true;
  document.body.classList.remove('category-form-guide-open');
}

function openCategoryFormGuide({ autoplay = false } = {}) {
  const category = normalizeContentCategory(selectedCategory || '');
  const config = CATEGORY_FORM_GUIDES[category];
  const modal = document.getElementById('category-form-guide-modal');
  if (!config || !modal) return;
  activeCategoryFormGuide = category;
  modal.style.setProperty('--guide-accent', config.color);
  document.getElementById('category-form-guide-dialog-title').textContent = config.title;
  document.getElementById('category-form-guide-description').textContent = config.description;
  document.getElementById('category-form-guide-steps').innerHTML = config.steps
    .map((step, index) => `<span><b>${String(index + 1).padStart(2, '0')}</b>${esc(step)}</span>`)
    .join('');
  const important = document.getElementById('category-form-guide-important');
  const importantList = document.getElementById('category-form-guide-important-list');
  const importantButton = document.getElementById('category-form-guide-important-toggle');
  if (importantList) {
    importantList.innerHTML = config.important
      .map(item => `<li><span>✓</span><p>${esc(item)}</p></li>`)
      .join('');
  }
  if (important) important.hidden = true;
  if (importantButton) importantButton.setAttribute('aria-expanded', 'false');
  const video = modal.querySelector('video');
  const placeholder = modal.querySelector('.category-form-guide-placeholder');
  video.hidden = true;
  placeholder.hidden = false;
  video.removeAttribute('src');
  video.load();
  video.dataset.guideSrc = config.video;
  video.src = `${config.video}?v=2026-07-27-category-guides-v1`;
  video.load();
  modal.hidden = false;
  document.body.classList.add('category-form-guide-open');
  if (autoplay) {
    video.addEventListener('canplay', () => {
      video.play().catch(() => {});
    }, { once: true });
  }
}

function showLineupFormGuideOnFirstCategoryChoice() {
  if (normalizeContentCategory(selectedCategory || '') !== 'lineup') return;
  try {
    if (localStorage.getItem(LINEUP_FORM_GUIDE_FIRST_VIEW_KEY) === '1') return;
    localStorage.setItem(LINEUP_FORM_GUIDE_FIRST_VIEW_KEY, '1');
  } catch (_) {
    // Storage can be unavailable in private/restricted browser contexts. The
    // guide should still open for the current category choice.
  }
  openCategoryFormGuide({ autoplay: true });
}

document.getElementById('category-form-guide-launch')?.addEventListener('click', () => openCategoryFormGuide());
document.getElementById('category-form-guide-important-toggle')?.addEventListener('click', event => {
  const panel = document.getElementById('category-form-guide-important');
  if (!panel) return;
  panel.hidden = !panel.hidden;
  event.currentTarget.setAttribute('aria-expanded', String(!panel.hidden));
});
document.querySelector('#category-form-guide-modal .category-form-guide-close')?.addEventListener('click', closeCategoryFormGuide);
document.getElementById('category-form-guide-modal')?.addEventListener('click', event => {
  if (event.target.id === 'category-form-guide-modal') closeCategoryFormGuide();
});
document.querySelector('#category-form-guide-modal video')?.addEventListener('loadedmetadata', event => {
  if (activeCategoryFormGuide !== normalizeContentCategory(selectedCategory || '')) return;
  event.currentTarget.hidden = false;
  document.querySelector('#category-form-guide-modal .category-form-guide-placeholder').hidden = true;
});
document.querySelector('#category-form-guide-modal video')?.addEventListener('error', event => {
  event.currentTarget.hidden = true;
  document.querySelector('#category-form-guide-modal .category-form-guide-placeholder').hidden = false;
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !document.getElementById('category-form-guide-modal')?.hidden) closeCategoryFormGuide();
});

function hasCategoryTraining(category) {
  const normalized = normalizeContentCategory(category);
  if (!CATEGORY_TRAINING_PATHS[normalized]) return true;
  return Boolean(currentUserProfile?.author_training_completed?.[normalized]);
}

function isTrainingCategoryAvailable(category) {
  const normalized = normalizeContentCategory(category);
  if (!CATEGORY_TRAINING_PATHS[normalized]) return false;
  const publicVisible = uploadCategoryAccess[`${normalized}_visible`] !== false;
  const staffVisible = canCurrentUserModerate()
    && uploadCategoryAccess[`${normalized}_staff_enabled`] === true;
  return publicVisible || staffVisible;
}

function trainingNoun(total) {
  const mod100 = total % 100;
  const mod10 = total % 10;
  if (mod100 >= 11 && mod100 <= 14) return '\u0438\u043d\u0441\u0442\u0440\u0443\u043a\u0442\u0430\u0436\u0435\u0439';
  if (mod10 === 1) return '\u0438\u043d\u0441\u0442\u0440\u0443\u043a\u0442\u0430\u0436';
  if (mod10 >= 2 && mod10 <= 4) return '\u0438\u043d\u0441\u0442\u0440\u0443\u043a\u0442\u0430\u0436\u0430';
  return '\u0438\u043d\u0441\u0442\u0440\u0443\u043a\u0442\u0430\u0436\u0435\u0439';
}

function renderAuthorTrainingProgress() {
  const completed = currentUserProfile?.author_training_completed || {};
  const availableCategories = Object.keys(CATEGORY_TRAINING_PATHS)
    .filter(category => isTrainingCategoryAvailable(category));
  const count = availableCategories
    .filter(category => Boolean(completed[category]))
    .length;
  const total = availableCategories.length;
  const countElement = document.getElementById('sidebar-training-count');
  const pointsElement = document.getElementById('sidebar-training-points');
  const barElement = document.getElementById('sidebar-training-bar');
  if (countElement) countElement.textContent = `${count} \u0438\u0437 ${total} ${trainingNoun(total)}`;
  if (pointsElement) pointsElement.textContent = `${count * 5} / ${total * 5}`;
  if (barElement) barElement.style.width = `${total > 0 ? count / total * 100 : 0}%`;
}

function showTrainingReturnFeedback() {
  const url = new URL(window.location.href);
  const category = normalizeContentCategory(url.searchParams.get('training_completed') || '');
  if (!CATEGORY_TRAINING_PATHS[category]) return;
  const labels = {
    lineup: 'Лайнапы',
    defense: 'Защита',
    combo: 'Комбо',
    wallbang: 'Прострелы',
  };
  const awarded = url.searchParams.get('training_awarded') === '1';
  toast(
    awarded
      ? `Отличная работа! Инструктаж «${labels[category]}» пройден — начислено +5 очков`
      : `Инструктаж «${labels[category]}» уже пройден. Доступ подтверждён`,
    's',
  );
  url.searchParams.delete('training_completed');
  url.searchParams.delete('training_awarded');
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

function updateCategoryTrainingGate() {
  const category = normalizeContentCategory(selectedCategory || '');
  renderCategoryFormGuide();
  document.querySelectorAll('#cat-row .pill-btn[data-val]').forEach(button => {
    const buttonCategory = normalizeContentCategory(button.dataset.val || '');
    const requiresTraining = Boolean(
      CATEGORY_TRAINING_PATHS[buttonCategory] &&
      !hasCategoryTraining(buttonCategory)
    );
    button.classList.toggle('training-required', requiresTraining);
    if (requiresTraining) {
      button.title = 'Сначала пройди инструктаж для этой категории';
      button.setAttribute('aria-label', `${button.textContent.trim()}: требуется инструктаж`);
    } else {
      button.removeAttribute('title');
      button.removeAttribute('aria-label');
    }
  });
  const trainingPath = CATEGORY_TRAINING_PATHS[category];
  categoryTrainingGateActive = Boolean(trainingPath && !hasCategoryTraining(category));
  const gate = document.getElementById('category-training-gate');
  const link = document.getElementById('category-training-link');
  if (gate) gate.hidden = !categoryTrainingGateActive;
  if (link && trainingPath) {
    const url = new URL(trainingPath, window.location.origin);
    url.searchParams.set('category', category);
    if (currentUser?.uid) url.searchParams.set('uid', currentUser.uid);
    url.searchParams.set('return', `${window.location.pathname}${window.location.search}`);
    link.href = url.toString();
  }

  const main = document.querySelector('#workspace-upload .main');
  const categoryCard = document.getElementById('cat-row')?.closest('.card');
  const gateIndex = main && gate ? [...main.children].indexOf(gate) : -1;
  if (main && categoryCard && gateIndex >= 0) {
    [...main.children].forEach((child, index) => {
      const locked = categoryTrainingGateActive && index > gateIndex && child.id !== 'category-form-guide';
      child.classList.toggle('training-locked-section', locked);
      if (locked) child.setAttribute('inert', '');
      else child.removeAttribute('inert');
    });
  }
  ['btn-save-draft', 'btn-reset-upload'].forEach(id => {
    const button = document.getElementById(id);
    if (button) button.disabled = categoryTrainingGateActive;
  });
  validateForm();
}

function openPendingLineupDeepLink() {
  if (!pendingLineupDeepLink) return;
  const lineup = findOwnLineup(pendingLineupDeepLink);
  if (!lineup) return;
  if (lineup.status === 'rejected') {
    myLineupsStatusFilter = 'rejected';
    document.querySelectorAll('#my-status-filter .filter-chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.status === 'rejected');
    });
  }
  switchWorkspaceTab('mine');
  openLineupDetail(lineup.id);
  pendingLineupDeepLink = '';
  const cleanUrl = new URL(window.location.href);
  cleanUrl.searchParams.delete('lineup');
  window.history.replaceState({}, '', cleanUrl);
}

// ── Stats sidebar ─────────────────────────────────────────────────────────────
let _statsUnsub = null;
let _cooldownInterval = null;
let _cooldownAccessUnsubs = [];
let _cooldownExempt = false;
let _badgeCooldownExempt = false;
let _entitlementCooldownExempt = false;
let _profileUnsubs = [];
let _profileParts = { public: {}, private: {}, stats: {}, auth: {} };

const LEVELS = [
  { min: 0,   name: 'Новобранец', icon: '🎯', color: '#94A3B8', gradient: ['#64748B', '#CBD5E1'], cooldownMinutes: 60 },
  { min: 3,   name: 'Разведчик',  icon: '🔍', color: '#4FC3F7', gradient: ['#0284C7', '#67E8F9'], cooldownMinutes: 45 },
  { min: 7,   name: 'Агент',      icon: '⚡', color: '#66BB6A', gradient: ['#16A34A', '#86EFAC'], cooldownMinutes: 30 },
  { min: 15,  name: 'Специалист', icon: '💎', color: '#AB47BC', gradient: ['#7C3AED', '#D8B4FE'], cooldownMinutes: 15 },
  { min: 30,  name: 'Ветеран',    icon: '🔥', color: '#FF7043', gradient: ['#EA580C', '#FDBA74'], cooldownMinutes: 5 },
  { min: 50,  name: 'Элита',      icon: '👑', color: '#FFD700', gradient: ['#CA8A04', '#FDE047'], cooldownMinutes: 2 },
  { min: 100, name: 'Легенда',    icon: '🏆', color: '#FF4655', gradient: ['#E11D48', '#FB7185'], cooldownMinutes: 0 },
];
let _approvedLineups = 0;

function effectiveApprovedLineups(factualApproved = 0) {
  return effectiveProgressPoints({
    publicProfile: _profileParts.public,
    stats: _profileParts.stats,
    factualApproved,
  });
}

function calculateLevel(approved) {
  return LEVELS.reduce((cur, lv) => approved >= lv.min ? lv : cur, LEVELS[0]);
}

function cooldownMinutesFor(approved) {
  if (_cooldownExempt) return 0;
  return calculateLevel(approved).cooldownMinutes;
}

function formatLevelCooldown(minutes) {
  if (minutes <= 0) return 'Без КД';
  if (minutes === 60) return 'КД: 1 час';
  const mod10 = minutes % 10;
  const mod100 = minutes % 100;
  const unit = mod10 === 1 && mod100 !== 11
    ? 'минута'
    : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
      ? 'минуты'
      : 'минут';
  return `КД: ${minutes} ${unit}`;
}

function levelPrivilegeText(minutes) {
  if (minutes <= 0) return 'Отправка лайнапов без ожидания';
  if (minutes === 60) return 'Новый лайнап можно отправлять раз в час';
  return `Новый лайнап можно отправлять каждые ${minutes} минут`;
}

let _profileLevelsReturnFocus = null;

function renderProfileLevels() {
  const list = document.getElementById('profile-levels-list');
  if (!list) return;
  const current = calculateLevel(_approvedLineups);
  const currentIndex = LEVELS.indexOf(current);
  list.classList.toggle('is-immune', _cooldownExempt);
  const rows = LEVELS.map((level, index) => {
    const state = index < currentIndex ? 'is-passed' : index === currentIndex ? 'is-current' : 'is-future';
    const status = index < currentIndex ? 'Пройдено' : index === currentIndex ? 'Текущий уровень' : 'Впереди';
    return `<article class="profile-level-row ${state}" style="--row-color:${level.color}">
      <span class="profile-level-row-icon" aria-hidden="true">${level.icon}</span>
      <span class="profile-level-row-copy">
        <strong>${level.name}</strong>
        <span>${levelPrivilegeText(level.cooldownMinutes)}</span>
      </span>
      <span class="profile-level-row-threshold">
        <b>От ${level.min} одобренных</b>
        <small>${status}</small>
      </span>
    </article>`;
  }).join('');
  list.innerHTML = `${rows}${_cooldownExempt ? `<div class="profile-immunity-notice" role="status">
    <span class="profile-immunity-pill" aria-hidden="true">💊</span>
    <span class="profile-immunity-kicker">БЕЙДЖ «БЕЗЛИМИТ» АКТИВЕН</span>
    <strong>А у вас есть иммунитет!</strong>
    <span>Поздравляем! Ограничение между отправками для вас полностью снято.</span>
  </div>` : ''}`;
}

function openProfileLevels() {
  const modal = document.getElementById('profile-levels-modal');
  if (!modal) return;
  _profileLevelsReturnFocus = document.activeElement;
  renderProfileLevels();
  modal.hidden = false;
  document.getElementById('profile-levels-close')?.focus();
}

function closeProfileLevels() {
  const modal = document.getElementById('profile-levels-modal');
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  _profileLevelsReturnFocus?.focus?.();
}

document.getElementById('profile-level-progress')?.addEventListener('click', openProfileLevels);

const statsSummaryToggle = document.getElementById('stats-summary-toggle');
const statsSummaryDetails = document.getElementById('stats-summary-details');
statsSummaryToggle?.addEventListener('click', () => {
  const expanded = statsSummaryToggle.getAttribute('aria-expanded') === 'true';
  statsSummaryToggle.setAttribute('aria-expanded', String(!expanded));
  if (!statsSummaryDetails) return;
  statsSummaryDetails.hidden = expanded;
  statsSummaryDetails.classList.toggle('is-opening', !expanded);
});
document.getElementById('profile-levels-close')?.addEventListener('click', closeProfileLevels);
document.getElementById('profile-levels-modal')?.addEventListener('click', event => {
  if (event.target.id === 'profile-levels-modal') closeProfileLevels();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !document.getElementById('profile-levels-modal')?.hidden) {
    closeProfileLevels();
  }
});

function _updateLevelDisplay(approved) {
  _approvedLineups = approved;
  const lv = calculateLevel(approved);
  const levelIndex = LEVELS.indexOf(lv);
  const next = LEVELS[levelIndex + 1] || null;
  const progress = next
    ? Math.max(0, Math.min(1, (approved - lv.min) / (next.min - lv.min)))
    : 1;
  document.getElementById('level-icon').textContent = lv.icon;
  const nameEl = document.getElementById('level-name');
  nameEl.textContent = lv.name;
  nameEl.style.color = lv.color;
  const progressName = document.getElementById('profile-level-progress-name');
  const progressValue = document.getElementById('profile-level-progress-value');
  const progressBar = document.getElementById('profile-level-progress-bar');
  const progressCooldown = document.getElementById('profile-level-cooldown');
  const progressNext = document.getElementById('profile-level-progress-next');
  const progressPanel = progressBar?.closest('.profile-level-progress');
  if (progressPanel) {
    progressPanel.style.setProperty('--level-color', lv.color);
    progressPanel.style.setProperty('--level-gradient-start', lv.gradient[0]);
    progressPanel.style.setProperty('--level-gradient-end', lv.gradient[1]);
  }
  if (progressName) {
    progressName.textContent = `${lv.icon} ${lv.name}`;
    progressName.style.color = lv.color;
  }
  if (progressValue) progressValue.textContent = next ? `${approved} / ${next.min}` : `${approved}`;
  if (progressBar) progressBar.style.width = `${progress * 100}%`;
  if (progressCooldown) {
    progressCooldown.textContent = _cooldownExempt ? '💊 Иммунитет' : formatLevelCooldown(lv.cooldownMinutes);
    progressCooldown.classList.toggle('is-immunity', _cooldownExempt);
  }
  if (progressNext) {
    progressNext.textContent = next
      ? `До уровня «${next.name}» осталось ${Math.max(0, next.min - approved)}`
      : `Максимальный уровень · ${approved} очков профиля`;
  }
  if (!document.getElementById('profile-levels-modal')?.hidden) renderProfileLevels();
}

function _clearCooldownTimer() {
  if (_cooldownInterval) { clearInterval(_cooldownInterval); _cooldownInterval = null; }
}

function _showCooldownReady() {
  _clearCooldownTimer();
  const badge = document.getElementById('cooldown-badge');
  if (badge) {
    badge.textContent = _cooldownExempt ? '⚡ Без КД' : '✓ Можно';
    badge.style.color = _cooldownExempt ? '#22d3ee' : 'var(--green)';
  }
}

function _publishCooldownAccess(uid) {
  _cooldownExempt = _badgeCooldownExempt || _entitlementCooldownExempt;
  _updateLevelDisplay(_approvedLineups);
  _updateCooldown(uid);
}

async function _refreshCooldownAccess(uid) {
  const [badgeResult, entitlementResult] = await Promise.allSettled([
    getDoc(doc(db, 'user_badges', uid)),
    getDoc(doc(db, 'account_entitlements', uid)),
  ]);
  if (badgeResult.status === 'fulfilled') _badgeCooldownExempt = badgeResult.value.data()?.cooldown_exempt === true;
  if (entitlementResult.status === 'fulfilled') _entitlementCooldownExempt = entitlementHasCooldownBypass(entitlementResult.value.data() || {});
  _publishCooldownAccess(uid);
  return badgeResult.status === 'fulfilled' && entitlementResult.status === 'fulfilled';
}

async function _subscribeCooldownAccess(uid) {
  _cooldownAccessUnsubs.forEach(unsubscribe => unsubscribe());
  _cooldownAccessUnsubs = [];
  _badgeCooldownExempt = false;
  _entitlementCooldownExempt = false;
  await _refreshCooldownAccess(uid);
  _cooldownAccessUnsubs = [
    onSnapshot(doc(db, 'user_badges', uid), snap => {
      _badgeCooldownExempt = snap.data()?.cooldown_exempt === true;
      _publishCooldownAccess(uid);
    }, () => {}),
    onSnapshot(doc(db, 'account_entitlements', uid), snap => {
      _entitlementCooldownExempt = entitlementHasCooldownBypass(snap.data() || {});
      _publishCooldownAccess(uid);
    }, () => {}),
  ];
}

function _startCooldownTimer(remainMs) {
  _clearCooldownTimer();
  const badge = document.getElementById('cooldown-badge');
  const startTime = Date.now();
  function tick() {
    const rem = remainMs - (Date.now() - startTime);
    if (rem <= 0) { _showCooldownReady(); return; }
    const mins = Math.floor(rem / 60000);
    const secs = Math.floor((rem % 60000) / 1000);
    if (badge) { badge.textContent = `КД: ${mins}:${String(secs).padStart(2, '0')}`; badge.style.color = 'var(--orange)'; }
  }
  tick();
  _cooldownInterval = setInterval(tick, 1000);
}

async function _updateCooldown(uid) {
  try {
    const rateDoc = await getDoc(doc(db, 'rate_limits', uid));
    const lastAt  = rateDoc.data()?.last_lineup_at?.toDate?.();
    if (!lastAt) { _showCooldownReady(); return; }
    const remainMs = remainingCooldownMs({ lastSubmittedAt:lastAt, cooldownMinutes:cooldownMinutesFor(_approvedLineups) });
    if (remainMs <= 0) { _showCooldownReady(); return; }
    _startCooldownTimer(remainMs);
  } catch { _showCooldownReady(); }
}

function _subscribeStats(uid) {
  if (_statsUnsub) { _statsUnsub(); _statsUnsub = null; }
  const q = query(collection(db, 'lineups'), where('user_id', '==', uid));
  _statsUnsub = onSnapshot(q, snap => {
    let approved = 0, pending = 0, rejected = 0, moderators = 0;
    currentUserLineups = [];
    snap.forEach(d => {
      const data = d.data();
      currentUserLineups.push({ id: d.id, ...data });
      const rawStatus = String(data.status || '').trim().toLowerCase();
      const s = lineupStatusGroup(rawStatus);
      if (s === 'approved') approved++;
      else if (s === 'rejected') rejected++;
      else if (rawStatus === 'moderator_draft') moderators++;
      else if (s === 'archived') return;
      else pending++;
    });
    currentUserLineups.sort((a, b) => {
      const at = b.submitted_at?.toMillis?.() || b.created_at?.toMillis?.() || 0;
      const bt = a.submitted_at?.toMillis?.() || a.created_at?.toMillis?.() || 0;
      return at - bt;
    });
    const statValues = { approved, pending, rejected, moderators };
    Object.entries(statValues).forEach(([key, value]) => {
      const element = document.getElementById(`stat-${key}`);
      if (element) element.textContent = value;
    });
    _updateLevelDisplay(effectiveApprovedLineups(approved));
    _updateCooldown(uid);
    renderAuthorWorkspace();
    updateCategoryTrainingGate();
    openPendingLineupDeepLink();
    const loader = document.getElementById('stats-loader');
    const cards = document.getElementById('stats-cards');
    if (loader) loader.style.display = 'none';
    if (cards) cards.style.display = 'flex';
  }, () => {
    const loader = document.getElementById('stats-loader');
    if (loader) loader.textContent = 'Ошибка загрузки';
    renderAuthorWorkspace();
  });
}

function _unsubscribeStats() {
  if (_statsUnsub) { _statsUnsub(); _statsUnsub = null; }
  _clearCooldownTimer();
  document.getElementById('stats-loader').style.display = '';
  document.getElementById('stats-loader').textContent   = 'Загрузка…';
  document.getElementById('stats-cards').style.display  = 'none';
  ['stat-approved', 'stat-pending', 'stat-rejected', 'stat-moderators'].forEach(id => {
    document.getElementById(id).textContent = '—';
  });
  currentUserLineups = [];
  renderAuthorWorkspace();
  const nameEl = document.getElementById('level-name');
  if (nameEl) { nameEl.textContent = '—'; nameEl.style.color = ''; }
  document.getElementById('level-icon').textContent = '—';
  _showCooldownReady();
}

function _subscribeUserProfile(uid) {
  _unsubscribeUserProfile();
  _profileParts = { public: {}, private: {}, stats: {}, auth: {} };
  const sources = [
    ['public', 'users'],
    ['private', 'user_private'],
    ['stats', 'user_stats'],
    ['auth', 'user_auth_links'],
  ];
  const refresh = () => {
    currentUserProfile = mergeUserLibraryParts(_profileParts);
    updateAdminOnlyWorkspace();
    updateUploadCategoryButtons();
    updateCategoryTrainingGate();
    renderAuthorTrainingProgress();
    const approvedDocs = currentUserLineups.filter(x => lineupStatusGroup(x.status) === 'approved').length;
    _updateLevelDisplay(effectiveApprovedLineups(approvedDocs));
    updateUploadGate();
    renderAuthorWorkspace();
    _updateCooldown(uid);
  };
  _profileUnsubs = sources.map(([key, collectionName]) => onSnapshot(
    doc(db, collectionName, uid),
    snap => {
      _profileParts[key] = snap.exists() ? snap.data() : {};
      refresh();
    },
    e => console.warn(`${collectionName} profile listener`, e.message),
  ));
}

function _unsubscribeUserProfile() {
  _profileUnsubs.forEach(unsubscribe => unsubscribe());
  _profileUnsubs = [];
  _profileParts = { public: {}, private: {}, stats: {}, auth: {} };
}

// ── Author workspace ─────────────────────────────────────────────────────────
function initWorkspaceTabs() {
  document.querySelectorAll('.workspace-tab,[data-profile-workspace]').forEach(btn => {
    btn.addEventListener('click', () => {
      switchWorkspaceTab(btn.dataset.workspaceTab || btn.dataset.profileWorkspace || 'upload');
      closeProfileCatalog();
    });
  });
  document.querySelectorAll('#my-status-filter .filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      myLineupsStatusFilter = btn.dataset.status || 'all';
      document.querySelectorAll('#my-status-filter .filter-chip').forEach(chip => {
        chip.classList.toggle('active', chip === btn);
      });
      renderAuthorWorkspace();
    });
  });
  document.getElementById('my-lineups-search')?.addEventListener('input', event => {
    myLineupsSearch = event.target.value.trim().toLowerCase();
    renderAuthorWorkspace();
  });
  document.querySelectorAll('.lineup-list').forEach(list => {
    list.addEventListener('click', event => {
      const deleteBtn = event.target.closest('[data-delete-lineup-id]');
      if (deleteBtn) {
        event.preventDefault();
        event.stopPropagation();
        deleteRejectedLineup(deleteBtn.dataset.deleteLineupId || '');
        return;
      }
      const card = event.target.closest('.lineup-card[data-lineup-id]');
      if (card) openLineupDetail(card.dataset.lineupId);
    });
    list.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const card = event.target.closest('.lineup-card[data-lineup-id]');
      if (!card) return;
      event.preventDefault();
      openLineupDetail(card.dataset.lineupId);
    });
  });
  document.getElementById('detail-close')?.addEventListener('click', closeLineupDetail);
  document.getElementById('lineup-detail-screen')?.addEventListener('click', event => {
    if (event.target.id === 'lineup-detail-screen') closeLineupDetail();
  });
  document.getElementById('copy-lineup-id')?.addEventListener('click', event => {
    const id = event.currentTarget.dataset.lineupId || '';
    if (!id) return;
    navigator.clipboard?.writeText(id).then(() => toast('ID скопирован', 's')).catch(() => toast('Не удалось скопировать ID', 'e'));
  });
  document.getElementById('detail-body')?.addEventListener('click', event => {
    const deleteBtn = event.target.closest('[data-delete-lineup-id]');
    if (deleteBtn) {
      event.preventDefault();
      deleteRejectedLineup(deleteBtn.dataset.deleteLineupId || '');
      return;
    }
    const copyBtn = event.target.closest('[data-copy-lineup-id]');
    if (copyBtn) {
      event.preventDefault();
      createDraftFromLineup(copyBtn.dataset.copyLineupId || '');
      return;
    }
    const resubmitBtn = event.target.closest('[data-resubmit-lineup-id]');
    if (!resubmitBtn) return;
    event.preventDefault();
    startRejectedResubmission(resubmitBtn.dataset.resubmitLineupId || '');
  });
  document.getElementById('resubmit-banner')?.addEventListener('click', event => {
    const btn = event.target.closest('[data-cancel-resubmission]');
    if (!btn) return;
    event.preventDefault();
    cancelResubmissionDraft();
  });
  document.getElementById('btn-save-draft')?.addEventListener('click', event => {
    event.preventDefault();
    if (moderatorDraftSourceId) {
      saveModeratorProgress();
      return;
    }
    saveCurrentDraftSnapshot();
  });
  document.querySelectorAll('[data-stat-filter]').forEach(card => {
    card.addEventListener('click', () => {
      const status = card.dataset.statFilter || 'all';
      myLineupsStatusFilter = status;
      document.querySelectorAll('#my-status-filter .filter-chip').forEach(chip => {
        chip.classList.toggle('active', chip.dataset.status === status);
      });
      switchWorkspaceTab('mine');
    });
  });
  document.getElementById('btn-cancel-moderation')?.addEventListener('click', event => {
    event.preventDefault();
    cancelResubmissionDraft();
  });
  document.getElementById('btn-reject-moderation')?.addEventListener('click', event => {
    event.preventDefault();
    rejectModeratorDraft();
  });
  document.getElementById('btn-reset-upload')?.addEventListener('click', event => {
    event.preventDefault();
    if (moderatorDraftSourceId) {
      if (!confirm('Сбросить все изменения формы? Исходное видео останется на месте.')) return;
      resetUploadForm({ keepDraft: true, keepVideo: true });
      toast('Поля сброшены, видео сохранено', 's');
      return;
    }
    if (!confirm('Полностью очистить форму и удалить несохранённые изменения?')) return;
    cancelResubmissionDraft({ skipConfirm: true, resetOnly: true });
  });
  document.getElementById('drafts-list')?.addEventListener('click', event => {
    const resume = event.target.closest('[data-draft-action="resume"]');
    const remove = event.target.closest('[data-draft-action="delete"]');
    if (resume) {
      event.preventDefault();
      resumeSavedDraft(resume.dataset.draftId || '');
      switchWorkspaceTab('upload');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    if (remove) {
      event.preventDefault();
      deleteSavedDraft(remove.dataset.draftId || '');
      renderAuthorWorkspace();
      toast('Черновик удалён', 's');
    }
  });
  document.getElementById('btn-refresh-workspace')?.addEventListener('click', async () => {
    if (currentUser) {
      await loadCurrentUserProfile(currentUser);
      if (activeWorkspaceTab === 'materials') {
        await loadAuthorMaterials({ force: true });
      }
      updateUploadGate();
      renderAuthorWorkspace();
      toast('Кабинет обновлён', 's');
    }
  });
  document.getElementById('btn-material-add')?.addEventListener('click', event => {
    event.preventDefault();
    openMaterialForm();
  });
  document.getElementById('material-form-shell')?.addEventListener('click', event => {
    const cancel = event.target.closest('[data-material-cancel]');
    const save = event.target.closest('[data-material-save]');
    if (cancel) {
      event.preventDefault();
      closeMaterialForm();
    }
    if (save) {
      event.preventDefault();
      saveAuthorMaterial();
    }
  });
  document.getElementById('material-form-shell')?.addEventListener('change', event => {
    const input = event.target.closest('#material-video-file');
    if (!input) return;
    const file = input.files?.[0];
    if (file) uploadMaterialVideoFile(file);
  });
  document.getElementById('materials-list')?.addEventListener('click', event => {
    const edit = event.target.closest('[data-material-edit]');
    const remove = event.target.closest('[data-material-delete]');
    const toggle = event.target.closest('[data-material-toggle]');
    if (edit) {
      event.preventDefault();
      openMaterialForm(edit.dataset.materialEdit || '');
    }
    if (remove) {
      event.preventDefault();
      deleteAuthorMaterial(remove.dataset.materialDelete || '');
    }
    if (toggle) {
      event.preventDefault();
      toggleAuthorMaterial(toggle.dataset.materialToggle || '');
    }
  });
}

function workspacePanel(tab) {
  return document.getElementById(`workspace-${tab || 'upload'}`);
}

function pauseMediaTree(root, { releaseNetwork = false } = {}) {
  if (!root) return;
  root.querySelectorAll('video, audio').forEach(media => {
    try { media.pause(); } catch (_) {}
    if (!releaseNetwork || !media.getAttribute('src')) return;
    const currentTime = Number(media.currentTime || 0);
    if (Number.isFinite(currentTime) && currentTime > 0) {
      media.dataset.workspaceSuspendedTime = String(currentTime);
    }
    media.dataset.workspaceSuspendedSrc = media.getAttribute('src');
    media.removeAttribute('src');
    try { media.load(); } catch (_) {}
  });
}

function restoreMediaTree(root) {
  if (!root) return;
  root.querySelectorAll('video[data-workspace-suspended-src], audio[data-workspace-suspended-src]').forEach(media => {
    const source = media.dataset.workspaceSuspendedSrc || '';
    const restoreTime = Number(media.dataset.workspaceSuspendedTime || 0);
    delete media.dataset.workspaceSuspendedSrc;
    delete media.dataset.workspaceSuspendedTime;
    if (!source) return;
    if (restoreTime > 0) {
      media.addEventListener('loadedmetadata', () => {
        const duration = Number(media.duration || 0);
        try { media.currentTime = duration > 0 ? Math.min(restoreTime, Math.max(0, duration - 0.05)) : restoreTime; } catch (_) {}
      }, { once: true });
    }
    media.setAttribute('src', source);
    try { media.load(); } catch (_) {}
  });
}

function deactivateWorkspaceTab(tab) {
  const panel = workspacePanel(tab);
  if (tab === 'upload') {
    stopOutputPlayback({ keepPreview: true });
    clearFreezeHold();
    stopSmoothTimelineUi();
    stopChromaPreview();
    try { vidPlayer.pause(); } catch (_) {}
    try { editorEls.footagePreview?.pause(); } catch (_) {}
    closeCategoryFormGuide();
    pauseMediaTree(panel, { releaseNetwork: true });
  } else if (tab === 'moderation') {
    moderationController?.deactivate?.();
    pauseMediaTree(panel, { releaseNetwork: true });
  } else {
    if (tab === 'materials') stopMaterialWorkspaceActivity();
    pauseMediaTree(panel, { releaseNetwork: true });
  }
  closeLineupDetail();
  document.dispatchEvent(new CustomEvent('workspace:deactivate', { detail: { tab, panel } }));
}

function activateWorkspaceTab(tab) {
  const panel = workspacePanel(tab);
  restoreMediaTree(panel);
  if (tab === 'upload') {
    updateTimelinePlaybackUi();
  }
  document.dispatchEvent(new CustomEvent('workspace:activate', { detail: { tab, panel } }));
}

function pauseAllSiteMedia() {
  document.querySelectorAll('video, audio').forEach(media => {
    try { media.pause(); } catch (_) {}
  });
  stopOutputPlayback({ keepPreview: true });
  clearFreezeHold();
  stopSmoothTimelineUi();
  stopChromaPreview();
}

function switchWorkspaceTab(tab) {
  const nextTab = tab === 'rejected' ? 'mine' : (tab || 'upload');
  if (nextTab === 'moderation' && !canCurrentUserModerate()) return;
  const previousTab = activeWorkspaceTab;
  if (previousTab !== nextTab) deactivateWorkspaceTab(previousTab);
  activeWorkspaceTab = nextTab;
  document.querySelectorAll('.workspace-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.workspaceTab === activeWorkspaceTab);
  });
  document.querySelectorAll('[data-profile-workspace]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.profileWorkspace === activeWorkspaceTab);
  });
  document.querySelectorAll('.workspace-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `workspace-${activeWorkspaceTab}`);
  });
  document.body.dataset.workspaceSection = activeWorkspaceTab;
  document.getElementById('header-moderation')?.classList.toggle('active', activeWorkspaceTab === 'moderation');
  if (previousTab !== activeWorkspaceTab) activateWorkspaceTab(activeWorkspaceTab);
  if (activeWorkspaceTab === 'materials') loadAuthorMaterials();
  if (activeWorkspaceTab === 'moderation') loadModerationWorkspace();
  if (activeWorkspaceTab === 'admin-chat') openAdminChat();
  if (activeWorkspaceTab === 'notifications') renderSiteNotifications();
  renderAuthorWorkspace();
  scheduleSitePresence();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    pauseAllSiteMedia();
    moderationController?.deactivate?.();
    return;
  }
  if (activeWorkspaceTab === 'moderation') loadModerationWorkspace();
});

const MODERATION_MOVED_HINT_KEY = 'vl_moderation_moved_hint_20260730';
const PROFILE_CATALOG_HINT_KEY = 'vl_profile_catalog_hint_20260821';

function closeProfileCatalog() {
  const trigger = document.getElementById('profile-catalog-trigger');
  const catalog = document.getElementById('profile-catalog');
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
  if (catalog) catalog.hidden = true;
}

function dismissProfileCatalogHint() {
  const hint = document.getElementById('profile-catalog-hint');
  if (hint) hint.hidden = true;
  localStorage.setItem(PROFILE_CATALOG_HINT_KEY, '1');
}

function showProfileCatalogHint() {
  const hint = document.getElementById('profile-catalog-hint');
  if (hint) hint.hidden = localStorage.getItem(PROFILE_CATALOG_HINT_KEY) === '1';
}

document.getElementById('profile-catalog-trigger')?.addEventListener('click', event => {
  event.stopPropagation();
  const trigger = event.currentTarget;
  const catalog = document.getElementById('profile-catalog');
  const expanded = trigger.getAttribute('aria-expanded') === 'true';
  trigger.setAttribute('aria-expanded', String(!expanded));
  if (catalog) catalog.hidden = expanded;
  dismissProfileCatalogHint();
});
document.getElementById('profile-catalog')?.addEventListener('click', event => event.stopPropagation());
document.getElementById('profile-catalog-hint-close')?.addEventListener('click', event => {
  event.stopPropagation();
  dismissProfileCatalogHint();
});
document.addEventListener('click', closeProfileCatalog);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeProfileCatalog();
});

function dismissModerationMovedHint() {
  const hint = document.getElementById('moderation-moved-hint');
  if (hint) hint.hidden = true;
  localStorage.setItem(MODERATION_MOVED_HINT_KEY, '1');
}

function updateModerationMovedHint(canModerate) {
  const hint = document.getElementById('moderation-moved-hint');
  if (!hint) return;
  hint.hidden = !canModerate || localStorage.getItem(MODERATION_MOVED_HINT_KEY) === '1';
}

document.getElementById('header-moderation')?.addEventListener('click', () => {
  if (!canCurrentUserModerate()) {
    openModApplication();
    return;
  }
  dismissModerationMovedHint();
  switchWorkspaceTab('moderation');
  document.getElementById('workspace-moderation')?.scrollIntoView({ behavior:'smooth', block:'start' });
});
document.getElementById('moderation-moved-close')?.addEventListener('click', dismissModerationMovedHint);

function openNotificationsWorkspace({ behavior = 'smooth' } = {}) {
  switchWorkspaceTab('notifications');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const list = document.getElementById('notifications-list');
      const newest = list?.querySelector('.notification-card');
      const target = newest || document.querySelector('#workspace-notifications .notifications-shell');
      target?.scrollIntoView({ behavior, block:'start', inline:'nearest' });
    });
  });
}

let adminChatUnsub = null;
let adminChatDoc = null;
let adminChatItems = [];
let activeAdminChatId = '';
let adminChatSnapshotReady = false;
let adminChatLastAdminTs = 0;
const adminChatId = uid => `moderator_application_${uid}`;

async function sendSitePresence() {
  if (!currentUser || document.visibilityState === 'hidden') return;
  try {
    const token = await currentUser.getIdToken();
    await fetch('/api/site-presence', {
      method:'POST',
      headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
      credentials:'same-origin',
      keepalive:true,
      body:JSON.stringify({
        display_name:authorDisplayName() || currentUser.displayName || 'Пользователь',
        page:activeWorkspaceTab || 'upload',
      }),
    });
  } catch (_) {}
}
let sitePresenceTimer = null;
let sitePresenceDebounce = null;
function scheduleSitePresence() {
  clearTimeout(sitePresenceDebounce);
  sitePresenceDebounce = setTimeout(sendSitePresence, 180);
}
function startSitePresence() {
  clearInterval(sitePresenceTimer);
  scheduleSitePresence();
  sitePresenceTimer = setInterval(sendSitePresence, 60 * 1000);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentUser) scheduleSitePresence();
});

let siteNotificationsUnsub = null;
let siteNotifications = [];
let siteNotificationsReady = false;
let knownSiteNotificationIds = new Set();
let expandedSiteNotificationId = '';
const moderationAuthorCache = new Map();

function notificationTimestamp(value) {
  if (typeof value?.toDate === 'function') return value.toDate();
  return new Date(Number(value) || Date.now());
}

function notificationIcon(item) {
  if (item.type === 'author_training_completed' || item.type === 'author_training_criteria_updated') return '🎓';
  if (item.type === 'lineup_hot' || item.type === 'lineups_hot_batch') return '🔥';
  if (item.type === 'lineup_approved') return '✅';
  if (item.type === 'lineup_rejected') return '↩';
  if (item.type === 'duel_win') return '🏆';
  return '🔔';
}

function notificationDate(value) {
  return notificationTimestamp(value).toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
}

function updateNotificationBadges() {
  const unread = siteNotifications.filter(item => item.is_read !== true).length;
  const headerBadge = document.getElementById('header-notifications-badge');
  const tabBadge = document.getElementById('notifications-tab-badge');
  if (headerBadge) { headerBadge.hidden = unread === 0; headerBadge.textContent = unread > 99 ? '99+' : String(unread); }
  if (tabBadge) { tabBadge.hidden = unread === 0; tabBadge.textContent = unread > 99 ? '99+' : String(unread); }
}

function notificationBatchDetails(item) {
  const ids = [...new Set([
    ...(Array.isArray(item.lineup_ids) ? item.lineup_ids : []),
    item.lineup_id,
  ].filter(Boolean))];
  const count = Number(item.lineup_count) || ids.length;
  if (!ids.length) return '';
  return `<div class="notification-batch">
    <div class="notification-batch-heading"><b>Лайнапы в пачке</b><span>${count}</span></div>
    <div class="notification-batch-list">${ids.map((id, index) => {
      const lineup = findOwnLineup(id) || {};
      const title = firstText(lineup.title, ids.length === 1 ? item.lineup_title : '', `Лайнап ${index + 1}`);
      const meta = [firstText(lineup.map, ids.length === 1 ? item.map : ''), firstText(lineup.agent, ids.length === 1 ? item.agent : ''), firstText(lineup.ability, ids.length === 1 ? item.ability : '')].filter(Boolean);
      return `<div class="notification-batch-item">
        <div><b>${esc(title)}</b>${meta.length ? `<span>${meta.map(esc).join(' · ')}</span>` : ''}</div>
        <button class="copy-id-btn" type="button" data-open-notification-lineup="${esc(id)}">Открыть</button>
      </div>`;
    }).join('')}</div>
  </div>`;
}

function renderSiteNotifications() {
  const list = document.getElementById('notifications-list');
  if (!list) return;
  if (!siteNotifications.length) {
    list.innerHTML = '<div class="notifications-empty"><strong>Пока тихо</strong><br>Когда модератор примет решение по лайнапу, оно появится здесь.</div>';
    return;
  }
  list.innerHTML = siteNotifications.map(item => {
    const lineup = findOwnLineup(item.lineup_id || '') || {};
    const isBatch = item.type === 'lineups_hot_batch' || item.type === 'lineups_approved_batch' || (Array.isArray(item.lineup_ids) && item.lineup_ids.length > 1);
    const reason = item.type === 'lineup_rejected' ? firstText(item.reason, lineup.rejection_reason, lineup.reject_reason, lineup.moderation_reason, item.body) : '';
    const roundSide = firstText(item.round_side, lineup.round_side);
    const details = [
      ['От кого', firstText(item.submitted_by, lineup.submitted_by)],
      ['Название', firstText(item.lineup_title, lineup.title)],
      ['Карта', firstText(item.map, lineup.map)],
      ['Агент', firstText(item.agent, lineup.agent)],
      ['Способность', firstText(item.ability, lineup.ability)],
      ['Сторона', roundSide ? roundSideLabel(roundSide) : ''],
    ].filter(([, value]) => value);
    const actionPath = String(item.action_path || '');
    const canOpenAction = actionPath.startsWith('/') && !actionPath.startsWith('//');
    const canExpand = isBatch || details.length > 0 || Boolean(reason) || Boolean(lineup.id) || canOpenAction;
    const expanded = canExpand && expandedSiteNotificationId === item.id;
    return `
    <article class="notification-card ${item.is_read === true ? '' : 'unread'} ${expanded ? 'expanded' : ''}" data-site-notification="${esc(item.id)}" data-can-expand="${canExpand}" tabindex="0"${canExpand ? ` aria-expanded="${expanded}"` : ''}>
      <div class="notification-card-icon">${notificationIcon(item)}</div>
      <div><h3>${esc(item.title || 'Уведомление')}</h3><p>${esc(item.body || '')}</p>${canExpand ? `<span class="notification-expand-hint">${expanded ? 'Скрыть подробности' : 'Нажми, чтобы прочитать полностью'}</span>` : ''}${item.cooldown_reset ? '<span class="notification-cooldown">✓ КД на отправку сброшено</span>' : ''}</div>
      <time>${notificationDate(item.created_at)}</time>
      ${expanded ? `<div class="notification-details">
        ${isBatch ? notificationBatchDetails(item) : (details.length ? `<div class="notification-details-grid">${details.map(([label, value]) => `<div><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join('')}</div>` : '')}
        ${reason ? `<div class="notification-reason"><span>Полная причина</span><p>${esc(reason)}</p></div>` : ''}
        ${!isBatch && lineup.id ? `<button class="copy-id-btn" type="button" data-open-notification-lineup="${esc(lineup.id)}">Открыть карточку лайнапа</button>` : ''}
        ${canOpenAction ? `<button class="copy-id-btn" type="button" data-notification-action="${esc(actionPath)}">${esc(item.action_label || 'Открыть')}</button>` : ''}
      </div>` : ''}
    </article>`;
  }).join('');
}

async function markSiteNotificationRead(id) {
  const item = siteNotifications.find(value => value.id === id);
  if (!item || item.is_read === true || !currentUser) return;
  item.is_read = true;
  updateNotificationBadges();
  renderSiteNotifications();
  await updateDoc(doc(db, 'notifications', currentUser.uid, 'items', id), { is_read:true, read_at:serverTimestamp() }).catch(() => {});
}

function showIncomingNotification(item) {
  const host = document.getElementById('notification-banners');
  if (!host) return;
  const banner = document.createElement('div');
  banner.className = 'notification-banner';
  banner.innerHTML = `<div class="notification-banner-icon">${notificationIcon(item)}</div><div><strong>${esc(item.title || 'Новое уведомление')}</strong><span>${esc(item.body || '')}</span></div><button type="button" aria-label="Закрыть">×</button>`;
  banner.addEventListener('click', event => {
    if (event.target.closest('button')) { banner.remove(); return; }
    openNotificationsWorkspace();
    markSiteNotificationRead(item.id);
    banner.remove();
  });
  host.prepend(banner);
  while (host.children.length > 3) host.lastElementChild?.remove();
  setTimeout(() => banner.remove(), 9000);
  playSiteSound('notification');
}

let browserPushPromise = null;
const PUSH_PROMPT_REQUESTED_KEY = 'vl_push_prompt_requested';

async function persistNotificationChannelStatus(OneSignal = null) {
  if (!currentUser) return;
  const permission = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  const subscription = OneSignal?.User?.PushSubscription;
  const subscribed = typeof subscription?.optedIn === 'boolean' ? subscription.optedIn : null;
  try {
    await setDoc(doc(db, 'users', currentUser.uid, 'notification_settings', 'channels'), {
      site_notifications_enabled: true,
      site_checked_at: serverTimestamp(),
      push_permission: permission,
      push_prompt_requested: localStorage.getItem(PUSH_PROMPT_REQUESTED_KEY) === '1',
      push_subscribed: subscribed,
      push_subscription_id: subscription?.id || null,
      push_checked_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    }, { merge: true });
  } catch (error) {
    console.warn('notification channel status', error?.message || error);
  }
}

async function hydrateLegacyModerationAuthors(items) {
  const missing = items.filter(item =>
    item.type === 'moderation_work'
    && item.lineup_id
    && !firstText(item.submitted_by, moderationAuthorCache.get(item.lineup_id)));
  if (!missing.length) return;
  await Promise.all(missing.map(async item => {
    const lineupId = String(item.lineup_id);
    if (!moderationAuthorCache.has(lineupId)) {
      const snapshot = await getDoc(doc(db, 'lineups', lineupId)).catch(() => null);
      moderationAuthorCache.set(lineupId, snapshot?.exists() ? firstText(snapshot.data()?.submitted_by) : '');
    }
    item.submitted_by = moderationAuthorCache.get(lineupId) || '';
  }));
  renderSiteNotifications();
}

function updateBrowserPushButton() {
  const button = document.getElementById('browser-push-toggle');
  if (!button) return;
  const permission = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  button.classList.toggle('enabled', permission === 'granted');
  button.classList.toggle('blocked', permission === 'denied' || permission === 'unsupported');
  button.textContent = permission === 'granted'
    ? '✓ Push включены'
    : permission === 'denied'
      ? 'Push заблокированы'
      : permission === 'unsupported'
        ? 'Push не поддерживаются'
        : 'Включить push';
}

async function initializeBrowserPush(uid = currentUser?.uid) {
  if (!('serviceWorker' in navigator) || typeof Notification === 'undefined') {
    updateBrowserPushButton();
    await persistNotificationChannelStatus();
    return null;
  }
  if (!browserPushPromise) {
    browserPushPromise = fetch(`/api/push-config?t=${Date.now()}`, { cache: 'no-store' })
      .then(response => response.ok ? response.json() : null)
      .then(config => {
        if (!config?.enabled || !config?.appId) return null;
        return new Promise((resolve, reject) => {
          window.OneSignalDeferred = window.OneSignalDeferred || [];
          window.OneSignalDeferred.push(async OneSignal => {
            try {
              await OneSignal.init({
                appId: config.appId,
                serviceWorkerPath: '/OneSignalSDKWorker.js',
                serviceWorkerParam: { scope: '/' },
                notifyButton: { enable: false },
              });
              resolve(OneSignal);
            } catch (error) {
              reject(error);
            }
          });
        });
      })
      .catch(error => {
        console.warn('browser push init', error?.message || error);
        return null;
      });
  }
  const OneSignal = await browserPushPromise;
  if (OneSignal && uid) await OneSignal.login(uid).catch(() => {});
  if (OneSignal && Notification.permission === 'granted') {
    await OneSignal.User.PushSubscription.optIn().catch(() => {});
    await OneSignal.User.addTag('site_update_notifications', '1').catch(() => {});
  }
  await persistNotificationChannelStatus(OneSignal);
  updateBrowserPushButton();
  return OneSignal;
}

async function enableBrowserPush() {
  const OneSignal = await initializeBrowserPush();
  if (!OneSignal) {
    toast('Web Push пока не настроен на сервере.', 'e');
    return;
  }
  if (Notification.permission === 'denied') {
    toast('Разреши уведомления для vlineups.ru в настройках браузера.', 'e');
    updateBrowserPushButton();
    return;
  }
  localStorage.setItem(PUSH_PROMPT_REQUESTED_KEY, '1');
  await persistNotificationChannelStatus(OneSignal);
  await OneSignal.Notifications.requestPermission();
  if (Notification.permission !== 'granted') {
    await persistNotificationChannelStatus(OneSignal);
    toast('Без разрешения браузер не сможет показывать push.', 'i');
    updateBrowserPushButton();
    return;
  }
  await OneSignal.User.PushSubscription.optIn().catch(() => {});
  await OneSignal.User.addTag('site_update_notifications', '1');
  if (currentUser?.uid) await OneSignal.login(currentUser.uid).catch(() => {});
  await persistNotificationChannelStatus(OneSignal);
  updateBrowserPushButton();
  toast('Push об обновлениях сайта включены', 's');
}

function showNotificationsIntro(uid) {
  const key = `notifications-intro-v1:${uid}`;
  if (localStorage.getItem(key)) return;
  localStorage.setItem(key, '1');
  setTimeout(() => { const intro = document.getElementById('notifications-intro'); if (intro) intro.hidden = false; }, 900);
}

function startSiteNotifications(uid) {
  siteNotificationsUnsub?.();
  siteNotificationsReady = false;
  knownSiteNotificationIds = new Set();
  const inbox = query(collection(db, 'notifications', uid, 'items'), limit(50));
  siteNotificationsUnsub = onSnapshot(inbox, snap => {
    const next = snap.docs.map(entry => ({ id:entry.id, ...entry.data() }))
      .sort((a, b) => notificationTimestamp(b.created_at) - notificationTimestamp(a.created_at));
    if (siteNotificationsReady) {
      const incoming = next.filter(item => !knownSiteNotificationIds.has(item.id));
      incoming.slice(0, 3).reverse().forEach(showIncomingNotification);
      if (incoming.some(item => item.cooldown_reset === true) && currentUser) _updateCooldown(currentUser.uid);
    } else {
      const trainingNotice = next.find(item =>
        ['author_training_completed', 'author_training_criteria_updated'].includes(item.type)
        && item.is_read !== true);
      if (trainingNotice) {
        const bannerKey = `author-training-banner-v1:${uid}:${trainingNotice.id}`;
        if (!localStorage.getItem(bannerKey)) {
          localStorage.setItem(bannerKey, '1');
          showIncomingNotification(trainingNotice);
        }
      }
    }
    siteNotifications = next;
    knownSiteNotificationIds = new Set(next.map(item => item.id));
    siteNotificationsReady = true;
    updateNotificationBadges();
    renderSiteNotifications();
    void hydrateLegacyModerationAuthors(siteNotifications);
  }, error => {
    const list = document.getElementById('notifications-list');
    if (list) list.innerHTML = `<div class="notifications-empty">Не удалось загрузить уведомления: ${esc(error.message)}</div>`;
  });
  persistNotificationChannelStatus().catch(() => {});
  showNotificationsIntro(uid);
}

document.getElementById('header-notifications')?.addEventListener('click', () => openNotificationsWorkspace());
document.getElementById('browser-push-toggle')?.addEventListener('click', enableBrowserPush);
document.getElementById('header-sound-test')?.addEventListener('click', async () => {
  const nextEnabled = !siteSoundsEnabled;
  setSiteSoundsEnabled(nextEnabled);
  if (!nextEnabled) {
    toast('Звуки сайта выключены', 's');
    return;
  }
  await unlockSiteAudio();
  if (!siteAudioUnlocked) {
    toast('Браузер заблокировал звук. Разреши звук для vlineups.ru.', 'e');
    return;
  }
  playSiteSound('notification', false);
  toast('Звуки сайта включены', 's');
});
document.getElementById('notifications-list')?.addEventListener('click', event => {
  const notificationAction = event.target.closest('[data-notification-action]');
  if (notificationAction) {
    event.stopPropagation();
    const path = notificationAction.dataset.notificationAction || '';
    if (path.startsWith('/') && !path.startsWith('//')) window.location.href = path;
    return;
  }
  const openLineup = event.target.closest('[data-open-notification-lineup]');
  if (openLineup) {
    event.stopPropagation();
    openLineupDetail(openLineup.dataset.openNotificationLineup || '');
    return;
  }
  const card = event.target.closest('[data-site-notification]');
  if (card) {
    if (card.dataset.canExpand === 'true') {
      expandedSiteNotificationId = expandedSiteNotificationId === card.dataset.siteNotification ? '' : card.dataset.siteNotification;
    }
    markSiteNotificationRead(card.dataset.siteNotification);
    renderSiteNotifications();
  }
});
document.getElementById('notifications-list')?.addEventListener('keydown', event => {
  if (!['Enter', ' '].includes(event.key)) return;
  const card = event.target.closest('[data-site-notification]');
  if (!card) return;
  event.preventDefault();
  card.click();
});
document.getElementById('notifications-mark-all')?.addEventListener('click', async () => {
  if (!currentUser) return;
  const unread = siteNotifications.filter(item => item.is_read !== true);
  if (!unread.length) { toast('Непрочитанных уведомлений нет', 'i'); return; }
  const batch = writeBatch(db);
  unread.forEach(item => batch.update(doc(db, 'notifications', currentUser.uid, 'items', item.id), { is_read:true, read_at:serverTimestamp() }));
  await batch.commit();
  toast('Все уведомления прочитаны', 's');
});
document.getElementById('notifications-intro')?.addEventListener('click', event => {
  const action = event.target.closest('[data-notifications-intro]')?.dataset.notificationsIntro;
  if (!action) return;
  event.currentTarget.hidden = true;
  if (action === 'open') openNotificationsWorkspace();
});

function newestAdminMessageTs(data) {
  const threadLatest = (Array.isArray(data?.thread) ? data.thread : [])
    .filter(message => message.from === 'admin')
    .reduce((latest, message) => Math.max(latest, Number(message.ts) || 0), 0);
  return Math.max(
    threadLatest,
    data?.reply ? feedbackTimestamp(data.replied_at || data.updated_at || data.created_at) : 0,
  );
}

function playIncomingChatSound() {
  playSiteSound('notification');
}

function chatMessageTime(ts) {
  const date = typeof ts?.toDate === 'function' ? ts.toDate() : new Date(Number(ts) || Date.now());
  return date.toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
}

function feedbackTimestamp(value) {
  if (typeof value?.toDate === 'function') return value.toDate().getTime();
  return Number(value) || 0;
}

function feedbackMessages(data) {
  const thread = Array.isArray(data?.thread) ? [...data.thread] : [];
  if (thread.length) return thread;
  const messages = [];
  if (data?.text) messages.push({ from:'user', text:data.text, ts:feedbackTimestamp(data.created_at) });
  if (data?.reply) messages.push({ from:'admin', text:data.reply, ts:feedbackTimestamp(data.replied_at || data.updated_at || data.created_at) });
  return messages;
}

function feedbackLastTimestamp(item) {
  const messages = feedbackMessages(item);
  return Math.max(
    feedbackTimestamp(item.updated_at),
    feedbackTimestamp(item.created_at),
    ...messages.map(message => feedbackTimestamp(message.ts)),
  );
}

function feedbackTitle(item) {
  if (item.id === adminChatId(currentUser?.uid)) return 'Чат с администрацией';
  return firstText(item.subject, item.category, 'Обращение');
}

function feedbackPreview(item) {
  const messages = feedbackMessages(item);
  return firstText(messages.at(-1)?.text, item.text, 'Сообщений пока нет');
}

function isMainAdminChat(itemOrId) {
  const id = typeof itemOrId === 'string' ? itemOrId : itemOrId?.id;
  return id === adminChatId(currentUser?.uid);
}

function renderAdminChatList() {
  const list = document.getElementById('admin-chat-list');
  if (!list || !currentUser) return;
  const mainId = adminChatId(currentUser.uid);
  const main = adminChatItems.find(item => item.id === mainId) || { id:mainId, status:'open' };
  const regular = adminChatItems
    .filter(item => item.id !== mainId)
    .sort((a, b) => feedbackLastTimestamp(b) - feedbackLastTimestamp(a));
  const open = regular.filter(item => item.status !== 'closed');
  const closed = regular.filter(item => item.status === 'closed');
  const dialog = (item, { pinned = false } = {}) => {
    const unread = item.user_unread === true || (item.reply && item.reply_read !== true);
    const timestamp = feedbackLastTimestamp(item);
    const date = timestamp ? new Date(timestamp).toLocaleDateString('ru-RU', { day:'2-digit', month:'2-digit' }) : '';
    const classes = ['messenger-dialog', pinned ? 'pinned' : '', item.status === 'closed' ? 'closed' : '', item.id === activeAdminChatId ? 'active' : ''].filter(Boolean).join(' ');
    return `<button type="button" class="${classes}" data-admin-dialog="${esc(item.id)}">
      <span class="messenger-dialog-icon">${pinned ? '◆' : item.status === 'closed' ? '✓' : '◌'}</span>
      <span class="messenger-dialog-copy"><b>${esc(feedbackTitle(item))}</b><span>${esc(feedbackPreview(item))}</span></span>
      <span class="messenger-dialog-meta">${date}${unread ? '<i class="messenger-unread">1</i>' : ''}</span>
    </button>`;
  };
  const group = (title, items) => items.length ? `<section class="messenger-group"><div class="messenger-group-title"><span>${title}</span><span>${items.length}</span></div>${items.map(item => dialog(item)).join('')}</section>` : '';
  list.innerHTML = `${dialog(main, { pinned:true })}
    ${group('Открытые обращения', open)}
    ${group('Закрытые', closed)}
    ${regular.length ? '' : '<div class="messenger-list-state">Здесь появятся обращения, которые ты отправишь через приложение.</div>'}`;
}

function renderAdminChat(data) {
  const newestAdminTs = newestAdminMessageTs(data);
  if (adminChatSnapshotReady && newestAdminTs > adminChatLastAdminTs) playIncomingChatSound();
  adminChatLastAdminTs = Math.max(adminChatLastAdminTs, newestAdminTs);
  adminChatSnapshotReady = true;
  adminChatDoc = data || null;
  const mainChat = isMainAdminChat(activeAdminChatId);
  const closed = !mainChat && data?.status === 'closed';
  const thread = document.getElementById('admin-chat-thread');
  const messages = feedbackMessages(data);
  if (thread) {
    thread.innerHTML = messages.length ? messages.map(message => {
      const mine = message.from === 'user';
      return `<div class="admin-chat-row ${mine ? 'mine' : 'theirs'}"><div class="admin-chat-bubble"><div>${esc(message.text || '')}</div><time>${chatMessageTime(message.ts)}</time></div></div>`;
    }).join('') : `<div class="admin-chat-empty">${mainChat ? 'Это постоянный чат с администрацией. Ты можешь написать первым.' : 'В этом обращении пока нет сообщений.'}</div>`;
    thread.scrollTop = thread.scrollHeight;
  }
  const unread = data?.user_unread === true;
  if ((unread || (data?.reply && data.reply_read !== true)) && activeWorkspaceTab === 'admin-chat' && currentUser && data?.id) {
    updateDoc(doc(db, 'feedback', data.id), {
      user_unread:false,
      reply_read:true,
      user_read_at:serverTimestamp(),
    }).catch(() => {});
  }
  const status = document.getElementById('admin-chat-status');
  if (status) status.textContent = mainChat ? 'Всегда открыт' : closed ? 'Обращение закрыто' : 'Обращение открыто';
  const title = document.getElementById('admin-chat-title');
  if (title) title.textContent = feedbackTitle(data || { id:activeAdminChatId });
  const kicker = document.getElementById('admin-chat-kicker');
  if (kicker) kicker.textContent = mainChat ? 'Закреплённый чат' : closed ? 'Архив обращений' : 'Открытое обращение';
  const input = document.getElementById('admin-chat-input');
  const button = document.querySelector('#admin-chat-form button');
  if (input) input.disabled = closed;
  if (button) button.disabled = closed;
  const closedNote = document.getElementById('admin-chat-closed');
  if (closedNote) closedNote.hidden = !closed;
  renderAdminChatList();
}

function selectAdminChat(id) {
  if (!id) return;
  activeAdminChatId = id;
  adminChatSnapshotReady = false;
  adminChatLastAdminTs = 0;
  const item = adminChatItems.find(value => value.id === id) || { id };
  renderAdminChat(item);
  document.querySelector('.messenger-shell')?.classList.add('chat-open');
}

function openAdminChat() {
  if (!currentUser) return;
  adminChatUnsub?.();
  adminChatSnapshotReady = false;
  adminChatLastAdminTs = 0;
  activeAdminChatId ||= adminChatId(currentUser.uid);
  const inbox = query(collection(db, 'feedback'), where('user_id', '==', currentUser.uid), limit(100));
  adminChatUnsub = onSnapshot(inbox, snap => {
    adminChatItems = snap.docs.map(entry => ({ id:entry.id, ...entry.data() }));
    const active = adminChatItems.find(item => item.id === activeAdminChatId) || { id:activeAdminChatId };
    renderAdminChat(active);
    const unreadCount = adminChatItems.filter(item => item.user_unread === true || (item.reply && item.reply_read !== true)).length;
    const badge = document.getElementById('admin-chat-badge');
    if (badge) { badge.hidden = unreadCount === 0; badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount); }
  }, error => {
    const status = document.getElementById('admin-chat-status');
    if (status) status.textContent = 'Ошибка: ' + error.message;
    const list = document.getElementById('admin-chat-list');
    if (list) list.innerHTML = `<div class="messenger-list-state">Не удалось загрузить обращения.<br>${esc(error.message)}</div>`;
  });
}

document.getElementById('admin-chat-list')?.addEventListener('click', event => {
  const dialog = event.target.closest('[data-admin-dialog]');
  if (dialog) selectAdminChat(dialog.dataset.adminDialog);
});
document.getElementById('admin-chat-back')?.addEventListener('click', () => {
  document.querySelector('.messenger-shell')?.classList.remove('chat-open');
});

const feedbackCreateOverlay = document.getElementById('feedback-create-overlay');
const feedbackCreateText = document.getElementById('feedback-create-text');

function setFeedbackCreateOpen(open) {
  if (!feedbackCreateOverlay) return;
  feedbackCreateOverlay.hidden = !open;
  document.body.style.overflow = open ? 'hidden' : '';
  if (open) {
    requestAnimationFrame(() => feedbackCreateText?.focus());
  }
}

document.getElementById('feedback-create-open')?.addEventListener('click', () => setFeedbackCreateOpen(true));
document.getElementById('feedback-create-close')?.addEventListener('click', () => setFeedbackCreateOpen(false));
document.getElementById('feedback-create-cancel')?.addEventListener('click', () => setFeedbackCreateOpen(false));
feedbackCreateOverlay?.addEventListener('click', event => {
  if (event.target === feedbackCreateOverlay) setFeedbackCreateOpen(false);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && feedbackCreateOverlay && !feedbackCreateOverlay.hidden) setFeedbackCreateOpen(false);
});
feedbackCreateText?.addEventListener('input', () => {
  const count = document.getElementById('feedback-create-count');
  if (count) count.textContent = String(feedbackCreateText.value.length);
});

document.getElementById('feedback-create-form')?.addEventListener('submit', async event => {
  event.preventDefault();
  if (!currentUser) { toast('Войди в аккаунт', 'e'); return; }
  const text = feedbackCreateText?.value.trim() || '';
  if (!text) { toast('Напиши текст обращения', 'w'); feedbackCreateText?.focus(); return; }
  if (text.length > 2000) { toast('Сообщение не должно превышать 2000 символов', 'w'); return; }
  const category = document.querySelector('input[name="feedback-category"]:checked')?.value || 'другое';
  const submit = document.getElementById('feedback-create-submit');
  submit.disabled = true;
  submit.textContent = 'Создаём…';
  try {
    const ref = doc(collection(db, 'feedback'));
    const username = String(currentUserProfile?.name || currentUserProfile?.display_name || currentUser.displayName || currentUser.email || 'Пользователь').trim().slice(0, 50) || 'Пользователь';
    await setDoc(ref, {
      text,
      category,
      username,
      user_id: currentUser.uid,
      is_read:false,
      reply:null,
      reply_read:null,
      created_at:serverTimestamp(),
    });
    activeAdminChatId = ref.id;
    feedbackCreateText.value = '';
    document.getElementById('feedback-create-count').textContent = '0';
    setFeedbackCreateOpen(false);
    document.querySelector('.messenger-shell')?.classList.add('chat-open');
    toast('Обращение создано', 's');
  } catch (error) {
    toast('Не удалось создать обращение: ' + toSafeErrorMessage(error), 'e');
  } finally {
    submit.disabled = false;
    submit.textContent = 'Создать обращение';
  }
});

document.getElementById('admin-chat-form')?.addEventListener('submit', async event => {
  event.preventDefault();
  if (!currentUser || !activeAdminChatId) return;
  const input = document.getElementById('admin-chat-input');
  const text = input?.value.trim() || '';
  if (!text) return;
  const ref = doc(db, 'feedback', activeAdminChatId);
  const message = { from:'user', text, ts:Date.now() };
  const profileName = currentUserProfile?.name || currentUserProfile?.display_name || currentUser.email || 'Пользователь';
  const existing = await getDoc(ref);
  if (existing.exists()) {
    if (!isMainAdminChat(activeAdminChatId) && existing.data()?.status === 'closed') return;
    await updateDoc(ref, { thread:arrayUnion(message), admin_unread:true, user_unread:false, reply_read:true, user_read_at:serverTimestamp(), last_from:'user', status:'open' });
  } else {
    await setDoc(ref, { text, category:'Чат с администрацией', username:profileName, user_id:currentUser.uid, is_read:false, reply:null, reply_read:null, created_at:serverTimestamp() });
  }
  input.value = '';
});

function statusLabel(status) {
  const normalized = lineupStatusGroup(status);
  if (normalized === 'approved') return 'Одобрен';
  if (normalized === 'rejected') return 'Отклонён';
  if (normalized === 'archived') return 'В архиве';
  return 'На проверке';
}

function lineupStatusGroup(status) {
  const value = String(status || '').trim().toLowerCase();
  if (value === 'hot') return 'approved';
  return ['approved', 'rejected', 'archived'].includes(value) ? value : 'pending';
}

function difficultyLabel(value) {
  const labels = { easy: 'Легко', medium: 'Средне', hard: 'Сложно' };
  return labels[String(value || '').toLowerCase()] || firstText(value, '—');
}

function roundSideLabel(value) {
  return value === 'attack' ? 'Атака' : value === 'defense' ? 'Защита' : value === 'any' ? 'Любая' : 'Не указана';
}

function categoryLabel(value) {
  const normalized = normalizeContentCategory(value);
  const labels = {
    lineup: 'Лайнап',
    combo: 'Комбо',
    wallbang: 'Прострел',
    defense: 'Защита',
  };
  return labels[normalized] || firstText(value, '—');
}

function isCurrentUserAdmin() {
  return String(currentUserProfile?.role || '').toLowerCase() === 'admin';
}

function canCurrentUserModerate() {
  return ['admin', 'moderator'].includes(String(currentUserProfile?.role || '').toLowerCase());
}

function openModeratorDraft(item) {
  const draft = rejectedLineupDraft({ ...item, status: 'moderator_draft' });
  draft.resubmissionSourceId = '';
  draft.moderatorDraftSourceId = item.id || '';
  draft.moderatorAuthor = { uid: item.user_id || '', name: item.submitted_by || '' };
  draft.moderatorRewardOptIn = item.reward_program_opt_in === true;
  try { sessionStorage.setItem(MODERATOR_EDIT_SESSION_KEY, draft.moderatorDraftSourceId); } catch (_) {}
  moderatorVideoRemovalRequested = false;
  resetUploadForm({ keepDraft: true });
  _restoreDraft(draft);
  showModeratorAuthorPicker(draft.moderatorAuthor);
  switchWorkspaceTab('upload');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  toast('Видео открыто в форме. Заполни агента, способность и карту, затем отправь на проверку.', 's');
}

async function requestModeratorRewardDecision(lineupId) {
  const rewardContext = (await getRewardReviewContext({ lineup_id:lineupId })).data || {};
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'reward-review-dialog-backdrop';
    overlay.innerHTML = `<section class="reward-review-dialog" role="dialog" aria-modal="true" aria-labelledby="reward-review-title">
      <h2 id="reward-review-title">Итоговая оценка награды</h2>
      <p>Перед завершением проверки отметь оба ручных критерия. Ничего не выбрано заранее.</p>
      <div class="reward-review-row"><span>Материал оригинальный и допускается к награде?</span><div class="reward-review-choice"><label class="yes"><input type="radio" name="final-reward-eligible" value="yes">✓ Да</label><label class="no"><input type="radio" name="final-reward-eligible" value="no">✕ Нет</label></div></div>
      <div class="reward-review-row"><span>По материалу понятно, как повторить лайнап?</span><div class="reward-review-choice"><label class="yes"><input type="radio" name="final-reward-quality" value="yes">✓ Да</label><label class="no"><input type="radio" name="final-reward-quality" value="no">✕ Нет</label></div></div>
      <div class="reward-review-auto"><span>Общий дефицит</span><b class="${rewardContext.deficit?.global ? 'yes' : 'no'}">${rewardContext.deficit?.global ? '✓ Да · +1 VP' : '✕ Нет'}</b><span>Дефицит маппула</span><b class="${rewardContext.deficit?.map_pool ? 'yes' : 'no'}">${rewardContext.deficit?.map_pool ? '✓ Да · +2 VP' : '✕ Нет'}</b><span>Активное задание</span><b class="${rewardContext.matched_task ? 'yes' : 'no'}">${rewardContext.matched_task ? '✓ Да · +1 VP' : '✕ Нет'}</b><span>Предварительный итог</span><b class="total" data-final-reward-total>—</b></div>
      ${rewardContext.duplicate_lineup_id ? `<div class="reward-review-warning">Найден похожий материал: ${esc(rewardContext.duplicate_lineup_id)}. Сервер не допустит автоматическое начисление.</div>` : ''}
      <textarea class="finput" maxlength="500" data-final-reward-comment placeholder="Что проверено и почему принято такое решение"></textarea>
      <div class="reward-review-dialog-actions"><button type="button" class="moderation-action" data-final-reward-cancel>Вернуться</button><button type="button" class="moderation-action moderation-complete" data-final-reward-save>Сохранить и завершить</button></div>
      <div class="reward-review-dialog-error" data-final-reward-error></div>
    </section>`;
    const close = value => { overlay.remove(); resolve(value); };
    const refreshTotal = () => {
      const eligible = overlay.querySelector('input[name="final-reward-eligible"]:checked')?.value;
      const quality = overlay.querySelector('input[name="final-reward-quality"]:checked')?.value;
      const total = overlay.querySelector('[data-final-reward-total]');
      if (!eligible || !quality) total.textContent = '—';
      else total.textContent = eligible === 'no' ? '0 VP' : `${Math.min(11, 7 + (quality === 'yes' ? 1 : 0) + (rewardContext.deficit?.global ? 1 : 0) + (rewardContext.deficit?.map_pool ? 2 : 0) + (rewardContext.matched_task ? 1 : 0))} VP`;
    };
    overlay.addEventListener('change', refreshTotal);
    overlay.querySelector('[data-final-reward-cancel]').addEventListener('click', () => close(null));
    overlay.querySelector('[data-final-reward-save]').addEventListener('click', () => {
      const eligibleChoice = overlay.querySelector('input[name="final-reward-eligible"]:checked')?.value || '';
      const qualityChoice = overlay.querySelector('input[name="final-reward-quality"]:checked')?.value || '';
      const comment = overlay.querySelector('[data-final-reward-comment]').value.trim();
      const error = overlay.querySelector('[data-final-reward-error]');
      if (!eligibleChoice || !qualityChoice) { error.textContent = 'Выбери «Да» или «Нет» для каждого критерия.'; return; }
      if (eligibleChoice === 'no' && qualityChoice === 'yes') { error.textContent = 'Недопущенный материал не может получить бонус качества.'; return; }
      if (!comment) { error.textContent = 'Напиши, что именно проверено.'; return; }
      close({ eligible:eligibleChoice === 'yes', quality_clear:qualityChoice === 'yes', comment });
    });
    document.body.appendChild(overlay);
  });
}

function showModeratorAuthorPicker(author = null) {
  moderatorSelectedAuthor = author?.uid ? { uid: author.uid, name: author.name || '' } : null;
  const section = document.getElementById('moderator-author-section');
  const input = document.getElementById('moderator-author-search');
  const status = document.getElementById('moderator-author-status');
  if (section) section.hidden = !moderatorDraftSourceId;
  if (input) input.value = moderatorSelectedAuthor?.name || '';
  if (status) status.textContent = moderatorSelectedAuthor
    ? `Выбран автор: ${moderatorSelectedAuthor.name}`
    : 'Начни вводить ник и выбери автора из списка.';
  if (section && !section.hidden) searchModeratorAuthors(input?.value || '');
  renderModeratorScreenshotRail();
}

function renderModeratorAuthorOptions({ loading = false } = {}) {
  const options = document.getElementById('moderator-author-options');
  if (!options) return;
  if (loading) {
    options.innerHTML = '<div class="moderator-author-empty">Загрузка авторов…</div>';
    return;
  }
  if (!moderatorAuthorMatches.length) {
    options.innerHTML = '<div class="moderator-author-empty">Авторы не найдены</div>';
    return;
  }
  options.innerHTML = moderatorAuthorMatches.map(user => {
    const selected = moderatorSelectedAuthor?.uid === user.uid;
    const initials = user.name.trim().slice(0, 2).toLocaleUpperCase('ru-RU');
    return `<button type="button" class="moderator-author-option${selected ? ' selected' : ''}" data-author-uid="${esc(user.uid)}" role="option" aria-selected="${selected}">
      <b class="moderator-author-avatar">${esc(initials)}</b>
      <span><strong>${esc(user.name)}</strong><small>UID: ${esc(user.uid.slice(0, 12))}</small></span>
    </button>`;
  }).join('');
  options.querySelectorAll('[data-author-uid]').forEach(button => {
    button.addEventListener('click', () => {
      const selected = moderatorAuthorMatches.find(user => user.uid === button.dataset.authorUid);
      if (!selected) return;
      moderatorSelectedAuthor = selected;
      const input = document.getElementById('moderator-author-search');
      const status = document.getElementById('moderator-author-status');
      if (input) input.value = selected.name;
      if (status) status.textContent = `Выбран автор: ${selected.name}`;
      renderModeratorAuthorOptions();
      scheduleModeratorAutosave();
    });
  });
}

async function searchModeratorAuthors(queryText) {
  const q = String(queryText || '').trim();
  const sequence = ++moderatorAuthorSearchSequence;
  renderModeratorAuthorOptions({ loading:true });
  try {
    const token = await currentUser.getIdToken();
    const response = await fetch(`/api/moderation?q=${encodeURIComponent(q)}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `Ошибка ${response.status}`);
    if (sequence !== moderatorAuthorSearchSequence) return;
    moderatorAuthorMatches = Array.isArray(body.users) ? body.users : [];
    applyModeratorAuthorInput(document.getElementById('moderator-author-search')?.value || '');
    renderModeratorAuthorOptions();
  } catch (error) {
    if (sequence !== moderatorAuthorSearchSequence) return;
    document.getElementById('moderator-author-status').textContent = `Поиск не выполнен: ${error.message}`;
    moderatorAuthorMatches = [];
    renderModeratorAuthorOptions();
  }
}

function applyModeratorAuthorInput(rawValue) {
  const value = String(rawValue || '').trim();
  const normalized = value.toLocaleLowerCase('ru-RU');
  const exact = moderatorAuthorMatches.filter(user =>
    user.name.toLocaleLowerCase('ru-RU') === normalized ||
    `${user.name} · ${user.uid.slice(0, 8)}`.toLocaleLowerCase('ru-RU') === normalized,
  );
  moderatorSelectedAuthor = exact.length === 1 ? exact[0] : null;
  const status = document.getElementById('moderator-author-status');
  if (status) status.textContent = moderatorSelectedAuthor
    ? `Выбран автор: ${moderatorSelectedAuthor.name}`
    : exact.length > 1
      ? 'Найдено несколько пользователей с таким ником. Выбери вариант с UID.'
      : 'Выбери точное имя из найденных вариантов.';
  return moderatorSelectedAuthor;
}

document.getElementById('moderator-author-search')?.addEventListener('input', event => {
  const value = event.target.value.trim();
  const match = applyModeratorAuthorInput(value);
  clearTimeout(moderatorAuthorTimer);
  moderatorAuthorTimer = setTimeout(() => searchModeratorAuthors(match?.name || value), 250);
});
document.getElementById('moderator-author-search')?.addEventListener('focus', event => {
  clearTimeout(moderatorAuthorTimer);
  moderatorAuthorTimer = setTimeout(() => searchModeratorAuthors(event.target.value), 0);
});

async function loadModerationWorkspace({ background = false } = {}) {
  if (!canCurrentUserModerate() || !currentUser) return;
  try {
    if (!moderationModulePromise) moderationModulePromise = import('./moderation.js?v=2026-08-21-final-reward-review-v1');
    if (!moderationController) {
      const module = await moderationModulePromise;
      moderationController = module.initModeration({
        getToken: () => currentUser.getIdToken(),
        toast,
        reportError:logUploadError,
        openDraft: openModeratorDraft,
        getRole: () => String(currentUserProfile?.role || '').toLowerCase(),
        reviewReward: async payload => (await staffReviewRewardLineup(payload)).data,
        getRewardContext: async lineupId => (await getRewardReviewContext({lineup_id:lineupId})).data,
      });
    }
    const panelActive = activeWorkspaceTab === 'moderation' && !background && !document.hidden;
    if (panelActive) moderationController.activate?.();
    else moderationController.deactivate?.();
    await moderationController.load({
      allowInactive: background,
      renderQueue: panelActive,
    });
    if ((panelActive || background) && !moderatorDraftSourceId && !moderatorResumeAttempted) {
      moderatorResumeAttempted = true;
      let resumeId = '';
      try { resumeId = sessionStorage.getItem(MODERATOR_EDIT_SESSION_KEY) || ''; } catch (_) {}
      if (resumeId) {
        try {
          const resumed = await moderationController.resumeDraft?.(resumeId);
          if (!resumed) sessionStorage.removeItem(MODERATOR_EDIT_SESSION_KEY);
        } catch (error) {
          try { sessionStorage.removeItem(MODERATOR_EDIT_SESSION_KEY); } catch (_) {}
          toast('Не удалось восстановить проверку: ' + (error.message || error), 'e');
        }
      }
    }
  } catch (error) {
    toast('Не удалось открыть модерацию: ' + (error.message || error), 'e');
  }
}

function updateAdminOnlyWorkspace() {
  const canManageAdminMaterials = isCurrentUserAdmin();
  document.querySelectorAll('[data-admin-only="true"]').forEach(el => {
    el.style.display = canManageAdminMaterials ? '' : 'none';
  });
  if (!canManageAdminMaterials && materialEditorId) {
    closeMaterialForm();
  }
  const canModerate = canCurrentUserModerate();
  const moderationWrap = document.getElementById('header-moderation-wrap');
  const moderationButton = document.getElementById('header-moderation');
  if (moderationWrap) moderationWrap.style.display = currentUser ? '' : 'none';
  if (moderationButton) {
    const label = moderationButton.querySelector('b');
    if (label) label.textContent = canModerate ? 'Модерация' : 'Стать модератором';
    moderationButton.setAttribute('aria-label', canModerate ? 'Открыть модерацию' : 'Подать заявку в модераторы');
    moderationButton.title = canModerate ? 'Открыть модерацию' : 'Стать модератором';
  }
  document.querySelectorAll('[data-moderator-only="true"]').forEach(el => {
    el.style.display = canModerate ? '' : 'none';
  });
  document.getElementById('header-moderation')?.classList.toggle('active', canModerate && activeWorkspaceTab === 'moderation');
  updateModerationMovedHint(canModerate);
  if (!canModerate && activeWorkspaceTab === 'moderation') switchWorkspaceTab('upload');
}

function searchableText(item) {
  return [
    item.title,
    item.map,
    item.agent,
    item.ability,
    difficultyLabel(item.difficulty),
    categoryLabel(item.content_type || item.category),
    statusLabel(item.status),
  ].map(v => String(v || '').toLowerCase()).join(' ');
}

function filteredOwnLineups() {
  return currentUserLineups.filter(item => {
    const rawStatus = String(item.status || '').trim().toLowerCase();
    if (rawStatus === 'archived') return false;
    const status = lineupStatusGroup(item.status);
    if (myLineupsStatusFilter === 'moderator_draft') {
      if (rawStatus !== 'moderator_draft') return false;
    } else if (myLineupsStatusFilter !== 'all' && status !== myLineupsStatusFilter) return false;
    if (myLineupsSearch && !searchableText(item).includes(myLineupsSearch)) return false;
    return true;
  });
}

function docDate(docData) {
  const date = docData.submitted_at?.toDate?.() || docData.created_at?.toDate?.();
  return date || null;
}

function formatClockDate(docData) {
  const date = docDate(docData);
  if (!date) return { time: '--:--', date: 'без даты' };
  return {
    time: date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
    date: date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }),
  };
}

function renderLineupList(targetId, items, emptyTitle, emptyText) {
  const target = document.getElementById(targetId);
  if (!target) return;
  if (!currentUser) {
    target.innerHTML = `<div class="empty-state"><strong>Войди в аккаунт</strong>Здесь появятся твои материалы.</div>`;
    return;
  }
  if (!items.length) {
    target.innerHTML = `<div class="empty-state"><strong>${esc(emptyTitle)}</strong>${esc(emptyText)}</div>`;
    return;
  }
  target.innerHTML = items.map(item => {
    const status = lineupStatusGroup(item.status);
    const title = firstText(item.title, 'Без названия');
    const stamp = formatClockDate(item);
    const meta = [
      item.map,
      item.agent,
      item.ability,
      difficultyLabel(item.difficulty),
      categoryLabel(item.content_type || item.category),
      item.resubmitted_from ? 'Повторная отправка' : '',
    ].filter(Boolean);
    return `
      <article class="lineup-card clickable" data-lineup-id="${esc(item.id)}" tabindex="0" role="button" aria-label="Открыть лайнап ${esc(title)}">
        <div>
          <div class="lineup-title">${esc(title)}</div>
          <div class="lineup-meta">
            ${meta.map(value => `<span class="lineup-chip">${esc(value)}</span>`).join('')}
            <span class="lineup-chip lineup-date-chip"><b>${esc(stamp.time)}</b><span>${esc(stamp.date)}</span></span>
          </div>
        </div>
        <div class="lineup-card-actions">
          <span class="status-chip ${esc(status)}">${esc(statusLabel(status))}</span>
          ${status === 'rejected' ? `<button class="copy-id-btn danger" type="button" data-delete-lineup-id="${esc(item.id)}">Удалить</button>` : ''}
        </div>
      </article>`;
  }).join('');
}

function findOwnLineup(id) {
  return currentUserLineups.find(item => item.id === id) || null;
}

function bindSavedVideoZoom(video, edit) {
  const clips = Array.isArray(edit?.zoomKeyframes) ? edit.zoomKeyframes : [];
  if (!video || !clips.length) return;
  let animationFrame = 0;
  const update = () => {
    const time = Number(video.currentTime || 0);
    const clip = clips.slice().reverse().find(item => {
      const start = Number.isFinite(Number(item.at)) ? Number(item.at) : Number(item.outputAt || 0);
      const duration = Math.max(0.2, Number(item.duration || 2));
      return time >= start && time <= start + duration;
    });
    if (!clip) {
      video.style.transform = '';
      video.style.transformOrigin = '';
      return;
    }
    const start = Number.isFinite(Number(clip.at)) ? Number(clip.at) : Number(clip.outputAt || 0);
    const duration = Math.max(0.2, Number(clip.duration || 2));
    const local = Math.max(0, Math.min(duration, time - start));
    const ramp = Math.max(0.08, Math.min(0.4, duration / 2));
    const linear = Math.max(0, Math.min(1, local / ramp, (duration - local) / ramp));
    const mix = linear * linear * (3 - 2 * linear);
    const targetScale = Math.max(1, Number(clip.scaleX ?? clip.scale ?? 1), Number(clip.scaleY ?? clip.scale ?? 1));
    const scale = 1 + (targetScale - 1) * mix;
    const anchorX = 50 + (Number(clip.anchorX ?? 50) - 50) * mix;
    const anchorY = 50 + (Number(clip.anchorY ?? 50) - 50) * mix;
    video.style.transformOrigin = `${anchorX}% ${anchorY}%`;
    video.style.transform = `scale(${scale})`;
  };
  const tick = () => {
    update();
    animationFrame = video.paused || video.ended ? 0 : requestAnimationFrame(tick);
  };
  video.addEventListener('play', () => {
    if (!animationFrame) animationFrame = requestAnimationFrame(tick);
  });
  video.addEventListener('pause', update);
  video.addEventListener('seeked', update);
  video.addEventListener('loadedmetadata', update);
  update();
}

function openLineupDetail(lineupId) {
  const item = findOwnLineup(lineupId);
  if (!item || String(item.status || '').trim().toLowerCase() === 'archived') {
    toast('Лайнап не найден в списке', 'e');
    return;
  }
  const screen = document.getElementById('lineup-detail-screen');
  const titleEl = document.getElementById('detail-title');
  const body = document.getElementById('detail-body');
  if (!screen || !titleEl || !body) return;

  const title = firstText(item.title, 'Без названия');
  const stamp = formatClockDate(item);
  const description = firstText(item.description, 'Описание не добавлено.');
  const rejection = firstText(item.rejection_reason, item.reject_reason, item.moderation_reason);
  const source = item.resubmitted_from ? findOwnLineup(item.resubmitted_from) : null;
  const shots = Array.isArray(item.screenshots) ? item.screenshots.filter(Boolean) : [];
  const status = item.status || 'pending';

  titleEl.textContent = title;
  body.innerHTML = `
    <div class="detail-grid">
      <div class="detail-tile"><span>Статус</span><b>${esc(statusLabel(status))}</b></div>
      <div class="detail-tile"><span>Карта</span><b>${esc(firstText(item.map, '—'))}</b></div>
      <div class="detail-tile"><span>Агент</span><b>${esc(firstText(item.agent, '—'))}</b></div>
      <div class="detail-tile"><span>Дата</span><b>${esc(stamp.time)}<br>${esc(stamp.date)}</b></div>
      <div class="detail-tile"><span>Абилка</span><b>${esc(firstText(item.ability, '—'))}</b></div>
      <div class="detail-tile"><span>Сложность</span><b>${esc(difficultyLabel(item.difficulty))}</b></div>
      <div class="detail-tile"><span>Категория</span><b>${esc(categoryLabel(item.content_type || item.category))}</b></div>
      ${categoryExtraDetailHtml(item)}
      ${item.resubmitted_from ? `<div class="detail-tile"><span>Доработка</span><b>${esc(source ? firstText(source.title, source.id) : item.resubmitted_from)}</b></div>` : ''}
    </div>
    ${rejection ? `<div class="detail-section"><div class="detail-section-title">Причина отклонения</div><div class="detail-warning">${esc(rejection)}</div></div>` : ''}
    <div class="detail-section">
      <div class="detail-section-title">Описание</div>
      <div class="detail-text">${esc(description)}</div>
    </div>
    ${item.video_url ? `<div class="detail-section"><div class="detail-section-title">Видео</div><div class="detail-video-frame"><video class="detail-video" controls preload="metadata" src="${esc(item.video_url)}"></video></div></div>` : ''}
    ${shots.length ? `<div class="detail-section"><div class="detail-section-title">Скриншоты</div><div class="detail-shots">${shots.map(url => `<a href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt=""></a>`).join('')}</div></div>` : ''}
    <div class="detail-actions">
      ${status === 'rejected' ? `<button class="copy-id-btn danger" type="button" data-delete-lineup-id="${esc(item.id)}">Удалить</button>` : ''}
      <button class="copy-id-btn" type="button" data-copy-lineup-id="${esc(item.id)}">Создать черновик-копию</button>
      ${status === 'rejected' ? `<button class="btn-primary detail-action-primary" type="button" data-resubmit-lineup-id="${esc(item.id)}">Доработать и отправить заново</button>` : ''}
    </div>
    <div class="detail-id-row">
      <code>ID: ${esc(item.id)}</code>
      <button class="copy-id-btn" id="copy-lineup-id" type="button" data-lineup-id="${esc(item.id)}">Скопировать ID</button>
    </div>
  `;
  body.querySelector('#copy-lineup-id')?.addEventListener('click', event => {
    const id = event.currentTarget.dataset.lineupId || '';
    navigator.clipboard?.writeText(id).then(() => toast('ID скопирован', 's')).catch(() => toast('Не удалось скопировать ID', 'e'));
  });
  bindSavedVideoZoom(body.querySelector('.detail-video'), item.video_edit);
  screen.style.display = 'flex';
}

async function deleteRejectedLineup(lineupId) {
  const item = findOwnLineup(lineupId);
  if (!item || item.status !== 'rejected') {
    toast('Удалить можно только отклонённый лайнап', 'w');
    return;
  }
  if (!confirm('Удалить отклонённый лайнап? Это уберёт его из кабинета автора.')) return;
  try {
    await deleteDoc(doc(db, 'lineups', lineupId));
    if (resubmissionSourceId === lineupId) {
      resubmissionSourceId = '';
      _saveDraft();
      renderResubmissionBanner();
      renderDrafts();
    }
    closeLineupDetail();
    toast('Отклонённый лайнап удалён', 's');
  } catch (e) {
    await logUploadError(e, {
      action: 'delete_rejected_lineup',
      lineup_id: lineupId,
      status: item.status || '',
      user: userDiagnostics(),
    });
    toast('Не удалось удалить лайнап: ' + toSafeErrorMessage(e), 'e');
  }
}

function closeLineupDetail() {
  const screen = document.getElementById('lineup-detail-screen');
  if (!screen) return;
  screen.style.display = 'none';
  screen.querySelectorAll('video, audio').forEach(media => {
    media.pause();
    media.removeAttribute('src');
    media.load();
  });
  const body = document.getElementById('detail-body');
  if (body) body.innerHTML = '';
}

function rejectedLineupDraft(item) {
  const shots = Array.isArray(item.screenshots) ? item.screenshots.filter(Boolean) : [];
  return {
    map: item.map || '',
    agent: item.agent || '',
    ability: item.ability || '',
    sovaCharge: item.sova_charge ?? 3,
    sovaBounces: item.sova_bounces ?? 0,
    category: normalizeContentCategory(item.content_type || item.category || 'lineup'),
    difficulty: item.difficulty || '',
    roundSide: item.round_side || '',
    title: item.title || '',
    desc: item.description || '',
    markerX: item.position_x ?? item.marker_x ?? null,
    markerY: item.position_y ?? item.marker_y ?? null,
    mapMode: 'position',
    trajectory: Array.isArray(item.trajectory) ? item.trajectory : [],
    extraAbilities: Array.isArray(item.extra_abilities) ? item.extra_abilities : [],
    wallbangTargetX: item.target_x ?? null,
    wallbangTargetY: item.target_y ?? null,
    wallbangWeapons: Array.isArray(item.weapons) ? item.weapons : [],
    defenseSite: item.site || '',
    defenseNumber: item.number || 1,
    defenseZoomArea: item.zoom_area || null,
    defenseAbilities: Array.isArray(item.abilities) ? item.abilities : [],
    videoUrl: item.video_url || '',
    videoEdit: item.video_edit || null,
    screenshots: shots,
    resubmissionSourceId: item.id,
  };
}

function categoryExtraDetailHtml(item) {
  const type = normalizeContentCategory(item.content_type || item.category || 'lineup');
  if (type === 'wallbang') {
    const weapons = Array.isArray(item.weapons) ? item.weapons.filter(Boolean).join(', ') : '';
    const target = item.target_x !== undefined && item.target_y !== undefined
      ? `${Number(item.target_x).toFixed(3)}, ${Number(item.target_y).toFixed(3)}`
      : '';
    return `
      ${weapons ? `<div class="detail-tile"><span>Оружие</span><b>${esc(weapons)}</b></div>` : ''}
      ${target ? `<div class="detail-tile"><span>Точка</span><b>${esc(target)}</b></div>` : ''}
    `;
  }
  if (type === 'defense') {
    const zoom = item.zoom_area;
    const zoomText = zoom ? `${Number(zoom.x).toFixed(3)}, ${Number(zoom.y).toFixed(3)} / ${Number(zoom.width).toFixed(3)}×${Number(zoom.height).toFixed(3)}` : '';
    const abilities = Array.isArray(item.abilities) ? item.abilities.map(ab => ab.ability).filter(Boolean).join(', ') : '';
    return `
      ${item.site ? `<div class="detail-tile"><span>Зона</span><b>${esc(item.site)}</b></div>` : ''}
      ${item.number ? `<div class="detail-tile"><span>Сетап</span><b>${esc(item.number)}</b></div>` : ''}
      ${zoomText ? `<div class="detail-tile"><span>Zoom</span><b>${esc(zoomText)}</b></div>` : ''}
      ${abilities ? `<div class="detail-tile"><span>Абилки сетапа</span><b>${esc(abilities)}</b></div>` : ''}
    `;
  }
  return '';
}

function lineupCopyDraft(item) {
  return {
    ...rejectedLineupDraft(item),
    title: item.title ? `${item.title} — копия` : '',
    resubmissionSourceId: '',
  };
}

function createDraftFromLineup(lineupId) {
  const item = findOwnLineup(lineupId);
  if (!item) {
    toast('Лайнап не найден', 'e');
    return;
  }
  const draft = lineupCopyDraft(item);
  const now = Date.now();
  const saved = {
    ...draft,
    id: `draft_${now}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now,
    updatedAt: now,
  };
  writeSavedDrafts([saved, ...getSavedDrafts()]);
  try {
    localStorage.setItem(_ACTIVE_DRAFT_ID_KEY, saved.id);
    localStorage.setItem(_DRAFT_KEY, JSON.stringify(saved));
  } catch (_) {}
  closeLineupDetail();
  resetUploadForm({ keepDraft: true });
  _restoreDraft(saved);
  switchWorkspaceTab('upload');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  renderAuthorWorkspace();
  toast('Копия лайнапа открыта как черновик', 's');
}

function startRejectedResubmission(lineupId) {
  const item = findOwnLineup(lineupId);
  if (!item || item.status !== 'rejected') {
    toast('Повторно отправить можно только отклонённый материал', 'w');
    return;
  }
  try {
    localStorage.setItem(_DRAFT_KEY, JSON.stringify(rejectedLineupDraft(item)));
  } catch (_) {}
  closeLineupDetail();
  resetUploadForm({ keepDraft: true });
  _restoreDraft();
  switchWorkspaceTab('upload');
  toast('Отклонённый лайнап перенесён в форму. Проверь правки и отправь заново.', 's');
}

function renderResubmissionBanner() {
  const banner = document.getElementById('resubmit-banner');
  const cancelButton = document.getElementById('btn-cancel-moderation');
  const rejectButton = document.getElementById('btn-reject-moderation');
  const submitButton = document.getElementById('btn-submit');
  const saveDraftButton = document.getElementById('btn-save-draft');
  if (cancelButton) {
    cancelButton.hidden = !moderatorDraftSourceId && !resubmissionSourceId;
    cancelButton.textContent = moderatorDraftSourceId ? '✕ Отменить проверку' : '✕ Отменить редактирование';
  }
  if (rejectButton) rejectButton.hidden = !moderatorDraftSourceId;
  if (submitButton && !submitButton.disabled) submitButton.textContent = moderatorDraftSourceId ? '✅ Завершить проверку' : '⬆ Отправить лайнап';
  if (saveDraftButton) saveDraftButton.textContent = moderatorDraftSourceId ? '💾 Сохранить без подтверждения' : '💾 Сохранить черновик';
  if (!banner) return;
  if (!resubmissionSourceId && !moderatorDraftSourceId) {
    banner.style.display = 'none';
    banner.innerHTML = '';
    return;
  }
  const sourceId = moderatorDraftSourceId || resubmissionSourceId;
  const source = findOwnLineup(sourceId);
  const title = firstText(source?.title, sourceId);
  const reason = source ? firstText(source.rejection_reason, source.reject_reason, source.moderation_reason) : '';
  banner.innerHTML = `
    <div>
      <strong>${moderatorDraftSourceId ? 'Проверка и доработка лайнапа' : 'Редактирование отклонённого лайнапа'}</strong>
      <span>${esc(title)}${reason ? ` · ${esc(reason)}` : ''}</span>
    </div>
    ${moderatorDraftSourceId ? '' : '<button class="copy-id-btn danger-soft" type="button" data-cancel-resubmission>Отменить редактирование</button>'}
  `;
  banner.style.display = '';
}

async function cancelResubmissionDraft({ skipConfirm = false, resetOnly = false } = {}) {
  const claimedId = moderatorDraftSourceId;
  if (!skipConfirm && !confirm(claimedId
    ? 'Отменить проверку? Бронь будет снята, а данные этого лайнапа полностью удалены из формы.'
    : 'Отменить редактирование и полностью очистить форму?')) return;
  if (claimedId) {
    try {
      if (!moderationController) await loadModerationWorkspace({ background: true });
      await moderationController?.releaseClaim?.(claimedId);
    } catch (error) {
      toast('Не удалось снять бронь: ' + (error.message || error), 'e');
      return;
    }
  }
  clearModeratorVideoEditBackup(claimedId);
  resubmissionSourceId = '';
  moderatorDraftSourceId = '';
  clearTimeout(moderatorAutosaveTimer);
  moderatorAutosaveTimer = null;
  moderatorAutosaveDirty = false;
  try { sessionStorage.removeItem(MODERATOR_EDIT_SESSION_KEY); } catch (_) {}
  moderatorSelectedAuthor = null;
  deleteActiveSavedDraft();
  resetUploadForm();
  showModeratorAuthorPicker();
  renderResubmissionBanner();
  renderDrafts();
  if (claimedId && !resetOnly) {
    switchWorkspaceTab('moderation');
    await loadModerationWorkspace();
  }
  toast(claimedId ? 'Проверка отменена, бронь снята и форма очищена' : 'Форма полностью очищена', 's');
}

function renderDrafts() {
  const target = document.getElementById('drafts-list');
  if (!target) return;
  const drafts = getSavedDrafts();
  if (!drafts.length) {
    target.innerHTML = '<div class="empty-state"><strong>Черновиков нет</strong>Заполни форму и нажми «Сохранить черновик», чтобы держать несколько заготовок на этом устройстве.</div>';
    return;
  }
  target.innerHTML = drafts.map(draft => {
    const meta = [draft.map, draft.agent, draft.ability, difficultyLabel(draft.difficulty), categoryLabel(draft.category)].filter(Boolean);
    const date = draft.updatedAt ? new Date(draft.updatedAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    return `
    <article class="lineup-card" data-draft-id="${esc(draft.id || '')}">
      <div>
        <div class="lineup-title">${esc(firstText(draft.title, 'Черновик лайнапа'))}</div>
        <div class="lineup-meta">
          ${meta.map(value => `<span class="lineup-chip">${esc(value)}</span>`).join('')}
          <span class="lineup-chip">На этом устройстве</span>
          ${date ? `<span class="lineup-chip">${esc(date)}</span>` : ''}
          ${draft.resubmissionSourceId ? '<span class="lineup-chip">Доработка отклонённого</span>' : ''}
        </div>
      </div>
      <div class="draft-actions">
        <button class="copy-id-btn" type="button" data-draft-action="resume" data-draft-id="${esc(draft.id || '')}">Продолжить</button>
        <button class="copy-id-btn danger" type="button" data-draft-action="delete" data-draft-id="${esc(draft.id || '')}">Удалить</button>
      </div>
    </article>`;
  }).join('');
}

function renderMaterials() {
  const target = document.getElementById('materials-list');
  if (!target || activeWorkspaceTab !== 'materials') return;
  renderMaterialForm();
  if (authorMaterialsError) {
    target.innerHTML = `<div class="empty-state"><strong>Не удалось загрузить материалы</strong>${esc(authorMaterialsError)}</div>`;
    return;
  }
  if (!authorMaterialsLoaded) {
    if (!authorMaterialsLoading) loadAuthorMaterials();
    target.innerHTML = '<div class="empty-state"><strong>Загрузка материалов…</strong>Сейчас подтянем библиотеку для авторов.</div>';
    return;
  }
  const visibleMaterials = isCurrentUserAdmin()
    ? authorMaterials
    : authorMaterials.filter(item => item.is_published !== false);
  if (!visibleMaterials.length) {
    target.innerHTML = '<div class="empty-state"><strong>Материалов пока нет</strong>Когда администратор добавит материал, он появится здесь.</div>';
    return;
  }
  target.innerHTML = visibleMaterials.map(material => materialCardHtml(material)).join('');
}

function materialTypeLabel(value) {
  const labels = { video: 'Видео', guide: 'Гайд', checklist: 'Чек-лист', example: 'Пример', link: 'Ссылка' };
  return labels[String(value || '').toLowerCase()] || 'Материал';
}

function materialDateValue(item) {
  return item.updated_at?.toMillis?.() || item.created_at?.toMillis?.() || 0;
}

async function loadAuthorMaterials({ force = false } = {}) {
  if (authorMaterialsLoading || (authorMaterialsLoaded && !force)) return;
  authorMaterialsLoading = true;
  authorMaterialsError = '';
  renderMaterials();
  try {
    const q = isCurrentUserAdmin()
      ? query(collection(db, 'author_materials'), limit(80))
      : query(collection(db, 'author_materials'), where('is_published', '==', true), limit(80));
    const snap = await getDocs(q);
    authorMaterials = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    authorMaterials.sort((a, b) => materialDateValue(b) - materialDateValue(a));
    authorMaterialsLoaded = true;
  } catch (e) {
    console.warn('loadAuthorMaterials', e.message);
    authorMaterialsError = 'Обнови раздел или страницу чуть позже.';
  } finally {
    authorMaterialsLoading = false;
    renderMaterials();
    if (editorEls.footageLibrary && !editorEls.footageLibrary.hidden) renderFootageLibrary();
  }
}

function materialCardHtml(material) {
  const published = material.is_published !== false;
  const videoUrl = String(material.video_url || '').trim();
  const legacyUrl = String(material.url || '').trim();
  const previewWarning = transparentPreviewWarning(material.video_file_name || videoUrl);
  return `
    <article class="material-item" data-material-id="${esc(material.id || '')}">
      <div>
        <div class="material-item-head">
          <span class="material-badge">${esc(materialTypeLabel(material.type))}</span>
          ${published ? '' : '<span class="material-badge hidden">Скрыт</span>'}
          <h3>${esc(firstText(material.title, 'Материал'))}</h3>
        </div>
        ${material.description ? `<div class="material-desc">${esc(material.description)}</div>` : ''}
        ${videoUrl ? `
          <video class="material-video" src="${esc(videoUrl)}" controls preload="metadata"></video>
          ${previewWarning ? `<div class="material-preview-warning">${esc(previewWarning)}</div>` : ''}
          <a class="material-link" href="${esc(videoUrl)}" download rel="noopener noreferrer">Скачать видео</a>
        ` : legacyUrl ? `<a class="material-link" href="${esc(legacyUrl)}" target="_blank" rel="noopener noreferrer">Открыть материал</a>` : ''}
      </div>
      ${isCurrentUserAdmin() ? `
        <div class="material-actions">
          <button class="copy-id-btn" type="button" data-material-edit="${esc(material.id || '')}">Изменить</button>
          <button class="copy-id-btn" type="button" data-material-toggle="${esc(material.id || '')}">${published ? 'Скрыть' : 'Опубликовать'}</button>
          <button class="copy-id-btn danger" type="button" data-material-delete="${esc(material.id || '')}">Удалить</button>
        </div>` : ''}
    </article>`;
}

function openMaterialForm(id = '') {
  if (!isCurrentUserAdmin()) return;
  materialVideoUploading = false;
  materialVideoUploadSeq++;
  materialEditorId = id || '__new__';
  renderMaterialForm();
  document.getElementById('material-title')?.focus();
}

function closeMaterialForm() {
  stopMaterialWorkspaceActivity();
  materialEditorId = '';
  materialVideoUploading = false;
  materialVideoUploadSeq++;
  renderMaterialForm();
}

function stopMaterialWorkspaceActivity() {
  if (materialVideoUploadRequest?.abort) materialVideoUploadRequest.abort();
  materialVideoUploadRequest = null;
  if (!materialVideoUploading) return;
  materialVideoUploadSeq++;
  materialVideoUploading = false;
  const state = document.getElementById('material-upload-state');
  const saveButton = document.querySelector('[data-material-save]');
  if (state) state.textContent = 'Загрузка остановлена при выходе из раздела. Выбери файл заново.';
  if (saveButton) saveButton.disabled = false;
}

function renderMaterialForm() {
  const shell = document.getElementById('material-form-shell');
  if (!shell) return;
  if (!isCurrentUserAdmin() || !materialEditorId) {
    shell.style.display = 'none';
    shell.innerHTML = '';
    return;
  }
  const material = materialEditorId === '__new__'
    ? { type: 'video', title: '', description: '', video_url: '', video_file_name: '', video_size: 0, is_published: true }
    : authorMaterials.find(item => item.id === materialEditorId) || {};
  const videoUrl = String(material.video_url || '').trim();
  const previewWarning = transparentPreviewWarning(material.video_file_name || videoUrl);
  shell.style.display = '';
  shell.innerHTML = `
    <div class="material-form-grid">
      <input class="finput" id="material-title" maxlength="90" placeholder="Название материала" value="${esc(material.title || '')}">
      <input class="finput" id="material-video-file" type="file" accept="video/mp4,video/quicktime,video/webm,video/*,.mp4,.mov,.webm">
    </div>
    <div class="field-group">
      <textarea class="finput" id="material-description" maxlength="1000" placeholder="Короткое описание для авторов">${esc(material.description || '')}</textarea>
    </div>
    <input type="hidden" id="material-video-url" value="${esc(videoUrl)}">
    <input type="hidden" id="material-video-name" value="${esc(material.video_file_name || '')}">
    <input type="hidden" id="material-video-size" value="${esc(material.video_size || 0)}">
    <div class="material-upload-state" id="material-upload-state">
      ${videoUrl ? 'Видео загружено. Можно заменить его новым файлом.' : 'Выбери видеофайл, он загрузится в хранилище автоматически.'}
    </div>
    <div class="material-video-preview" id="material-video-preview">
      ${videoUrl ? `<video class="material-video" src="${esc(videoUrl)}" controls preload="metadata"></video>` : ''}
      ${previewWarning ? `<div class="material-preview-warning">${esc(previewWarning)}</div>` : ''}
    </div>
    <label class="lineup-meta" style="margin-bottom:12px;">
      <input type="checkbox" id="material-published" ${material.is_published === false ? '' : 'checked'}>
      <span class="lineup-chip">Показывать пользователям</span>
    </label>
    <div class="material-form-actions">
      <button class="copy-id-btn" type="button" data-material-cancel>Отмена</button>
      <button class="btn-primary detail-action-primary" type="button" data-material-save>${materialEditorId === '__new__' ? 'Добавить' : 'Сохранить'}</button>
    </div>`;
}

function materialFormPayload() {
  const title = document.getElementById('material-title')?.value.trim() || '';
  const description = document.getElementById('material-description')?.value.trim() || '';
  const videoUrl = document.getElementById('material-video-url')?.value.trim() || '';
  const videoFileName = document.getElementById('material-video-name')?.value.trim() || '';
  const videoSize = Number(document.getElementById('material-video-size')?.value || 0);
  const isPublished = !!document.getElementById('material-published')?.checked;
  if (!title) throw new Error('Укажи название материала');
  if (materialVideoUploading) throw new Error('Дождись окончания загрузки видео');
  if (!videoUrl) throw new Error('Загрузи видео для материала');
  return {
    type: 'video',
    title,
    description,
    url: '',
    video_url: videoUrl,
    video_file_name: videoFileName,
    video_size: Number.isFinite(videoSize) ? videoSize : 0,
    is_published: isPublished,
    updated_at: serverTimestamp(),
    updated_by: currentUser?.uid || '',
    updated_by_name: authorDisplayName(),
  };
}

async function uploadMaterialVideoFile(file) {
  if (!isCurrentUserAdmin()) return;
  if (!isVideoFile(file)) { toast('Выбери видеофайл', 'e'); return; }
  if (file.size > 100 * 1024 * 1024) { toast('Видео превышает 100 МБ', 'e'); return; }
  const previewWarning = transparentPreviewWarning(file.name);

  const seq = ++materialVideoUploadSeq;
  materialVideoUploading = true;
  const state = document.getElementById('material-upload-state');
  const preview = document.getElementById('material-video-preview');
  const saveBtn = document.querySelector('[data-material-save]');
  if (saveBtn) saveBtn.disabled = true;
  if (state) state.textContent = previewWarning || 'Загрузка видео: 0%';
  if (preview) preview.innerHTML = '';
  try {
    const uploadRequest = uploadVideoToSelectel(file, pct => {
      if (seq !== materialVideoUploadSeq) return;
      if (state) state.textContent = `Загрузка видео: ${Math.round(pct * 100)}%`;
    });
    materialVideoUploadRequest = uploadRequest;
    const url = await uploadRequest;
    if (seq !== materialVideoUploadSeq) return;
    document.getElementById('material-video-url').value = url;
    document.getElementById('material-video-name').value = file.name;
    document.getElementById('material-video-size').value = String(file.size);
    if (state) state.textContent = previewWarning || 'Видео загружено. Можно сохранять материал.';
    if (preview) preview.innerHTML = `<video class="material-video" src="${esc(url)}" controls preload="metadata"></video>${previewWarning ? `<div class="material-preview-warning">${esc(previewWarning)}</div>` : ''}`;
    toast('Видео загружено', 's');
  } catch (e) {
    if (seq !== materialVideoUploadSeq) return;
    document.getElementById('material-video-url').value = '';
    if (state) state.textContent = 'Не удалось загрузить видео. Попробуй выбрать файл ещё раз.';
    toast('Ошибка загрузки видео: ' + (e.message || e), 'e');
  } finally {
    if (seq === materialVideoUploadSeq) {
      materialVideoUploading = false;
      materialVideoUploadRequest = null;
      if (saveBtn) saveBtn.disabled = false;
    }
  }
}

async function saveAuthorMaterial() {
  if (!isCurrentUserAdmin() || !materialEditorId) return;
  const btn = document.querySelector('[data-material-save]');
  try {
    const payload = materialFormPayload();
    if (btn) { btn.disabled = true; btn.textContent = 'Сохранение…'; }
    const isNew = materialEditorId === '__new__';
    const ref = isNew ? doc(collection(db, 'author_materials')) : doc(db, 'author_materials', materialEditorId);
    await setDoc(ref, {
      ...payload,
      ...(isNew ? {
        created_at: serverTimestamp(),
        created_by: currentUser?.uid || '',
        created_by_name: authorDisplayName(),
      } : {}),
    }, { merge: true });
    materialEditorId = '';
    await loadAuthorMaterials({ force: true });
    toast(isNew ? 'Материал добавлен' : 'Материал сохранён', 's');
  } catch (e) {
    toast(e.message || 'Не удалось сохранить материал', 'e');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Сохранить'; }
  }
}

async function toggleAuthorMaterial(id) {
  if (!isCurrentUserAdmin() || !id) return;
  const material = authorMaterials.find(item => item.id === id);
  if (!material) return;
  try {
    await setDoc(doc(db, 'author_materials', id), {
      is_published: material.is_published === false,
      updated_at: serverTimestamp(),
      updated_by: currentUser?.uid || '',
      updated_by_name: authorDisplayName(),
    }, { merge: true });
    await loadAuthorMaterials({ force: true });
    toast(material.is_published === false ? 'Материал опубликован' : 'Материал скрыт', 's');
  } catch (e) {
    toast('Ошибка: ' + e.message, 'e');
  }
}

async function deleteAuthorMaterial(id) {
  if (!isCurrentUserAdmin() || !id) return;
  if (!confirm('Удалить материал? Пользователи больше его не увидят.')) return;
  try {
    await deleteDoc(doc(db, 'author_materials', id));
    if (materialEditorId === id) closeMaterialForm();
    await loadAuthorMaterials({ force: true });
    toast('Материал удалён', 's');
  } catch (e) {
    toast('Ошибка: ' + e.message, 'e');
  }
}

function renderCabinetStats() {
  const target = document.getElementById('cabinet-stats-grid');
  if (!target) return;
  const approved = currentUserLineups.filter(x => lineupStatusGroup(x.status) === 'approved').length;
  const effectiveApproved = effectiveApprovedLineups(approved);
  const bonusLineups = Number(currentUserProfile?.bonus_lineups || 0);
  const rejected = currentUserLineups.filter(x => lineupStatusGroup(x.status) === 'rejected').length;
  const pending = currentUserLineups.filter(x => lineupStatusGroup(x.status) === 'pending').length;
  const submittedCount = approved + pending;
  const viewed = Number(currentUserProfile?.lineups_viewed || 0);
  const lv = calculateLevel(effectiveApproved);
  target.innerHTML = `
    <div class="cabinet-stat"><span>Статус</span><b style="color:${esc(lv.color)}">${esc(lv.icon)} ${esc(lv.name)}</b></div>
    <div class="cabinet-stat"><span>Счётчик</span><b style="color:var(--green)">${effectiveApproved}</b></div>
    <div class="cabinet-stat"><span>На проверке</span><b style="color:var(--orange)">${pending}</b></div>
    <div class="cabinet-stat"><span>Просмотрено</span><b>${viewed}</b></div>
    <div class="cabinet-stat"><span>Отклонено</span><b style="color:var(--red)">${rejected}</b></div>
    <div class="cabinet-stat"><span>Одобрено факт</span><b>${approved}${bonusLineups ? ` +${bonusLineups}` : ''}</b></div>
    <div class="cabinet-stat"><span>Отправлено в зачёт</span><b>${submittedCount}</b></div>
    <div class="cabinet-stat"><span>КД отправки</span><b>${cooldownMinutesFor(effectiveApproved)}м</b></div>
    <div class="cabinet-stat"><span>Доступ</span><b>${canCurrentUserUpload() ? 'Можно' : `${Math.min(viewed, UPLOAD_REQUIRED_VIEWS)}/${UPLOAD_REQUIRED_VIEWS}`}</b></div>`;
}

function renderCabinetVpStats() {
  const target = document.getElementById('cabinet-vp-grid');
  if (!target) return;
  if (!rewardDashboard) {
    target.innerHTML = '<div class="cabinet-vp-empty">Данные VP загружаются…</div>';
    return;
  }
  const balance = rewardDashboard.balance || {};
  const payouts = rewardDashboard.payouts || [];
  const rewardedLineups = new Set((rewardDashboard.ledger || [])
    .filter(item => Number(item.amount_vp || 0) > 0 && item.lineup_id)
    .map(item => String(item.lineup_id))).size;
  const activeRequests = payouts.filter(item => ['pending','approved','ready','revealed'].includes(item.status)).length;
  target.innerHTML = `
    <div class="cabinet-stat cabinet-stat-vp primary"><span>Доступно</span><b>${Number(balance.available_vp || 0)} VP</b></div>
    <div class="cabinet-stat cabinet-stat-vp"><span>Заработано всего</span><b>${Number(balance.earned_vp || 0)} VP</b></div>
    <div class="cabinet-stat cabinet-stat-vp"><span>В заявках</span><b>${Number(balance.reserved_vp || 0)} VP</b><small>${activeRequests ? `${activeRequests} активн.` : 'Нет активных'}</small></div>
    <div class="cabinet-stat cabinet-stat-vp"><span>Получено кодами</span><b>${Number(balance.paid_vp || 0)} VP</b></div>
    <div class="cabinet-stat cabinet-stat-vp"><span>Награждено лайнапов</span><b>${rewardedLineups}</b></div>`;
}

function renderAuthorWorkspace() {
  const visibleOwnLineups = currentUserLineups.filter(
    item => String(item.status || '').trim().toLowerCase() !== 'archived'
  );
  renderLineupList(
    'my-lineups-list',
    filteredOwnLineups(),
    visibleOwnLineups.length ? 'Ничего не найдено' : 'Лайнапов пока нет',
    visibleOwnLineups.length ? 'Попробуй другой статус или поисковый запрос.' : 'Отправь первый лайнап, и он появится здесь со статусом проверки.'
  );
  renderDrafts();
  renderCabinetStats();
  renderCabinetVpStats();
  renderMaterials();
  renderResubmissionBanner();
}

initWorkspaceTabs();
initGlobalSiteVersionWatcher();
initDescriptionSamples();

// ── Auth ──────────────────────────────────────────────────────────────────────
function authorDisplayName() {
  return firstText(
    currentUserProfile?.name,
    currentUserProfile?.displayName,
    currentUserProfile?.username,
    currentUserProfile?.yandex_name,
    currentUser?.displayName,
    currentUser?.email
  );
}

async function loadCurrentUserProfile(user) {
  currentUserProfile = null;
  if (!user) return null;
  try {
    const [publicSnap, privateSnap, statsSnap, authSnap] = await Promise.all([
      getDoc(doc(db, 'users', user.uid)),
      getDoc(doc(db, 'user_private', user.uid)),
      getDoc(doc(db, 'user_stats', user.uid)),
      getDoc(doc(db, 'user_auth_links', user.uid)),
    ]);
    _profileParts = {
      public: publicSnap.data() || {},
      private: privateSnap.data() || {},
      stats: statsSnap.data() || {},
      auth: authSnap.data() || {},
    };
    currentUserProfile = mergeUserLibraryParts(_profileParts);
  } catch (e) {
    console.warn('loadCurrentUserProfile', e.message);
    try {
      const legacySnap = await getDoc(doc(db, 'users', user.uid));
      currentUserProfile = legacySnap.data() || null;
    } catch (_) {
      currentUserProfile = null;
    }
  }
  updateUploadCategoryButtons();
  updateCategoryTrainingGate();
  renderAuthorTrainingProgress();
  return currentUserProfile;
}

function mergeUserLibraryParts(parts) {
  const publicProfile = parts.public || {};
  const privateProfile = parts.private || {};
  const stats = parts.stats || {};
  const authLinks = parts.auth || {};
  const merged = { ...publicProfile, ...stats, ...privateProfile, ...authLinks };
  const maxNumber = (...values) => Math.max(0, ...values.map(value => Number(value || 0)));
  merged.name = firstText(publicProfile.display_name, publicProfile.name, stats.display_name);
  merged.approved_lineups = maxNumber(
    publicProfile.approved_lineups,
    publicProfile.approved_lineups_count,
    stats.approved_lineups,
    stats.approved_lineups_count,
  );
  merged.bonus_lineups = maxNumber(
    publicProfile.bonus_lineups,
    stats.bonus_lineups,
    stats.bonus_points,
  );
  merged.total_likes = maxNumber(
    publicProfile.total_likes,
    publicProfile.total_likes_received,
    stats.total_likes,
    stats.total_likes_received,
  );
  return merged;
}

onAuthStateChanged(auth, async user => {
  currentUser = user;
  socialWebsite.setUser(user);
  if (user) {
    activeAdminChatId = adminChatId(user.uid);
    adminChatItems = [];
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('form-screen').style.display = '';
    document.getElementById('success-screen').style.display = 'none'; // hide overlay on auth change
    document.getElementById('header-user').style.display = 'flex';
    const headerNotifications = document.getElementById('header-notifications');
    const headerSoundTest = document.getElementById('header-sound-test');
    if (headerNotifications) headerNotifications.hidden = false;
    if (headerSoundTest) headerSoundTest.hidden = false;
    await loadCurrentUserProfile(user);
    await loadRewardDashboard();
    await _subscribeCooldownAccess(user.uid);
    showTrainingReturnFeedback();
    await loadUploadCategoryConfig();
    updateAdminOnlyWorkspace();
    if (activeWorkspaceTab !== 'moderation') activateWorkspaceTab(activeWorkspaceTab);
    document.getElementById('user-name').textContent = authorDisplayName() || 'Пользователь';
    updateUploadGate();
    _subscribeUserProfile(user.uid);
    _subscribeStats(user.uid);
    _updateCooldown(user.uid);
    const av = document.getElementById('user-avatar');
    const avatarFallback = document.getElementById('user-avatar-fallback');
    if (user.photoURL) { av.src = user.photoURL; av.style.display = ''; if (avatarFallback) avatarFallback.hidden = true; }
    else { av.removeAttribute('src'); av.style.display = 'none'; if (avatarFallback) { avatarFallback.hidden = false; avatarFallback.textContent = (authorDisplayName() || 'П').slice(0,1).toUpperCase(); } }
    showProfileCatalogHint();
    const agentsReady = !agentsList.length ? loadAgents() : Promise.resolve();
    const mapsReady = loadMaps();
    let resumableModeratorEdit = false;
    try { resumableModeratorEdit = !!sessionStorage.getItem(MODERATOR_EDIT_SESSION_KEY); } catch (_) {}
    if (canCurrentUserModerate() && (moderatorDraftSourceId || resumableModeratorEdit)) {
      await agentsReady;
      await loadModerationWorkspace({ background: activeWorkspaceTab !== 'moderation' });
    } else if (canCurrentUserModerate() && activeWorkspaceTab === 'moderation') {
      await loadModerationWorkspace();
    }
    // Keep the loader over the form until reference lists are final. Otherwise
    // the full agent catalog flashes before category permissions filter it.
    await Promise.all([agentsReady, mapsReady]);
    openAdminChat();
    await syncAuthorTrainingCriteriaNotifications().catch(error => {
      console.warn('training criteria notification sync', error?.message || error);
    });
    startSiteNotifications(user.uid);
    initializeBrowserPush(user.uid);
    startSitePresence();
    hideSiteLoader();
  } else {
    clearInterval(sitePresenceTimer);
    sitePresenceTimer = null;
    deactivateWorkspaceTab(activeWorkspaceTab);
    pauseAllSiteMedia();
    moderationController?.destroy?.();
    currentUserProfile = null;
    _cooldownAccessUnsubs.forEach(unsubscribe => unsubscribe());
    _cooldownAccessUnsubs = [];
    _badgeCooldownExempt = false;
    _entitlementCooldownExempt = false;
    _cooldownExempt = false;
    _cooldownExempt = false;
    moderationController = null;
    moderationModulePromise = null;
    updateAdminOnlyWorkspace();
    updateUploadGate();
    _unsubscribeUserProfile();
    _unsubscribeStats();
    uploadCategoryAccessUnsub?.();
    uploadCategoryAccessUnsub = null;
    uploadConfigVersionsUnsub?.();
    uploadConfigVersionsUnsub = null;
    uploadConfigVersions = {};
    adminChatUnsub?.();
    adminChatUnsub = null;
    adminChatItems = [];
    activeAdminChatId = '';
    siteNotificationsUnsub?.();
    siteNotificationsUnsub = null;
    siteNotifications = [];
    siteNotificationsReady = false;
    updateNotificationBadges();
    updateBrowserPushButton();
    document.getElementById('auth-screen').style.display = 'flex';
    document.getElementById('form-screen').style.display = 'none';
    document.getElementById('success-screen').style.display = 'none'; // hide overlay on auth change
    document.getElementById('header-user').style.display = 'none';
    const headerNotifications = document.getElementById('header-notifications');
    const headerSoundTest = document.getElementById('header-sound-test');
    if (headerNotifications) headerNotifications.hidden = true;
    if (headerSoundTest) headerSoundTest.hidden = true;
    const loginButton = document.getElementById('btn-email-login');
    loginButton.disabled = false;
    loginButton.textContent = 'Войти';
    hideSiteLoader();
  }
});

function hideSiteLoader() {
  if (window.VLineupsLoader) {
    window.VLineupsLoader.hide();
    return;
  }
  const loader = document.getElementById('site-loader');
  if (!loader || loader.classList.contains('site-loader--hidden')) return;
  loader.classList.add('site-loader--hidden');
}

// Firebase может не ответить из-за сети — интерфейс всё равно должен открыться.
window.setTimeout(hideSiteLoader, 12000);

document.getElementById('tab-yandex-btn').addEventListener('click', () => {
  document.getElementById('tab-yandex-btn').classList.add('active');
  document.getElementById('tab-email-btn').classList.remove('active');
  document.getElementById('tab-yandex').style.display = '';
  document.getElementById('tab-email').style.display = 'none';
});
document.getElementById('tab-email-btn').addEventListener('click', () => {
  document.getElementById('tab-email-btn').classList.add('active');
  document.getElementById('tab-yandex-btn').classList.remove('active');
  document.getElementById('tab-email').style.display = '';
  document.getElementById('tab-yandex').style.display = 'none';
});

// ── Яндекс (веб-режим) ──────────────────────────────────────────────────────
document.getElementById('btn-yandex').addEventListener('click', () => {
  window.location.href = '/api/yandex-start?state=web';
});

function publicYandexAuthError(code) {
  const key = String(code || '').toLowerCase();
  if (key === 'auth_expired') {
    return 'Сессия входа через Яндекс истекла. Нажми "Войти через Яндекс" ещё раз.';
  }
  if (key === 'service_unavailable' || key === 'token_failed' || key === 'config') {
    return 'Сервис входа через Яндекс сейчас недоступен. Попробуй позже или войди другим способом.';
  }
  if (key === 'web_account_missing') {
    return 'Аккаунт не найден. Сначала войдите в приложение и настройте профиль.';
  }
  if (key === 'web_profile_incomplete') {
    return 'Сначала откройте приложение и придумайте никнейм, потом вход на сайт станет доступен.';
  }
  return 'Не удалось войти через Яндекс. Попробуй позже или войди другим способом.';
}

// При возврате с Яндекса: ?yandex_token=... или ?yandex_error=...
(async () => {
  const p = new URLSearchParams(window.location.search);
  const err = p.get('yandex_error');
  if (err) {
    showAuthErr(publicYandexAuthError(decodeURIComponent(err)));
    history.replaceState(null, '', window.location.pathname);
    return;
  }
  const token = p.get('yandex_token');
  if (token) {
    history.replaceState(null, '', window.location.pathname);
    try {
      await signInWithCustomToken(auth, token);
    } catch (e) {
      showAuthErr('Вход через Яндекс не удался: ' + e.message);
    }
  }
})();

document.getElementById('btn-email-login').addEventListener('click', async () => {
  const login = document.getElementById('auth-email').value.trim();
  const pass  = document.getElementById('auth-password').value;
  if (!login || !pass) { showAuthErr('Заполни ник/email и пароль'); return; }
  const btn = document.getElementById('btn-email-login');
  btn.disabled = true; btn.textContent = 'Вход…';
  try {
    const email = await resolveLoginToEmail(login);
    await signInWithEmailAndPassword(auth, email, pass);
  } catch (e) {
    await logUploadError(e, { action: 'login', login: login.includes('@') ? 'email' : 'nickname' });
    showAuthErr(e.code === 'auth/invalid-credential' ? 'Неверный ник/email или пароль' : e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Войти';
  }
});

async function resolveLoginToEmail(login) {
  if (login.includes('@')) return login;
  const lower = login.toLowerCase().trim();
  const claim = await getDoc(doc(db, 'usernames', lower));
  const claimEmail = firstText(claim.data()?.login_email);
  if (claimEmail) return claimEmail;
  const snap = await getDocs(query(collection(db, 'users'), where('name_lower', '==', lower), limit(1)));
  if (snap.empty) throw new Error('Ник не найден. Попробуй email или войди через Яндекс.');
  const u = snap.docs[0].data();
  const email = firstText(u.user_email, u.email, u.yandex_email, u.linked_yandex_email);
  if (!email) throw new Error('У этого ника нет входа по паролю. Попробуй Яндекс.');
  return email;
}

document.getElementById('btn-signout').addEventListener('click', () => signOut(auth));

function showAuthErr(msg) {
  const el = document.getElementById('auth-err');
  el.textContent = msg; el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}

// ── Valorant API ──────────────────────────────────────────────────────────────
const valorantProxy = url => `/api/valorant-proxy?url=${encodeURIComponent(url)}`;
const proxiedValorantUrl = url =>
  url && /^https:\/\/(valorant-api\.com|media\.valorant-api\.com)\//.test(url)
    ? valorantProxy(url)
    : url;

const ABILITY_NAME_FALLBACKS = {
  'KAY/O': {
    Grenade: 'ФРАГ/мент',
    Flash: 'СВЕТО/вая граната',
    Signature: 'ЭПИ/центр',
    Ultimate: 'NULL/cmd',
    'ZERO/point': 'ЭПИ/центр',
    'FLASH/drive': 'СВЕТО/вая граната',
    'FRAG/ment': 'ФРАГ/мент',
  },
  Viper: {
    'Snakebite': 'Змеиный укус',
    'Snake Bite': 'Змеиный укус',
    'Poison Cloud': 'Ядовитое облако',
  },
  Sage: {
    'Slow Orb': 'Сфера замедления',
  },
  Vyse: {
    'Razorvine': 'Острая лоза',
    'Steel Garden': 'Стальной сад',
    'Arc Rose': 'Дуговая роза',
  },
};

function normalizeAbilityName(agentName, abilityName, slot = '') {
  const raw = (abilityName || '').trim();
  const fallback = ABILITY_NAME_FALLBACKS[agentName]?.[raw] || ABILITY_NAME_FALLBACKS[agentName]?.[slot];
  return fallback || raw || slot;
}

async function loadAgents() {
  try {
    const res  = await fetch(valorantProxy('https://valorant-api.com/v1/agents?isPlayableCharacter=true&language=ru-RU'));
    const data = await res.json();
    agentsList = (data.data || []).sort((a, b) => a.displayName.localeCompare(b.displayName));
    await loadMapAnnotations();
    _restoreDraft();
    const activeCategory = normalizeContentCategory(selectedCategory || '');
    if (activeCategory && activeCategory !== 'wallbang') {
      await loadAgentCategoryAvailability(activeCategory);
    }
    renderAgentsGrid();
  } catch (e) {
    toast('Не удалось загрузить агентов', 'e');
  }
}

async function loadMaps() {
  try {
    const res  = await fetch(valorantProxy('https://valorant-api.com/v1/maps'));
    const data = await res.json();
    mapsData = data.data || [];
    renderMapSiteLabels();
  } catch (_) {}
}

function renderAgentsGrid() {
  const grid = document.getElementById('agents-grid');
  // Filtering must be visually atomic: moving/ghost cards make the form feel
  // unstable and can briefly expose options that are not actually available.
  const animateChanges = false;
  const previousCards = new Map(
    [...grid.querySelectorAll('.agent-card[data-uuid]')].map(card => [
      card.dataset.uuid,
      { card, rect: card.getBoundingClientRect() },
    ]),
  );
  const visibleAgents = agentsForCurrentCategory();
  grid.innerHTML = visibleAgents.length ? visibleAgents.map(a => `
    <div class="agent-card ${a.displayName === selectedAgent ? 'selected' : ''}" data-uuid="${esc(a.uuid)}">
      <img src="${esc(proxiedValorantUrl(a.displayIconSmall || a.displayIcon || ''))}" alt="${esc(a.displayName)}"
           crossorigin="anonymous"
           onerror="this.style.display='none'">
      <span>${esc(a.displayName)}</span>
    </div>`).join('') : '<span style="color:var(--text2);font-size:13px;grid-column:1/-1;">Для этой категории нет доступных агентов</span>';
  grid.dataset.agentGridReady = 'true';

  if (animateChanges) {
    const currentCards = new Map(
      [...grid.querySelectorAll('.agent-card[data-uuid]')].map(card => [card.dataset.uuid, card]),
    );
    currentCards.forEach((card, uuid) => {
      const previous = previousCards.get(uuid);
      if (!previous) {
        card.animate(
          [
            { opacity: 0, transform: 'translateY(7px) scale(.92)' },
            { opacity: 1, transform: 'translateY(0) scale(1)' },
          ],
          { duration: 260, easing: 'cubic-bezier(.22,1,.36,1)' },
        );
        return;
      }
      const nextRect = card.getBoundingClientRect();
      const dx = previous.rect.left - nextRect.left;
      const dy = previous.rect.top - nextRect.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      card.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: 'translate(0, 0)' },
        ],
        { duration: 280, easing: 'cubic-bezier(.22,1,.36,1)' },
      );
    });
    previousCards.forEach(({ card, rect }, uuid) => {
      if (currentCards.has(uuid) || rect.width <= 0 || rect.height <= 0) return;
      const leavingCard = card.cloneNode(true);
      Object.assign(leavingCard.style, {
        position: 'fixed',
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        margin: '0',
        pointerEvents: 'none',
        transformOrigin: 'center',
        zIndex: '9999',
      });
      document.body.appendChild(leavingCard);
      const animation = leavingCard.animate(
        [
          { opacity: 1, transform: 'translateY(0) scale(1)' },
          { opacity: 0, transform: 'translateY(-7px) scale(.88)' },
        ],
        { duration: 220, easing: 'cubic-bezier(.4,0,1,1)' },
      );
      animation.finished.then(() => leavingCard.remove(), () => leavingCard.remove());
    });
  }

  grid.querySelectorAll('.agent-card').forEach(card => {
    card.addEventListener('click', () => {
      const agent = agentsList.find(a => a.uuid === card.dataset.uuid);
      if (!agent || agent.displayName === selectedAgent) return;
      if (selectedAgent && categoryHasPlacedData(selectedCategory)) {
        const ok = window.confirm('Вы уверены, что хотите переключить агента? Это сотрёт расставленные точки и траектории для текущего агента.');
        if (!ok) return;
        markerX = markerY = null;
        trajectoryPoints = [];
        extraAbilityTrajectories = [];
        selectedExtraAbilityIndex = null;
        defenseAbilities = [];
        selectedDefenseAbility = null;
        selectedDefenseMarkerIndex = null;
        defenseLineDraft = null;
        defenseLineJustCreated = false;
        document.getElementById('map-marker').style.display = 'none';
        renderTrajectory();
        renderDefenseAbilityMarkers();
      }
      grid.querySelectorAll('.agent-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectAgent(agent);
    });
  });
  if (!selectedAgent) {
    const row = document.getElementById('abilities-row');
    if (row) row.innerHTML = '<span class="ability-empty-hint">Сначала выбери агента</span>';
  }
}

const DEFAULT_MAP_SITE_LABELS = {
  Haven: [{ label: 'A', x: .78, y: .34 }, { label: 'B', x: .52, y: .50 }, { label: 'C', x: .22, y: .51 }],
  Lotus: [{ label: 'A', x: .78, y: .33 }, { label: 'B', x: .50, y: .50 }, { label: 'C', x: .20, y: .55 }],
  Corrode: [{ label: 'A', x: .38, y: .35 }, { label: 'B', x: .72, y: .48 }],
  Summit: [{ label: 'A', x: .74, y: .30 }, { label: 'B', x: .32, y: .27 }],
};

let mapSiteLabelsConfig = {};
let mapSpawnZonesConfig = {};
let mapAnnotationModesConfig = {};
const DEFAULT_MAP_ORIENTATIONS = { Haven: 1 };
let mapOrientationsConfig = { ...DEFAULT_MAP_ORIENTATIONS };
let currentAnnotationMode = null;
let mapAnnotationsPromise = null;
let mapAnnotationsReady = false;
function loadMapAnnotations() {
  if (mapAnnotationsPromise) return mapAnnotationsPromise;
  mapAnnotationsPromise = Promise.all([
    getDoc(doc(db, 'settings', 'map_site_labels')),
    getDoc(doc(db, 'settings', 'map_spawn_zones')),
    getDoc(doc(db, 'settings', 'map_annotation_modes')),
    getDoc(doc(db, 'settings', 'map_orientations')),
  ]).then(([labels, zones, modes, orientations]) => {
    mapSiteLabelsConfig = labels.exists() ? labels.data() : {};
    mapSpawnZonesConfig = zones.exists() ? zones.data() : {};
    mapAnnotationModesConfig = modes.exists() ? modes.data() : {};
    const storedOrientations = orientations.data()?.defense_quarter_turns;
    mapOrientationsConfig = {
      ...DEFAULT_MAP_ORIENTATIONS,
      ...(storedOrientations && typeof storedOrientations === 'object' ? storedOrientations : {}),
    };
    applyMapViewTransform();
    renderMapSiteLabels();
    mapAnnotationsReady = true;
    return true;
  }).catch(error => {
    mapAnnotationsReady = true;
    logUploadError(error, { action: 'map_annotations_load_failed' });
    console.warn('map annotations', error);
    return false;
  });
  return mapAnnotationsPromise;
}

function currentMapQuarterTurns() {
  const map = document.getElementById('sel-map')?.value || '';
  if (!map || !selectedRoundSide) return 0;
  const attackTurns = ((Number(mapOrientationsConfig[map]) || 0) % 4 + 4) % 4;
  return selectedRoundSide === 'defense' ? (attackTurns + 2) % 4 : attackTurns;
}

function annotationModeFor() { return currentAnnotationMode || 'main'; }
function renderAnnotationModeButtons(map) {
  const mode = annotationModeFor(map);
  document.querySelectorAll('.map-annotation-mode').forEach(button => button.classList.toggle('selected-mode', button.dataset.mapAnnotationMode === mode));
}

function renderMapSiteLabels() {
  const layer = document.getElementById('map-site-labels');
  const map = document.getElementById('sel-map')?.value || '';
  if (!layer) return;
  const mode = annotationModeFor(map);
  renderAnnotationModeButtons(map);
  if (mode === 'clean') { layer.innerHTML = ''; return; }
  const apiMap = mapsData.find(item => item.displayName === map);
  const apiLabels = (apiMap?.callouts || []).map((callout, index) => {
    const region = String(callout.regionName || '').trim();
    const superRegion = String(callout.superRegionName || '').trim();
    if (!region || region === 'Spawn' || ['Attacker Side', 'Defender Side'].includes(superRegion)) return null;
    const x = Number(callout.location?.y) * Number(apiMap.xMultiplier) + Number(apiMap.xScalarToAdd);
    const y = Number(callout.location?.x) * Number(apiMap.yMultiplier) + Number(apiMap.yScalarToAdd);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
    const isSite = ['A', 'B', 'C'].includes(superRegion) && /site/i.test(region);
    return { id:`api-${index}`, label:isSite ? superRegion : region, x, y, level:isSite ? 'site' : 'full' };
  }).filter(Boolean);
  const configuredLabels = Array.isArray(mapSiteLabelsConfig[map]) ? mapSiteLabelsConfig[map] : [];
  const hasConfiguredCallouts = configuredLabels.some(item =>
    !['site'].includes(item?.level)
    && !/^[ABC]$/i.test(String(item?.label || '').trim()));
  const sourceLabels = configuredLabels.length
    ? [...configuredLabels, ...(hasConfiguredCallouts ? [] : apiLabels)]
    : [...(DEFAULT_MAP_SITE_LABELS[map] || []), ...apiLabels];
  const seenLabels = new Set();
  const labels = sourceLabels.filter(item => {
    if (!item) return false;
    const level = item.level || (/^[ABC]$/i.test(String(item.label || '').trim()) ? 'site' : 'full');
    if (mode === 'main' && level !== 'site') return false;
    const normalizedLabel = String(item.label || '').trim().toUpperCase();
    const key = level === 'site' && /^[ABC]$/.test(normalizedLabel)
      ? `site:${normalizedLabel}`
      : `${normalizedLabel.toLowerCase()}|${Number(item.x).toFixed(3)}|${Number(item.y).toFixed(3)}`;
    if (seenLabels.has(key)) return false;
    seenLabels.add(key);
    return true;
  });
  let zones = mapSpawnZonesConfig[map] || {};
  if (!zones.attack || !zones.defense) {
    const apiZones = {};
    for (const [side, superRegion] of Object.entries({ attack:'Attacker Side', defense:'Defender Side' })) {
      const spawn = (apiMap?.callouts || []).find(item => item.regionName === 'Spawn' && item.superRegionName === superRegion);
      if (!spawn) continue;
      const centerX = Number(spawn.location?.y) * Number(apiMap.xMultiplier) + Number(apiMap.xScalarToAdd);
      const centerY = Number(spawn.location?.x) * Number(apiMap.yMultiplier) + Number(apiMap.yScalarToAdd);
      if (Number.isFinite(centerX) && Number.isFinite(centerY)) {
        apiZones[side] = { x:Math.max(0, Math.min(.88, centerX - .06)), y:Math.max(0, Math.min(.90, centerY - .05)), width:.12, height:.10 };
      }
    }
    zones = { ...apiZones, ...zones };
  }
  const zoneHtml = Object.entries(zones).filter(([,zone]) => zone && typeof zone === 'object').map(([side, zone]) => {
    const color = side === 'attack' ? '255,70,85' : '79,195,247';
    const label = side === 'attack' ? 'T SPAWN' : 'CT SPAWN';
    return `<span class="map-spawn-zone" style="left:${Number(zone.x||0)*100}%;top:${Number(zone.y||0)*100}%;width:${Number(zone.width||0)*100}%;height:${Number(zone.height||0)*100}%;color:rgb(${color});border-color:rgba(${color},.85);background:rgba(${color},.16)"><b>${label}</b></span>`;
  }).join('');
  layer.innerHTML = zoneHtml + labels.map(item => `<span class="map-site-label" style="left:${Number(item.x) * 100}%;top:${Number(item.y) * 100}%">${esc(item.label)}</span>`).join('');
}

document.querySelectorAll('.map-annotation-mode').forEach(button => button.addEventListener('click', () => {
  currentAnnotationMode = button.dataset.mapAnnotationMode || 'full';
  renderMapSiteLabels();
}));
loadMapAnnotations();

function selectAgent(agent) {
  selectedAgent   = agent.displayName;
  selectedAbility = null;
  renderSovaShotPanel();
  extraAbilityTrajectories = [];
  selectedExtraAbilityIndex = null;
  selectedDefenseAbility = null;
  selectedDefenseMarkerIndex = null;
  if (normalizeContentCategory(selectedCategory) === 'defense') {
    defenseAbilities = [];
    renderDefenseAbilityPanel();
    renderDefenseAbilityMarkers();
    updateMarkerIcon();
    validateForm(); _saveDraft();
  }
  const row = document.getElementById('abilities-row');
  const abilities = (agent.abilities || []).filter(ab =>
    ab.displayIcon && ab.slot !== 'Passive' && agentAbilityEnabled(agent, ab, selectedCategory)
  );
  if (!abilities.length) {
    row.innerHTML = '<span style="color:var(--text2);font-size:13px;">Нет доступных абилок</span>';
    validateForm();
    return;
  }
  row.innerHTML = abilities.map(ab => `
    <button class="ability-btn" data-key="${esc(normalizeAbilityName(agent.displayName, ab.displayName, ab.slot))}" data-slot="${esc(ab.slot || '')}" title="${esc(normalizeAbilityName(agent.displayName, ab.displayName, ab.slot))}">
      <span class="ability-icon-wrap">
        <img src="${esc(ab.displayIcon)}" alt="" loading="eager" decoding="async" referrerpolicy="no-referrer">
        <span class="ability-icon-fallback">${esc(({ Ability1: 'Q', Ability2: 'E', Grenade: 'C', Ultimate: 'X' })[ab.slot] || '•')}</span>
      </span>
      <span class="ability-name">${esc(normalizeAbilityName(agent.displayName, ab.displayName, ab.slot).split(' ')[0])}</span>
    </button>`).join('');
  row.querySelectorAll('.ability-icon-wrap img').forEach(img => {
    const markLoaded = () => img.closest('.ability-icon-wrap')?.classList.add('loaded');
    if (img.complete && img.naturalWidth > 0) markLoaded();
    else img.addEventListener('load', markLoaded, { once: true });
  });
  row.querySelectorAll('.ability-btn').forEach(b => {
    b.addEventListener('click', () => {
      row.querySelectorAll('.ability-btn').forEach(x => x.classList.remove('selected'));
      b.classList.add('selected');
      selectedAbility = b.dataset.key;
      renderSovaShotPanel();
      extraAbilityTrajectories = extraAbilityTrajectories.filter(item => item.ability !== selectedAbility);
      selectedExtraAbilityIndex = null;
      updateMarkerIcon();
      renderExtraAbilityPanel();
      renderTrajectory();
      validateForm(); _saveDraft();
    });
  });
  renderExtraAbilityPanel();
  validateForm();
}

// ── Category & Difficulty ─────────────────────────────────────────────────────
document.getElementById('cat-row').querySelectorAll('.pill-btn').forEach(b => {
  b.addEventListener('click', () => {
    if (b.disabled || b.classList.contains('locked')) {
      toast('Эта категория скоро появится. Пока её заполняют админы.', 'i');
      return;
    }
    const nextCategory = normalizeContentCategory(b.dataset.val);
    const categoryChanged = Boolean(
      selectedCategory &&
      nextCategory &&
      nextCategory !== normalizeContentCategory(selectedCategory)
    );
    if (selectedCategory && nextCategory && nextCategory !== selectedCategory && categoryHasPlacedData(selectedCategory)) {
      const saveFirst = window.confirm('Вы собираетесь переключить категорию. Нажмите OK, чтобы сохранить текущий вариант как черновик и переключиться. Нажмите Отмена, чтобы переключиться со сбросом данных текущей категории.');
      if (saveFirst) saveCurrentDraftCopy('Текущий вариант сохранён в черновики');
      resetCategorySpecificData();
    }
    // Agent and ability choices belong to a category. Carrying them over can
    // briefly expose abilities that are disabled for the newly selected type
    // while its Firestore availability config is still loading.
    if (categoryChanged) {
      selectedAgent = null;
      selectedAbility = null;
      selectedDefenseAbility = null;
      selectedDefenseMarkerIndex = null;
      defenseAbilities = [];
      const abilitiesRow = document.getElementById('abilities-row');
      if (abilitiesRow) abilitiesRow.innerHTML = '<span class="ability-empty-hint">Сначала выбери агента</span>';
    }
    document.getElementById('cat-row').querySelectorAll('.pill-btn').forEach(x => x.classList.remove('selected'));
    b.classList.add('selected');
    selectedCategory = nextCategory;
    if (!canSubmitContentCategory(selectedCategory)) {
      selectedCategory = null;
      b.classList.remove('selected');
      toast('Эта категория пока закрыта для отправки.', 'i');
      updateCategoryUi(); _saveDraft();
      return;
    }
    updateCategoryUi(); _saveDraft();
    updateCategoryTrainingGate();
    showLineupFormGuideOnFirstCategoryChoice();
  });
});
document.getElementById('diff-row').querySelectorAll('.pill-btn').forEach(b => {
  b.addEventListener('click', () => {
    document.getElementById('diff-row').querySelectorAll('.pill-btn').forEach(x => x.classList.remove('selected'));
    b.classList.add('selected');
    selectedDifficulty = b.dataset.val;
    validateForm(); _saveDraft();
  });
});

document.getElementById('mode-wallbang-target')?.addEventListener('click', () => setMapMode('target'));
document.getElementById('wallbang-target-clear')?.addEventListener('click', () => {
  wallbangTargetX = wallbangTargetY = null;
  if (mapMode === 'target') setMapMode('position');
  renderCategoryMapExtras();
  validateForm(); _saveDraft();
});
document.getElementById('mode-defense-zoom')?.addEventListener('click', () => {
  defenseZoomStart = null;
  setMapMode('zoom');
});
document.getElementById('defense-zoom-clear')?.addEventListener('click', () => {
  defenseZoomStart = null;
  defenseZoomArea = null;
  if (mapMode === 'zoom') setMapMode('position');
  renderCategoryMapExtras();
  validateForm(); _saveDraft();
});
['defense-site'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', () => {
    validateForm(); _saveDraft();
  });
});

// ── Char counters ─────────────────────────────────────────────────────────────
document.getElementById('inp-title').addEventListener('input', e => {
  document.getElementById('title-count').textContent = e.target.value.length;
  validateForm(); _saveDraft();
});
document.getElementById('inp-desc').addEventListener('input', e => {
  document.getElementById('desc-count').textContent = e.target.value.length;
  _saveDraft();
});
document.getElementById('sel-map').addEventListener('change', async () => {
  resetMapView();
  renderDefenseSiteOptions();
  await loadMapAnnotations();
  loadMapMinimap();
  validateForm(); _saveDraft();
});

// ── Video — file tab ──────────────────────────────────────────────────────────
const dropZone    = document.getElementById('drop-zone');
const vidInput    = document.getElementById('vid-file-input');
const vidPlayer   = document.getElementById('vid-player');
const vidScrubber = document.getElementById('vid-scrubber');
const vidTimeEl   = document.getElementById('vid-time');
const vidPlayBtn  = document.getElementById('vid-play-btn');
const vidMuteBtn = document.getElementById('vid-mute-btn');
const vidVolume = document.getElementById('vid-volume');
const fullscreenVidScrubber = document.getElementById('video-player-fullscreen-scrubber');
const fullscreenVidTimeEl = document.getElementById('video-player-fullscreen-time');
const fullscreenVidPlayBtn = document.getElementById('video-player-fullscreen-play');
const fullscreenVidMuteBtn = document.getElementById('video-player-fullscreen-mute');
const fullscreenVidVolume = document.getElementById('video-player-fullscreen-volume');
let activeEditorMode = 'trim';
let timelineDrag = null;
let scrubberDragging = false;
let scrubberResumePlayback = false;
let pendingVideoSeekRatio = null;
let suppressTimelineClick = false;
let selectedEditorItem = null;
let freezeHoldTimer = null;
let freezeHoldActive = null;
let freezeHoldRenderInterval = null;
let playedFreezeHolds = new Set();
let lastVideoTime = 0;
let freezeDrawingVisibleId = '';
let freezeDrawingPointer = null;
let freezeDrawingTool = 'brush';
let freezeDrawingColor = '#00d4ff';
let freezeDrawingWidth = 0.006;
let freezeDrawingRenderKey = '';
let videoViewerZoom = { scale: 1, panX: 0, panY: 0 };
let videoViewerZoomResetTimer = null;
let timelinePixelsPerSecond = 52;
let timelineMagnetEnabled = true;
let activeEffectTrack = 0;
const TIMELINE_FRAME_SECONDS = 60;
const EFFECT_TRACK_HEIGHT = 36;
const MIN_TRIM_DURATION_SECONDS = 0.2;
const MIN_TIMELINE_CLIP_WIDTH_PX = 24;
const VIDEO_EDIT_UNDO_KEY = 'vlineups_video_edit_undo_v2';
const VIDEO_EDIT_REDO_KEY = 'vlineups_video_edit_redo_v1';
const MODERATOR_VIDEO_EDIT_BACKUP_KEY = 'vlineups_moderator_video_edit_backup_v1';
const VIDEO_EDIT_UNDO_LIMIT = 12;
let videoEditUndoStack = [];
let videoEditRedoStack = [];
let lastCommittedVideoEditState = null;
let resetConfirmTimer = null;
let videoEditorHotkeysActive = false;
let timelinePreviewOutputTime = null;
let videoEditConfirmationReturnFocus = null;
let outputPlaybackActive = false;
let outputPlaybackRaf = null;
let outputPlaybackStartedAt = 0;
let outputPlaybackStartTime = 0;
let outputPlaybackTime = null;
let lastVideoReviveAt = 0;
let videoHiddenAt = 0;
let chromaRenderRaf = null;
let chromaRenderFootageId = null;
let chromaRenderSignature = '';
let chromaRenderErrorShown = false;
let chromaRenderLastAt = 0;
let chromaRenderLastVideoTime = -1;
let footageStageDrag = null;
let timelineSmoothRaf = null;
let timelineSmoothLastAt = 0;
const TIMELINE_UI_FRAME_INTERVAL_MS = 1000 / 30;
const CHROMA_PREVIEW_FRAME_INTERVAL_MS = 1000 / 15;
const CHROMA_PREVIEW_MAX_WIDTH = 640;
const CHROMA_PREVIEW_MAX_HEIGHT = 360;
const freezeFrameImages = new Map();
const editorEls = {
  editor: document.getElementById('video-editor'),
  playerWrap: document.getElementById('vid-player-wrap'),
  toggle: document.getElementById('video-editor-toggle'),
  fullscreenOpen: document.getElementById('video-editor-fullscreen-open'),
  fullscreenClose: document.getElementById('video-editor-fullscreen-close'),
  playerFullscreenOpen: document.getElementById('video-player-fullscreen-open'),
  playerFullscreenClose: document.getElementById('video-player-fullscreen-close'),
  commandbarState: document.getElementById('video-editor-commandbar-state'),
  scroll: document.getElementById('timeline-scroll'),
  shell: document.getElementById('timeline-shell'),
  stage: document.getElementById('vid-stage'),
  viewerViewport: document.getElementById('video-viewer-viewport'),
  viewerZoomHud: document.getElementById('video-viewer-zoom-hud'),
  footagePreview: document.getElementById('footage-preview-overlay'),
  footageCanvas: document.getElementById('footage-chroma-canvas'),
  footageFrame: document.getElementById('footage-transform-frame'),
  freezeOverlay: document.getElementById('freeze-frame-overlay'),
  freezeDrawingCanvas: document.getElementById('freeze-drawing-canvas'),
  freezeDrawingVector: document.getElementById('freeze-drawing-vector'),
  freezeDrawingPanel: document.getElementById('freeze-draw-panel'),
  freezeDrawingUndo: document.getElementById('freeze-draw-undo'),
  freezeDrawingClear: document.getElementById('freeze-draw-clear'),
  zoomFrame: document.getElementById('zoom-preview-frame'),
  playhead: document.getElementById('timeline-playhead'),
  trimRange: document.getElementById('video-trim-range'),
  markers: document.getElementById('video-markers'),
  effectLane: document.getElementById('effect-lane'),
  effectMarkers: document.getElementById('effect-markers'),
  wave: document.getElementById('audio-wave'),
  timeLabel: document.getElementById('editor-time-label'),
  summary: document.getElementById('editor-summary'),
  hint: document.getElementById('editor-mode-hint'),
  timelineZoom: document.getElementById('timeline-zoom'),
  magnet: document.getElementById('timeline-magnet'),
  trimStart: document.getElementById('edit-trim-start'),
  trimEnd: document.getElementById('edit-trim-end'),
  volume: document.getElementById('edit-volume'),
  volumeLabel: document.getElementById('edit-volume-label'),
  muted: document.getElementById('edit-muted'),
  chromaEnabled: document.getElementById('edit-chroma-enabled'),
  chromaColor: document.getElementById('edit-chroma-color'),
  chromaStrength: document.getElementById('edit-chroma-strength'),
  chromaTarget: document.getElementById('edit-chroma-target'),
  footageScale: document.getElementById('edit-footage-scale'),
  footageInput: document.getElementById('edit-footage-input'),
  footageStatus: document.getElementById('edit-footage-status'),
  inspectorTitle: document.getElementById('editor-inspector-title'),
  inspectorBadge: document.getElementById('editor-inspector-badge'),
  inspectorSelection: document.getElementById('editor-inspector-selection'),
  inspectorProperties: document.getElementById('editor-inspector-properties'),
  footageLibrary: document.getElementById('footage-library'),
  undo: document.getElementById('edit-undo'),
  redo: document.getElementById('edit-redo'),
  reset: document.getElementById('edit-reset'),
  confirmation: document.getElementById('editor-confirmation'),
  confirmationTitle: document.getElementById('editor-confirmation-title'),
  confirmationDetail: document.getElementById('editor-confirmation-detail'),
  confirm: document.getElementById('edit-confirm'),
  confirmModal: document.getElementById('editor-confirm-modal'),
  confirmClose: document.getElementById('editor-confirm-close'),
  confirmBack: document.getElementById('editor-confirm-back'),
  confirmCommit: document.getElementById('editor-confirm-commit'),
  confirmFacts: document.getElementById('editor-confirm-facts'),
  confirmChecks: document.getElementById('editor-confirm-checks'),
  zoomScaleX: document.getElementById('edit-zoom-scale-x'),
  zoomScaleY: document.getElementById('edit-zoom-scale-y'),
  zoomPosX: document.getElementById('edit-zoom-pos-x'),
  zoomPosY: document.getElementById('edit-zoom-pos-y'),
  zoomRotation: document.getElementById('edit-zoom-rotation'),
  zoomRotationRange: document.getElementById('edit-zoom-rotation-range'),
  zoomAnchorX: document.getElementById('edit-zoom-anchor-x'),
  zoomAnchorY: document.getElementById('edit-zoom-anchor-y'),
  zoomValue: document.getElementById('edit-zoom-value'),
  zoomPanel: document.getElementById('zoom-panel'),
  effectsPanel: document.getElementById('effects-panel'),
};

const VIDEO_EDITOR_COLLAPSED_KEY = 'valorant_upload_video_editor_collapsed_v1';
function setVideoEditorFullscreen(open) {
  if (!editorEls.playerWrap) return;
  const enabled = !!open;
  editorEls.playerWrap.classList.toggle('video-editor-fullscreen', enabled);
  document.body.classList.toggle('video-editor-fullscreen-open', enabled);
  if (enabled) setVideoEditorCollapsed(false, false);
  requestAnimationFrame(() => {
    renderVideoEditor();
    if (enabled) editorEls.fullscreenClose?.focus();
    else editorEls.fullscreenOpen?.focus();
  });
}
function setVideoEditorCollapsed(collapsed, persist = true) {
  if (!editorEls.editor || !editorEls.toggle) return;
  editorEls.editor.hidden = collapsed;
  editorEls.toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  editorEls.toggle.textContent = collapsed ? '▸ Показать панель монтажа' : '▾ Скрыть панель монтажа';
  if (persist) {
    try { localStorage.setItem(VIDEO_EDITOR_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch (_) {}
  }
  if (!collapsed) requestAnimationFrame(renderVideoEditor);
}
try { setVideoEditorCollapsed(localStorage.getItem(VIDEO_EDITOR_COLLAPSED_KEY) === '1', false); } catch (_) {}
editorEls.toggle?.addEventListener('click', () => setVideoEditorCollapsed(!editorEls.editor.hidden));
editorEls.fullscreenOpen?.addEventListener('click', () => setVideoEditorFullscreen(true));
editorEls.fullscreenClose?.addEventListener('click', () => setVideoEditorFullscreen(false));

async function setVideoPlayerFullscreen(open) {
  if (!editorEls.stage) return;
  try {
    if (open) {
      if (!document.fullscreenElement) await editorEls.stage.requestFullscreen();
    } else if (document.fullscreenElement) {
      await document.exitFullscreen();
    }
  } catch (error) {
    toast(`Не удалось открыть видео на весь экран: ${error.message}`, 'e');
  }
}
editorEls.playerFullscreenOpen?.addEventListener('click', () => setVideoPlayerFullscreen(true));
editorEls.playerFullscreenClose?.addEventListener('click', () => setVideoPlayerFullscreen(false));

function renderVideoViewerZoom() {
  const viewport = editorEls.viewerViewport;
  if (!viewport) return;
  const { scale, panX, panY } = videoViewerZoom;
  viewport.style.transform = `translate3d(${panX}px, ${panY}px, 0) scale(${scale})`;
  editorEls.viewerZoomHud?.classList.toggle('active', scale > 1.001);
  if (editorEls.viewerZoomHud) editorEls.viewerZoomHud.value = `${Math.round(scale * 100)}%`;
}

function resetVideoViewerZoom({ announce = false } = {}) {
  if (videoViewerZoomResetTimer) clearTimeout(videoViewerZoomResetTimer);
  editorEls.viewerViewport?.classList.add('resetting');
  videoViewerZoom = { scale: 1, panX: 0, panY: 0 };
  renderVideoViewerZoom();
  videoViewerZoomResetTimer = setTimeout(() => {
    editorEls.viewerViewport?.classList.remove('resetting');
    videoViewerZoomResetTimer = null;
  }, 260);
  if (announce) toast('Зум просмотра сброшен до 100%', 'i');
}

editorEls.stage?.addEventListener('wheel', event => {
  if (!hasVideoForHotkeys()) return;
  if (event.target.closest?.('.footage-preview-overlay.interactive,.footage-chroma-canvas.interactive,.footage-transform-frame')) return;
  event.preventDefault();
  editorEls.viewerViewport?.classList.remove('resetting');
  const rect = editorEls.stage.getBoundingClientRect();
  const direction = Math.max(-120, Math.min(120, event.deltaY));
  const nextScale = clampVideoViewerZoom(videoViewerZoom.scale * Math.exp(-direction * 0.0022));
  videoViewerZoom = zoomVideoViewerAtPoint(
    videoViewerZoom,
    nextScale,
    { x: event.clientX - rect.left, y: event.clientY - rect.top },
    rect,
  );
  renderVideoViewerZoom();
}, { passive: false });
renderVideoViewerZoom();

function createDefaultVideoEdit() {
  return {
    version: 2,
    revision: 0,
    confirmation: { status: 'pending', confirmedRevision: null, confirmedAt: null },
    trimStart: 0,
    trimEnd: 0,
    splits: [],
    clips: null,
    freezeFrames: [],
    zoomKeyframes: [],
    effectTracks: 1,
    audio: { muted: false, volume: 1 },
    chromaKey: { enabled: false, color: '#00ff00', strength: 0.35 },
    footageOverlays: [],
  };
}

function saveModeratorVideoEditBackup() {
  if (!moderatorDraftSourceId || !videoUrl) return;
  try {
    localStorage.setItem(MODERATOR_VIDEO_EDIT_BACKUP_KEY, JSON.stringify({
      lineupId: moderatorDraftSourceId,
      videoUrl,
      videoEdit: normalizedVideoEdit(),
      updatedAt: Date.now(),
    }));
  } catch (_) {}
}

function moderatorVideoEditBackup(lineupId, expectedVideoUrl = '') {
  try {
    const backup = JSON.parse(localStorage.getItem(MODERATOR_VIDEO_EDIT_BACKUP_KEY) || 'null');
    if (!backup || backup.lineupId !== lineupId || !backup.videoEdit) return null;
    if (expectedVideoUrl && backup.videoUrl && backup.videoUrl !== expectedVideoUrl) return null;
    return backup.videoEdit;
  } catch (_) {
    return null;
  }
}

function clearModeratorVideoEditBackup(lineupId = '') {
  try {
    const backup = JSON.parse(localStorage.getItem(MODERATOR_VIDEO_EDIT_BACKUP_KEY) || 'null');
    if (!lineupId || !backup || backup.lineupId === lineupId) {
      localStorage.removeItem(MODERATOR_VIDEO_EDIT_BACKUP_KEY);
    }
  } catch (_) {
    try { localStorage.removeItem(MODERATOR_VIDEO_EDIT_BACKUP_KEY); } catch (_) {}
  }
}

function normalizeChromaKey(value = {}) {
  const color = /^#[0-9a-f]{6}$/i.test(String(value.color || '')) ? String(value.color).toLowerCase() : '#00ff00';
  return {
    enabled: !!value.enabled,
    color,
    strength: Math.max(0, Math.min(1, Number(value.strength ?? 0.35))),
  };
}

function videoDuration() {
  const nativeDuration = Number(vidPlayer.duration);
  const native = Number.isFinite(nativeDuration) && nativeDuration > 0 ? nativeDuration : 0;
  const known = Number.isFinite(knownVideoDuration) && knownVideoDuration > 0 ? knownVideoDuration : 0;
  // Chromium can expose the end of the currently buffered fragment as the
  // duration (1s, 4s, ...), even when the full file duration is already known.
  return Math.max(native, known);
}

function syncKnownVideoDuration(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0) return false;
  const nextDuration = Math.max(knownVideoDuration, duration);
  const changed = Math.abs(knownVideoDuration - nextDuration) > 0.01;
  videoEdit = reconcileVideoSourceDuration(videoEdit, knownVideoDuration, nextDuration);
  knownVideoDuration = nextDuration;
  if (changed) renderVideoTransport();
  return true;
}

function releaseLocalVideoPreview() {
  fullVideoLoadController?.abort();
  fullVideoLoadController = null;
  if (localVideoPreviewUrl) URL.revokeObjectURL(localVideoPreviewUrl);
  localVideoPreviewUrl = '';
}

async function loadCompleteVideoForEditor(remoteUrl) {
  const sequence = ++fullVideoLoadSequence;
  fullVideoLoadController?.abort();
  const controller = new AbortController();
  fullVideoLoadController = controller;
  const progress = document.getElementById('vid-upload-progress');
  const percent = document.getElementById('vid-pct');
  const bar = document.getElementById('vid-prog');
  const wrap = document.getElementById('vid-player-wrap');
  if (wrap) wrap.style.display = 'none';
  if (progress) progress.style.display = '';
  if (percent) percent.textContent = 'Подготовка видео…';
  if (bar) bar.style.width = '0%';
  try {
    const response = await fetch(videoEditorSourceUrl(remoteUrl), { signal:controller.signal, cache:'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const total = Math.max(0, Number(response.headers.get('content-length') || 0));
    const reader = response.body?.getReader();
    const chunks = [];
    let received = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        if (total > 0) {
          const valuePercent = Math.min(100, Math.round(received / total * 100));
          if (percent) percent.textContent = `Подготовка ${valuePercent}%`;
          if (bar) bar.style.width = `${valuePercent}%`;
        } else if (percent) {
          percent.textContent = `Загружено ${(received / 1048576).toFixed(1)} МБ`;
        }
      }
    } else {
      chunks.push(new Uint8Array(await response.arrayBuffer()));
    }
    if (sequence !== fullVideoLoadSequence) return false;
    const blob = new Blob(chunks, { type:response.headers.get('content-type') || 'video/mp4' });
    releaseLocalVideoPreview();
    localVideoPreviewUrl = URL.createObjectURL(blob);
    const metadata = await readVideoMetadata(blob);
    syncKnownVideoDuration(metadata.duration);
    vidPlayer.removeAttribute('crossorigin');
    vidPlayer.src = localVideoPreviewUrl;
    vidPlayer.load();
    if (percent) percent.textContent = '100%';
    if (bar) bar.style.width = '100%';
    if (progress) progress.style.display = 'none';
    if (wrap) wrap.style.display = '';
    renderVideoEditor();
    return true;
  } catch (error) {
    if (error?.name === 'AbortError') return false;
    if (progress) progress.style.display = 'none';
    toast(`Не удалось полностью загрузить видео: ${error.message}`, 'e');
    return false;
  } finally {
    if (fullVideoLoadController === controller) fullVideoLoadController = null;
  }
}

function clampTime(value) {
  const duration = videoDuration();
  const raw = Number(value);
  const n = Number.isFinite(raw) ? raw : 0;
  if (!duration) return Math.max(0, n);
  return Math.max(0, Math.min(duration, n));
}

function frameStep() {
  return 1 / 30;
}

function snapFrameTime(time) {
  const step = frameStep();
  const raw = Number(time);
  const value = Number.isFinite(raw) ? raw : 0;
  return clampTime(Math.round(value / step) * step);
}

function clampOutputTime(value) {
  const duration = editedOutputDuration();
  const n = Number(value || 0);
  if (!duration) return Math.max(0, n);
  return Math.max(0, Math.min(duration, n));
}

function timelineFrameDuration() {
  const output = editedOutputDuration();
  return Math.max(TIMELINE_FRAME_SECONDS, output || 0);
}

function timelinePct(value) {
  const duration = timelineFrameDuration();
  return duration ? Math.max(0, Math.min(100, Number(value || 0) / duration * 100)) : 0;
}

function timelineWidthPx() {
  const viewportWidth = Math.max(620, Number(editorEls.scroll?.clientWidth || 0));
  return Math.max(viewportWidth, Math.round(timelineFrameDuration() * timelinePixelsPerSecond));
}

function timelineBlockStyle(start, duration, minWidthPx = MIN_TIMELINE_CLIP_WIDTH_PX) {
  const leftPx = Math.max(0, Number(start || 0) * timelinePixelsPerSecond);
  const widthPx = Math.max(minWidthPx, Number(duration || 0) * timelinePixelsPerSecond);
  return `left:${leftPx}px;width:${widthPx}px`;
}

function timelineX(outputTime) {
  return Math.max(0, Number(outputTime || 0) * timelinePixelsPerSecond);
}

function effectOutputStart(item) {
  return clampOutputTime(sharedEffectOutputStart(item, videoEdit, videoDuration()));
}

function normalizedVideoEdit() {
  const duration = videoDuration();
  const rawStart = clampTime(videoEdit.trimStart);
  const rawEnd = clampTime(videoEdit.trimEnd || duration);
  const minTrim = duration ? Math.min(MIN_TRIM_DURATION_SECONDS, duration) : MIN_TRIM_DURATION_SECONDS;
  const trimStart = duration
    ? Math.max(0, Math.min(rawStart, Math.max(0, rawEnd - minTrim)))
    : Math.min(rawStart, rawEnd);
  const trimEnd = duration
    ? Math.min(duration, Math.max(rawEnd, trimStart + minTrim))
    : Math.max(rawStart, rawEnd);
  const clipBoundaries = [...new Set([trimStart, ...(videoEdit.splits || []), trimEnd]
    .map(clampTime).filter(value => value >= trimStart && value <= trimEnd))].sort((a, b) => a - b);
  const derivedClips = clipBoundaries.slice(0, -1).map((sourceStart, index) => ({
    id:`clip_${Math.round(sourceStart * 1000)}_${Math.round(clipBoundaries[index + 1] * 1000)}`,
    sourceStart,
    sourceEnd:clipBoundaries[index + 1],
  })).filter(clip => clip.sourceEnd - clip.sourceStart >= 0.001);
  const clips = Array.isArray(videoEdit.clips)
    ? videoEdit.clips.map((clip, index) => ({
      id:String(clip?.id || `clip_${index}_${Math.round(Number(clip?.sourceStart || 0) * 1000)}`),
      sourceStart:clampTime(clip?.sourceStart),
      sourceEnd:clampTime(clip?.sourceEnd),
      ...(Number.isFinite(Number(clip?.timelineStart)) ? { timelineStart:Math.max(0, Number(clip.timelineStart)) } : {}),
    })).filter(clip => clip.sourceEnd - clip.sourceStart >= 0.001)
    : null;
  const storedTrackCount = Math.max(1, Math.min(8, Number(videoEdit.effectTracks || 1)));
  const allEffects = [
    ...(videoEdit.zoomKeyframes || []).map(item => ({ ...item, kind: 'zoom' })),
    ...(videoEdit.footageOverlays || []).map(item => ({ ...item, kind: 'footage' })),
  ];
  const recoveredTracks = new Map();
  const savedTracksCollapsed = storedTrackCount === 1 && allEffects.length > 1 &&
    allEffects.every(item => Math.max(0, Number(item.track || 0)) === 0);
  if (savedTracksCollapsed) {
    const trackEnds = [];
    allEffects
      .slice()
      .sort((a, b) => effectOutputStart(a) - effectOutputStart(b))
      .forEach(item => {
        const startAt = effectOutputStart(item);
        let track = trackEnds.findIndex(endAt => endAt <= startAt + 0.001);
        if (track < 0) track = trackEnds.length;
        recoveredTracks.set(`${item.kind}:${item.id}`, Math.min(7, track));
        trackEnds[track] = startAt + Math.max(0.2, Number(item.duration || 2));
      });
  }
  const trackFor = (kind, item) => recoveredTracks.has(`${kind}:${item.id}`)
    ? recoveredTracks.get(`${kind}:${item.id}`)
    : Math.max(0, Number(item.track || 0));
  const maxZoomTrack = Math.max(0, ...(videoEdit.zoomKeyframes || []).map(item => trackFor('zoom', item)));
  const maxFootageTrack = Math.max(0, ...(videoEdit.footageOverlays || []).map(item => trackFor('footage', item)));
  const effectTracks = Math.max(storedTrackCount, maxZoomTrack + 1, maxFootageTrack + 1);
  return {
    ...videoEdit,
    version: 2,
    revision: Math.max(0, Math.floor(Number(videoEdit.revision || 0))),
    confirmation: {
      status: videoEdit.confirmation?.status === 'confirmed' ? 'confirmed' : 'pending',
      confirmedRevision: Number.isFinite(Number(videoEdit.confirmation?.confirmedRevision))
        ? Math.max(0, Math.floor(Number(videoEdit.confirmation.confirmedRevision)))
        : null,
      confirmedAt: Number.isFinite(Number(videoEdit.confirmation?.confirmedAt))
        ? Number(videoEdit.confirmation.confirmedAt)
        : null,
    },
    effectTracks,
    trimStart,
    trimEnd,
    clips:clips || (videoEdit.clips === null ? null : derivedClips),
    splits: [...new Set((videoEdit.splits || []).map(clampTime).filter(t => t > 0 && (!duration || t < duration)))]
      .sort((a, b) => a - b),
    freezeFrames: (videoEdit.freezeFrames || []).map((item, index) => ({
      id: stableVideoItemId('freeze', item, index),
      at: clampTime(item.at),
      duration: Math.max(0.2, Math.min(10, Number(item.duration || 2))),
      annotations: normalizeFreezeAnnotations(item.annotations || item.drawings),
    })).sort((a, b) => a.at - b.at),
    zoomKeyframes: (videoEdit.zoomKeyframes || []).map((item, index) => {
      const at = clampTime(item.at);
      const outputAt = Number.isFinite(Number(item.outputAt))
        ? clampOutputTime(Number(item.outputAt))
        : sourceToOutputTime(at);
      return {
        id: stableVideoItemId('zoom', item, index),
        at,
        outputAt,
        scale: Math.max(1, Math.min(EDITOR_MAX_ZOOM, Number(item.scale || 1.4))),
        scaleX: Math.max(1, Math.min(EDITOR_MAX_ZOOM, Number(item.scaleX ?? item.scale ?? 1.4))),
        scaleY: Math.max(1, Math.min(EDITOR_MAX_ZOOM, Number(item.scaleY ?? item.scale ?? 1.4))),
        posX: Math.max(-100, Math.min(100, Number(item.posX || 0))),
        posY: Math.max(-100, Math.min(100, Number(item.posY || 0))),
        rotation: Math.max(-45, Math.min(45, Number(item.rotation || 0))),
        anchorX: Math.max(0, Math.min(100, Number(item.anchorX ?? 50))),
        anchorY: Math.max(0, Math.min(100, Number(item.anchorY ?? 50))),
        duration: Math.max(0.2, Math.min(10, Number(item.duration || 2))),
        track: Math.max(0, Math.min(effectTracks - 1, trackFor('zoom', item))),
      };
    }).sort((a, b) => effectOutputStart(a) - effectOutputStart(b)),
    footageOverlays: (videoEdit.footageOverlays || []).map((item, index) => {
      const legacyChroma = item.chromaKey || item.chroma || (videoEdit.chromaKey?.enabled ? videoEdit.chromaKey : {});
      const at = clampTime(item.at);
      const outputAt = Number.isFinite(Number(item.outputAt))
        ? clampOutputTime(Number(item.outputAt))
        : sourceToOutputTime(at);
      return {
        id: stableVideoItemId('footage', item, index),
        url: String(item.url || ''),
        name: String(item.name || 'Футаж').slice(0, 120),
        at,
        outputAt,
        duration: Math.max(0.2, Math.min(60, Number(item.duration || 2))),
        track: Math.max(0, Math.min(effectTracks - 1, trackFor('footage', item))),
        muted: item.muted !== false,
        posX: Math.max(0, Math.min(100, Number(item.posX ?? 50))),
        posY: Math.max(0, Math.min(100, Number(item.posY ?? 50))),
        scale: Math.max(0.05, Math.min(2, Number(item.scale ?? 0.35))),
        chromaKey: normalizeChromaKey(legacyChroma),
      };
    }).filter(item => item.url).sort((a, b) => effectOutputStart(a) - effectOutputStart(b)),
    audio: {
      muted: !!videoEdit.audio?.muted,
      volume: Math.max(0, Math.min(2, Number(videoEdit.audio?.volume ?? 1))),
    },
    chromaKey: normalizeChromaKey(videoEdit.chromaKey),
    projectV3: migrateVideoEditToProjectV3(videoEdit, duration),
  };
}

function editedOutputDuration() {
  return sharedOutputDuration(videoEdit, videoDuration());
}

function buildTimelineSegments() {
  return buildSharedTimelineSegments(videoEdit, videoDuration());
}

function sourceToOutputTime(sourceTime) {
  return sharedSourceToOutputTime(videoEdit, videoDuration(), sourceTime);
}

function currentOutputTime() {
  if (outputPlaybackTime !== null) {
    return Math.max(0, Math.min(editedOutputDuration(), outputPlaybackTime));
  }
  if (freezeHoldActive) {
    const elapsed = (performance.now() - freezeHoldActive.startedAt) / 1000;
    return freezeHoldActive.outputStart + Math.min(freezeHoldActive.duration, Math.max(0, elapsed));
  }
  if (timelinePreviewOutputTime !== null && vidPlayer.paused) {
    return Math.max(0, Math.min(editedOutputDuration(), timelinePreviewOutputTime));
  }
  return sourceToOutputTime(vidPlayer.currentTime || 0);
}

function outputToSourceTime(outputTime) {
  return sharedOutputToSourceTime(videoEdit, videoDuration(), outputTime);
}

function segmentForOutputTime(outputTime) {
  return sharedSegmentAt(videoEdit, videoDuration(), outputTime);
}

function captureCurrentVideoFrame() {
  if (!vidPlayer.videoWidth || !vidPlayer.videoHeight) return '';
  try {
    const canvas = document.createElement('canvas');
    const maxWidth = 960;
    const scale = Math.min(1, maxWidth / vidPlayer.videoWidth);
    canvas.width = Math.max(1, Math.round(vidPlayer.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(vidPlayer.videoHeight * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(vidPlayer, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch (error) {
    console.warn('Cannot capture freeze frame', error);
    return '';
  }
}

function selectedFreezeClip() {
  if (selectedEditorItem?.type !== 'freeze') return null;
  return (videoEdit.freezeFrames || []).find(item => item.id === selectedEditorItem.id) || null;
}

function withTimelineTransform(ctx, canvas, outputTime, draw) {
  const { clip: zoom, mix } = zoomPreviewStateAtOutput(outputTime);
  const scaleX = 1 + (Number(zoom?.scaleX ?? zoom?.scale ?? 1) - 1) * mix;
  const scaleY = 1 + (Number(zoom?.scaleY ?? zoom?.scale ?? 1) - 1) * mix;
  const scale = Math.max(scaleX, scaleY, 1);
  const anchorX = 50 + (Number(zoom?.anchorX ?? 50) - 50) * mix;
  const anchorY = 50 + (Number(zoom?.anchorY ?? 50) - 50) * mix;
  const targetX = anchorX / 100 * canvas.width;
  const targetY = anchorY / 100 * canvas.height;
  const maxPanX = canvas.width * (scale - 1) / (2 * scale);
  const maxPanY = canvas.height * (scale - 1) / (2 * scale);
  const panX = Math.max(-maxPanX, Math.min(maxPanX, canvas.width / 2 - targetX));
  const panY = Math.max(-maxPanY, Math.min(maxPanY, canvas.height / 2 - targetY));
  const offsetX = Number(zoom?.posX || 0) * mix * canvas.width / Math.max(1, editorEls.stage?.clientWidth || canvas.width);
  const offsetY = Number(zoom?.posY || 0) * mix * canvas.height / Math.max(1, editorEls.stage?.clientHeight || canvas.height);
  const rotation = Number(zoom?.rotation || 0) * mix * Math.PI / 180;
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.scale(scaleX, scaleY);
  ctx.translate(panX + offsetX, panY + offsetY);
  ctx.rotate(rotation);
  ctx.translate(-canvas.width / 2, -canvas.height / 2);
  draw(canvas.width, canvas.height);
  ctx.restore();
}

function captureEditedVideoFrameBlob() {
  const width = vidPlayer.videoWidth || 1920;
  const height = vidPlayer.videoHeight || 1080;
  if (!width || !height) return Promise.resolve(null);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  const outputTime = currentOutputTime();

  const freeze = (videoEdit.freezeFrames || []).find(item => item.id === freezeDrawingVisibleId) || null;
  const freezeImage = editorEls.freezeOverlay?.classList.contains('show') && editorEls.freezeOverlay.complete
    ? editorEls.freezeOverlay
    : null;
  withTimelineTransform(ctx, canvas, outputTime, (stageWidth, stageHeight) => {
    ctx.drawImage(freezeImage || vidPlayer, 0, 0, stageWidth, stageHeight);
  });

  const footage = activeFootageClipAtOutput(outputTime);
  if (footage?.url) {
    const chromaVisible = editorEls.footageCanvas?.classList.contains('show');
    const source = chromaVisible ? editorEls.footageCanvas : editorEls.footagePreview;
    const sourceWidth = source?.videoWidth || source?.width || 0;
    const sourceHeight = source?.videoHeight || source?.height || 0;
    if (source && sourceWidth && sourceHeight) {
      const overlayWidth = canvas.width * Math.max(0.05, Math.min(2, Number(footage.scale ?? 0.35)));
      const overlayHeight = overlayWidth * sourceHeight / sourceWidth;
      const centerX = canvas.width * Math.max(0, Math.min(100, Number(footage.posX ?? 50))) / 100;
      const centerY = canvas.height * Math.max(0, Math.min(100, Number(footage.posY ?? 50))) / 100;
      ctx.drawImage(source, centerX - overlayWidth / 2, centerY - overlayHeight / 2, overlayWidth, overlayHeight);
    }
  }

  if (freeze?.annotations?.length) {
    withTimelineTransform(ctx, canvas, outputTime, (stageWidth, stageHeight) => {
      drawFreezeAnnotations(ctx, freeze.annotations, stageWidth, stageHeight);
    });
  }
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
}

function resizeFreezeDrawingCanvas() {
  const canvas = editorEls.freezeDrawingCanvas;
  const rect = editorEls.stage?.getBoundingClientRect();
  if (!canvas || !rect?.width || !rect?.height) return false;
  const density = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const width = Math.max(1, Math.round(rect.width * density));
  const height = Math.max(1, Math.round(rect.height * density));
  if (canvas.width === width && canvas.height === height) return false;
  canvas.width = width;
  canvas.height = height;
  return true;
}

function renderFreezeDrawing() {
  const canvas = editorEls.freezeDrawingCanvas;
  if (!canvas) return;
  const resized = resizeFreezeDrawingCanvas();
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const freeze = (videoEdit.freezeFrames || []).find(item => item.id === freezeDrawingVisibleId) || null;
  const selected = selectedFreezeClip();
  const annotations = normalizeFreezeAnnotations(freeze?.annotations);
  const visible = !!freeze && (annotations.length > 0 || selected?.id === freeze.id);
  const interactive = visible && selected?.id === freeze.id && !outputPlaybackActive;
  canvas.classList.toggle('show', visible);
  canvas.classList.toggle('interactive', interactive);
  editorEls.freezeDrawingVector?.classList.toggle('show', visible);
  canvas.setAttribute('aria-hidden', String(!visible));
  const renderKey = visible ? `${freeze.id}|${canvas.width}x${canvas.height}|${JSON.stringify(annotations)}` : '';
  if (resized || renderKey !== freezeDrawingRenderKey) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (editorEls.freezeDrawingVector) editorEls.freezeDrawingVector.innerHTML = visible ? freezeAnnotationsSvg(annotations) : '';
    freezeDrawingRenderKey = renderKey;
  }
}

function syncFreezeDrawingPanel() {
  const freeze = selectedFreezeClip();
  const open = !!freeze;
  editorEls.freezeDrawingPanel?.classList.toggle('open', open);
  editorEls.freezeDrawingPanel?.setAttribute('aria-hidden', String(!open));
  const hasAnnotations = !!freeze?.annotations?.length;
  if (editorEls.freezeDrawingUndo) editorEls.freezeDrawingUndo.disabled = !hasAnnotations;
  if (editorEls.freezeDrawingClear) editorEls.freezeDrawingClear.disabled = !hasAnnotations;
  document.querySelectorAll('[data-freeze-draw-tool]').forEach(button => {
    const active = button.dataset.freezeDrawTool === freezeDrawingTool;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  document.querySelectorAll('[data-freeze-draw-color]').forEach(button => {
    const active = button.dataset.freezeDrawColor === freezeDrawingColor;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  document.querySelectorAll('[data-freeze-draw-width]').forEach(button => {
    const active = Math.abs(Number(button.dataset.freezeDrawWidth) - freezeDrawingWidth) < 0.0001;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  renderFreezeDrawing();
}

function setFreezeOverlay(src, freezeId = '') {
  if (!editorEls.freezeOverlay) return;
  freezeDrawingVisibleId = freezeId || '';
  if (src) {
    if (editorEls.freezeOverlay.src !== src) editorEls.freezeOverlay.src = src;
    editorEls.freezeOverlay.classList.add('show');
  } else {
    editorEls.freezeOverlay.classList.remove('show');
    editorEls.freezeOverlay.removeAttribute('src');
  }
  renderFreezeDrawing();
}

function previewFreezeForDrawing(freezeId) {
  const freeze = (videoEdit.freezeFrames || []).find(item => item.id === freezeId);
  if (!freeze) return;
  stopOutputPlayback({ keepPreview: false });
  clearFreezeHold();
  vidPlayer.pause();
  const segment = buildTimelineSegments().find(item => item.type === 'freeze' && item.id === freeze.id);
  timelinePreviewOutputTime = segment?.outputStart ?? sourceToOutputTime(freeze.at);
  if (Math.abs((vidPlayer.currentTime || 0) - freeze.at) > 0.02) vidPlayer.currentTime = freeze.at;
  setFreezeOverlay(freezeFrameImages.get(freeze.id) || '', freeze.id);
  updateTimelinePlaybackUi({ keepVisible: true });
  requestAnimationFrame(() => editorEls.freezeDrawingCanvas?.focus({ preventScroll: true }));
}

function reviveEditorVideo(reason = 'resume') {
  if (!videoUrl || !vidPlayer) return;
  const now = Date.now();
  if (now - lastVideoReviveAt < 1500) return;
  const wrap = document.getElementById('vid-player-wrap');
  if (wrap && wrap.style.display === 'none') return;
  const src = vidPlayer.currentSrc || vidPlayer.src || videoUrl;
  if (!src) return;
  const wasPaused = vidPlayer.paused;
  const current = Number.isFinite(vidPlayer.currentTime) ? vidPlayer.currentTime : 0;
  const hadError = !!vidPlayer.error;
  const lostSource = !vidPlayer.currentSrc && !vidPlayer.src;
  const stuckOverlay = !!editorEls.freezeOverlay?.classList.contains('show') && !outputPlaybackActive;
  const forceReload = reason === 'pageshow' || reason === 'stale-visible';
  if (!hadError && !lostSource && !stuckOverlay && !forceReload) return;
  lastVideoReviveAt = now;
  stopOutputPlayback({ keepPreview: false });
  clearFreezeHold();
  setFreezeOverlay('');
  if (vidPlayer.dataset.corsFallback === '1') vidPlayer.removeAttribute('crossorigin');
  else vidPlayer.crossOrigin = 'anonymous';
  vidPlayer.src = vidPlayer.dataset.corsFallback === '1' ? videoUrl : videoEditorSourceUrl(videoUrl);
  vidPlayer.load();
  const restoreTime = () => {
    if (Number.isFinite(current) && current > 0 && vidPlayer.duration) {
      vidPlayer.currentTime = Math.min(current, vidPlayer.duration - 0.05);
    }
    renderVideoEditor();
    if (!wasPaused) safePlay(vidPlayer);
  };
  vidPlayer.addEventListener('loadedmetadata', restoreTime, { once: true });
  setTimeout(restoreTime, 250);
}

function selectedZoomClip() {
  if (selectedEditorItem?.type !== 'zoom') return null;
  return (videoEdit.zoomKeyframes || []).find(item => item.id === selectedEditorItem.id) || null;
}

function selectedFootageClip() {
  if (selectedEditorItem?.type !== 'footage') return null;
  return (videoEdit.footageOverlays || []).find(item => item.id === selectedEditorItem.id) || null;
}

function activeZoomClipAt(time) {
  return (videoEdit.zoomKeyframes || [])
    .slice()
    .reverse()
    .find(item => time >= item.at && time <= item.at + Number(item.duration || 2)) || null;
}

function activeZoomClipAtOutput(outputTime) {
  return (videoEdit.zoomKeyframes || [])
    .slice()
    .reverse()
    .find(item => {
      const start = effectOutputStart(item);
      return outputTime >= start && outputTime <= start + Number(item.duration || 2);
    }) || null;
}

function zoomPreviewStateAtOutput(outputTime) {
  return sharedZoomStateAt(videoEdit, videoDuration(), outputTime);
}

function activeFootageClipAtOutput(outputTime) {
  return sharedActiveFootageAt(videoEdit, videoDuration(), outputTime);
}

function hexToRgb(hex) {
  const value = String(hex || '#00ff00').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(value)) return { r: 0, g: 255, b: 0 };
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function stopChromaPreview() {
  const canvas = editorEls.footageCanvas;
  const wasActive = !!chromaRenderRaf || !!chromaRenderFootageId || !!chromaRenderSignature || !!canvas?.classList.contains('show');
  if (chromaRenderRaf) {
    cancelAnimationFrame(chromaRenderRaf);
    chromaRenderRaf = null;
  }
  chromaRenderFootageId = null;
  chromaRenderSignature = '';
  chromaRenderLastAt = 0;
  chromaRenderLastVideoTime = -1;
  canvas?.classList.remove('show');
  if (!wasActive || !canvas) return;
  const ctx = canvas.getContext?.('2d', { willReadFrequently: true });
  if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function releaseFootagePreviewResources({ releaseCanvas = false } = {}) {
  const preview = editorEls.footagePreview;
  const canvas = editorEls.footageCanvas;
  const hadPreviewState = !!chromaRenderRaf || !!chromaRenderFootageId || !!chromaRenderSignature ||
    !!preview?.dataset.url || !!preview?.getAttribute('src') || !!preview?.currentSrc ||
    !!preview?.classList.contains('show') || !!preview?.classList.contains('processing-chroma') ||
    !!canvas?.classList.contains('show') || !!editorEls.footageFrame?.classList.contains('show');
  if (!hadPreviewState && !releaseCanvas) return;
  stopChromaPreview();
  if (preview) {
    const hadSource = !!preview.dataset.url || !!preview.getAttribute('src') || !!preview.currentSrc;
    if (!preview.paused) preview.pause();
    if (hadSource) {
      preview.removeAttribute('src');
      preview.load();
    }
    delete preview.dataset.url;
    preview.classList.remove('show', 'processing-chroma', 'interactive');
  }
  canvas?.classList.remove('show', 'interactive');
  editorEls.footageFrame?.classList.remove('show');
  if (releaseCanvas && canvas && (canvas.width > 1 || canvas.height > 1)) {
    canvas.width = 1;
    canvas.height = 1;
  }
}

function startChromaPreview(footage) {
  if (!footage?.id || !footage?.chromaKey?.enabled) {
    stopChromaPreview();
    return;
  }
  const chroma = normalizeChromaKey(footage.chromaKey);
  const signature = `${footage.id}|${chroma.color}|${chroma.strength}`;
  if (chromaRenderFootageId === footage.id && chromaRenderSignature === signature) {
    const videoTime = Number(editorEls.footagePreview?.currentTime || 0);
    const alreadyRendered = editorEls.footageCanvas?.classList.contains('show') &&
      Math.abs(chromaRenderLastVideoTime - videoTime) < 0.01;
    if (chromaRenderRaf || (editorEls.footagePreview?.paused && alreadyRendered)) return;
    chromaRenderRaf = requestAnimationFrame(now => renderChromaPreviewFrame(footage, now));
    return;
  }
  stopChromaPreview();
  chromaRenderFootageId = footage.id;
  chromaRenderSignature = signature;
  chromaRenderRaf = requestAnimationFrame(now => renderChromaPreviewFrame(footage, now));
}

function renderChromaPreviewFrame(footage, now = performance.now()) {
  chromaRenderRaf = null;
  const video = editorEls.footagePreview;
  const canvas = editorEls.footageCanvas;
  if (!video || !canvas || !footage?.chromaKey?.enabled) {
    stopChromaPreview();
    return;
  }
  const chroma = normalizeChromaKey(footage.chromaKey);
  const signature = `${footage.id}|${chroma.color}|${chroma.strength}`;
  if (chromaRenderFootageId !== footage.id || chromaRenderSignature !== signature) return;
  const vw = video.videoWidth || 0;
  const vh = video.videoHeight || 0;
  if (!vw || !vh) {
    return;
  }
  const scheduleNextFrame = () => {
    if (document.visibilityState === 'visible' && !video.paused && !video.ended && !chromaRenderRaf) {
      chromaRenderRaf = requestAnimationFrame(nextNow => renderChromaPreviewFrame(footage, nextNow));
    }
  };
  if (chromaRenderLastAt && now - chromaRenderLastAt < CHROMA_PREVIEW_FRAME_INTERVAL_MS) {
    scheduleNextFrame();
    return;
  }
  chromaRenderLastAt = now;
  const previewScale = Math.min(1, CHROMA_PREVIEW_MAX_WIDTH / vw, CHROMA_PREVIEW_MAX_HEIGHT / vh);
  const previewWidth = Math.max(1, Math.round(vw * previewScale));
  const previewHeight = Math.max(1, Math.round(vh * previewScale));
  if (canvas.width !== previewWidth || canvas.height !== previewHeight) {
    canvas.width = previewWidth;
    canvas.height = previewHeight;
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  try {
    ctx.clearRect(0, 0, previewWidth, previewHeight);
    ctx.drawImage(video, 0, 0, previewWidth, previewHeight);
    const frame = ctx.getImageData(0, 0, previewWidth, previewHeight);
    const data = frame.data;
    const key = hexToRgb(chroma.color);
    const strength = chroma.strength;
    const tolerance = 18 + strength * 160;
    const feather = 18 + strength * 54;
    const despill = Math.min(1, 0.25 + strength * 0.75);
    for (let i = 0; i < data.length; i += 4) {
      const maxChannel = Math.max(data[i], data[i + 1], data[i + 2]);
      const minChannel = Math.min(data[i], data[i + 1], data[i + 2]);
      const luma = data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
      const neutralDark = maxChannel - minChannel <= 18;
      if (neutralDark && luma <= 18) {
        data[i + 3] = 0;
        continue;
      }
      if (neutralDark && luma <= 38) {
        data[i + 3] = Math.round(data[i + 3] * ((luma - 18) / 20));
      }
      const dr = data[i] - key.r;
      const dg = data[i + 1] - key.g;
      const db = data[i + 2] - key.b;
      const distance = Math.sqrt(dr * dr + dg * dg + db * db);
      if (distance <= tolerance) {
        data[i + 3] = 0;
      } else if (distance <= tolerance + feather) {
        data[i + 3] = Math.round(data[i + 3] * ((distance - tolerance) / feather));
      }
      if (key.g >= key.r && key.g >= key.b && data[i + 1] > data[i] && data[i + 1] > data[i + 2]) {
        data[i + 1] = Math.round(data[i + 1] - Math.max(0, data[i + 1] - Math.max(data[i], data[i + 2])) * despill);
      }
    }
    ctx.putImageData(frame, 0, 0);
    canvas.classList.add('show');
    chromaRenderLastVideoTime = Number(video.currentTime || 0);
    chromaRenderErrorShown = false;
  } catch (error) {
    stopChromaPreview();
    if (!chromaRenderErrorShown) {
      chromaRenderErrorShown = true;
      console.warn('chroma preview failed', error);
      toast('Не удалось применить хромакей в предпросмотре: браузер запретил читать пиксели футажа', 'w');
    }
    return;
  }
  scheduleNextFrame();
}

function syncFootageChromaPanel() {
  const footage = selectedFootageClip();
  const chroma = normalizeChromaKey(footage?.chromaKey || {});
  const disabled = !footage;
  if (editorEls.chromaTarget) {
    editorEls.chromaTarget.textContent = footage
      ? `Хромакей привязан к футажу: ${footage.name || 'Футаж'}`
      : 'Выбери футаж на таймлайне, чтобы включить хромакей';
    editorEls.chromaTarget.classList.toggle('active', !!footage);
  }
  if (editorEls.chromaEnabled) {
    editorEls.chromaEnabled.checked = !!footage && chroma.enabled;
    editorEls.chromaEnabled.disabled = disabled;
  }
  if (editorEls.chromaColor) {
    editorEls.chromaColor.value = chroma.color;
    editorEls.chromaColor.disabled = disabled;
  }
  if (editorEls.chromaStrength) {
    editorEls.chromaStrength.value = String(chroma.strength);
    editorEls.chromaStrength.disabled = disabled;
  }
  if (editorEls.footageScale) {
    editorEls.footageScale.value = String(Math.max(0.05, Math.min(2, Number(footage?.scale ?? 0.35))));
    editorEls.footageScale.disabled = disabled;
  }
}

function applyFootageOverlayTransform(footage) {
  const scale = Math.max(0.05, Math.min(2, Number(footage?.scale ?? 0.35)));
  const left = Math.max(0, Math.min(100, Number(footage?.posX ?? 50)));
  const top = Math.max(0, Math.min(100, Number(footage?.posY ?? 50)));
  const width = `${Math.round(scale * 10000) / 100}%`;
  const videoAspect = editorEls.footagePreview?.videoWidth && editorEls.footagePreview?.videoHeight
    ? `${editorEls.footagePreview.videoWidth} / ${editorEls.footagePreview.videoHeight}`
    : '1 / 1';
  [editorEls.footagePreview, editorEls.footageCanvas, editorEls.footageFrame].forEach(el => {
    if (!el) return;
    el.style.left = `${left}%`;
    el.style.top = `${top}%`;
    el.style.width = width;
    if (el === editorEls.footageFrame) el.style.aspectRatio = videoAspect;
    el.style.transform = 'translate(-50%, -50%)';
  });
}

function updateSelectedFootageTransform(patch, { persist = true } = {}) {
  const footage = selectedFootageClip();
  if (!footage) {
    toast('Сначала выбери футаж на таймлайне', 'i');
    syncFootageChromaPanel();
    return null;
  }
  if (patch.posX !== undefined) footage.posX = Math.max(0, Math.min(100, Number(patch.posX ?? footage.posX ?? 50)));
  if (patch.posY !== undefined) footage.posY = Math.max(0, Math.min(100, Number(patch.posY ?? footage.posY ?? 50)));
  if (patch.scale !== undefined) footage.scale = Math.max(0.05, Math.min(2, Number(patch.scale ?? footage.scale ?? 0.35)));
  applyFootageOverlayTransform(footage);
  syncFootageChromaPanel();
  if (persist) saveVideoEdit();
  return footage;
}

function syncZoomTransformPanel() {
  const zoom = selectedZoomClip() || activeZoomClipAtOutput(currentOutputTime());
  const scaleX = Number(zoom?.scaleX ?? zoom?.scale ?? editorEls.zoomScaleX?.value ?? 1.4);
  const scaleY = Number(zoom?.scaleY ?? zoom?.scale ?? editorEls.zoomScaleY?.value ?? 1.4);
  const posX = Number(zoom?.posX ?? editorEls.zoomPosX?.value ?? 0);
  const posY = Number(zoom?.posY ?? editorEls.zoomPosY?.value ?? 0);
  const rotation = Number(zoom?.rotation ?? editorEls.zoomRotation?.value ?? 0);
  const anchorX = Number(zoom?.anchorX ?? editorEls.zoomAnchorX?.value ?? 50);
  const anchorY = Number(zoom?.anchorY ?? editorEls.zoomAnchorY?.value ?? 50);
  if (editorEls.zoomScaleX) editorEls.zoomScaleX.value = scaleX.toFixed(2);
  if (editorEls.zoomScaleY) editorEls.zoomScaleY.value = scaleY.toFixed(2);
  if (editorEls.zoomPosX) editorEls.zoomPosX.value = posX.toFixed(0);
  if (editorEls.zoomPosY) editorEls.zoomPosY.value = posY.toFixed(0);
  if (editorEls.zoomRotation) editorEls.zoomRotation.value = rotation.toFixed(0);
  if (editorEls.zoomRotationRange) editorEls.zoomRotationRange.value = rotation.toFixed(0);
  if (editorEls.zoomAnchorX) editorEls.zoomAnchorX.value = anchorX.toFixed(0);
  if (editorEls.zoomAnchorY) editorEls.zoomAnchorY.value = anchorY.toFixed(0);
  if (editorEls.zoomValue) editorEls.zoomValue.textContent = `${scaleX.toFixed(2)}x / ${scaleY.toFixed(2)}x`;
}

function updateSelectedZoomTransform(patch) {
  const zoom = selectedZoomClip();
  if (!zoom) return;
  Object.assign(zoom, patch);
  zoom.scale = Math.max(Number(zoom.scaleX || 1), Number(zoom.scaleY || 1));
  saveVideoEdit();
}

function zoomPanForAnchor(anchorX, anchorY, scale) {
  const rect = editorEls.stage?.getBoundingClientRect();
  const width = rect?.width || 0;
  const height = rect?.height || 0;
  const safeScale = Math.max(1, Number(scale || 1));
  if (!width || !height || safeScale <= 1) return { x: 0, y: 0 };
  const targetX = (anchorX / 100) * width;
  const targetY = (anchorY / 100) * height;
  const rawX = width / 2 - targetX;
  const rawY = height / 2 - targetY;
  const maxX = (width * (safeScale - 1)) / (2 * safeScale);
  const maxY = (height * (safeScale - 1)) / (2 * safeScale);
  return {
    x: Math.max(-maxX, Math.min(maxX, rawX)),
    y: Math.max(-maxY, Math.min(maxY, rawY)),
  };
}

function updateZoomAreaFromPoint(clientX, clientY) {
  let zoom = selectedZoomClip() || activeZoomClipAt(vidPlayer.currentTime || 0);
  if (!zoom) {
    addZoomAt(vidPlayer.currentTime || 0, { silent: true });
    zoom = selectedZoomClip();
  } else {
    selectedEditorItem = { type: 'zoom', id: zoom.id };
    setEditorMode('zoom');
  }
  if (!zoom || !editorEls.stage) return;
  const rect = editorEls.stage.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const anchorX = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
  const anchorY = Math.max(0, Math.min(100, ((clientY - rect.top) / rect.height) * 100));
  updateSelectedZoomTransform({
    anchorX,
    anchorY,
    posX: 0,
    posY: 0,
  });
  syncZoomTransformPanel();
  applyVideoEditPreview();
}

function stopOutputPlayback({ keepPreview = true } = {}) {
  if (outputPlaybackRaf) {
    cancelAnimationFrame(outputPlaybackRaf);
    outputPlaybackRaf = null;
  }
  stopSmoothTimelineUi();
  const currentOut = outputPlaybackTime;
  outputPlaybackActive = false;
  outputPlaybackStartedAt = 0;
  outputPlaybackStartTime = 0;
  outputPlaybackTime = null;
  if (keepPreview && currentOut !== null) timelinePreviewOutputTime = currentOut;
  if (!keepPreview) editorEls.stage?.classList.remove('timeline-gap');
  setFreezeOverlay('');
  if (!vidPlayer.paused) vidPlayer.pause();
  if (vidPlayBtn) vidPlayBtn.textContent = '▶';
  if (fullscreenVidPlayBtn) fullscreenVidPlayBtn.textContent = '▶';
  updateTimelinePlaybackUi({ keepVisible: true });
}

function showOutputFrame(outputTime) {
  const total = editedOutputDuration();
  const out = Math.max(0, Math.min(total, Number(outputTime || 0)));
  const segment = segmentForOutputTime(out);
  if (!segment) return;
  outputPlaybackTime = out;
  editorEls.stage?.classList.toggle('timeline-gap', segment.type === 'gap');
  if (segment.type === 'gap') {
    if (!vidPlayer.paused) vidPlayer.pause();
    setFreezeOverlay('');
  } else if (segment.type === 'freeze') {
    if (!vidPlayer.paused) vidPlayer.pause();
    if (Math.abs((vidPlayer.currentTime || 0) - segment.sourceAt) > 0.03) {
      vidPlayer.currentTime = segment.sourceAt;
    }
    setFreezeOverlay(freezeFrameImages.get(segment.id) || '', segment.id);
  } else {
    setFreezeOverlay('');
    const local = Math.max(0, Math.min(segment.duration, out - segment.outputStart));
    const sourceTime = segment.sourceStart + local;
    if (Math.abs((vidPlayer.currentTime || 0) - sourceTime) > 0.12) {
      vidPlayer.currentTime = sourceTime;
    }
    if (vidPlayer.paused && outputPlaybackActive) safePlay(vidPlayer);
  }
  updateTimelinePlaybackUi({ keepVisible: true });
}

function tickOutputPlayback() {
  if (!outputPlaybackActive) return;
  const total = editedOutputDuration();
  const playback = sharedPlaybackPosition(outputPlaybackStartTime, performance.now() - outputPlaybackStartedAt, total);
  if (playback.ended) {
    showOutputFrame(total);
    stopOutputPlayback({ keepPreview: true });
    return;
  }
  showOutputFrame(playback.outputTime);
  outputPlaybackRaf = requestAnimationFrame(tickOutputPlayback);
}

function startOutputPlayback(startOutput = null) {
  if (!videoDuration()) return;
  // Capture the requested playhead before clearing preview state. During a
  // scrub the native video seek may still be pending, while the timeline
  // preview already contains the exact position selected by the user.
  const nextOutputTime = startOutput === null
    ? (outputPlaybackTime ?? currentOutputTime())
    : Math.max(0, Math.min(editedOutputDuration(), startOutput));
  clearFreezeHold();
  playedFreezeHolds.clear();
  timelinePreviewOutputTime = null;
  if (!(videoEdit.freezeFrames || []).length) {
    if (outputPlaybackRaf) cancelAnimationFrame(outputPlaybackRaf);
    outputPlaybackRaf = null;
    outputPlaybackActive = false;
    outputPlaybackTime = null;
    const sourceTime = outputToSourceTime(nextOutputTime);
    if (Math.abs((vidPlayer.currentTime || 0) - sourceTime) > 0.03) {
      vidPlayer.currentTime = sourceTime;
    }
    setFreezeOverlay('');
    safePlay(vidPlayer);
    return;
  }
  outputPlaybackStartTime = nextOutputTime;
  outputPlaybackStartedAt = performance.now();
  outputPlaybackActive = true;
  if (vidPlayBtn) vidPlayBtn.textContent = '⏸';
  if (fullscreenVidPlayBtn) fullscreenVidPlayBtn.textContent = '⏸';
  showOutputFrame(outputPlaybackStartTime);
  outputPlaybackRaf = requestAnimationFrame(tickOutputPlayback);
}

function toggleEditorPlayback() {
  if (outputPlaybackActive) {
    stopOutputPlayback({ keepPreview: true });
    return;
  }
  if (!vidPlayer.paused) {
    vidPlayer.pause();
    timelinePreviewOutputTime = sourceToOutputTime(vidPlayer.currentTime || 0);
    updateTimelinePlaybackUi({ keepVisible: true });
    return;
  }
  startOutputPlayback(currentOutputTime());
}

function stepEditorFrame(direction) {
  if (!hasVideoForHotkeys()) return false;
  stopOutputPlayback({ keepPreview: true });
  const total = editedOutputDuration() || videoDuration();
  if (!total) return false;
  const next = Math.max(0, Math.min(total, currentOutputTime() + direction * frameStep()));
  showOutputFrame(next);
  timelinePreviewOutputTime = next;
  keepTimelinePlayheadVisible(timelineX(next));
  renderVideoEditor();
  return true;
}

function renderVideoTransport() {
  if (scrubberDragging) return;
  const editorExpanded = editorEls.toggle?.getAttribute('aria-expanded') !== 'false';
  const duration = editorExpanded ? editedOutputDuration() : videoDuration();
  const current = editorExpanded ? currentOutputTime() : vidPlayer.currentTime;
  if (vidScrubber && duration) {
    vidScrubber.value = String(sharedOutputToScrubberValue(current, Number(vidScrubber.max || 100), duration));
    vidScrubber.style.setProperty('--uvp-progress', `${Math.max(0, Math.min(100, current / duration * 100))}%`);
  }
  if (vidTimeEl) vidTimeEl.textContent = fmtTime(current) + ' / ' + fmtTime(duration);
  if (fullscreenVidScrubber && duration) fullscreenVidScrubber.value = String(sharedOutputToScrubberValue(current, Number(fullscreenVidScrubber.max || 100), duration));
  if (fullscreenVidTimeEl) fullscreenVidTimeEl.textContent = fmtTime(current) + ' / ' + fmtTime(duration);
}

function updateTimelinePlaybackUi({ keepVisible = false } = {}) {
  const currentX = timelineX(currentOutputTime());
  if (editorEls.playhead) editorEls.playhead.style.left = `${currentX}px`;
  if (keepVisible) keepTimelinePlayheadVisible(currentX);
  renderVideoTransport();
  applyVideoEditPreview();
}

function startSmoothTimelineUi() {
  if (timelineSmoothRaf) return;
  const tick = now => {
    timelineSmoothRaf = null;
    if (outputPlaybackActive || (vidPlayer.paused && !timelineDrag)) return;
    if (!timelineSmoothLastAt || now - timelineSmoothLastAt >= TIMELINE_UI_FRAME_INTERVAL_MS || timelineDrag) {
      timelineSmoothLastAt = now;
      updateTimelinePlaybackUi({ keepVisible: !vidPlayer.paused });
    }
    timelineSmoothRaf = requestAnimationFrame(tick);
  };
  timelineSmoothRaf = requestAnimationFrame(tick);
}

function stopSmoothTimelineUi() {
  if (timelineSmoothRaf) cancelAnimationFrame(timelineSmoothRaf);
  timelineSmoothRaf = null;
  timelineSmoothLastAt = 0;
}

function renderEditorInspectorSelection() {
  let title = 'Весь ролик';
  let badge = 'Видео';
  let name = 'Ничего не выбрано';
  let detail = 'Выбери клип или эффект на таймлайне, чтобы изменить его параметры.';
  let properties = '';
  const selected = selectedEditorItem;
  if (selected?.type === 'clip') {
    const clips = videoEdit.clips || [];
    const index = clips.findIndex(clip => clip.id === selected.id);
    const clip = clips[index];
    if (clip) {
      title = `Клип ${index + 1}`;
      badge = 'Клип';
      name = `${fmtTime(clip.sourceStart)} — ${fmtTime(clip.sourceEnd)}`;
      detail = `Длительность ${fmtTime(clip.sourceEnd - clip.sourceStart)} · можно переставить или удалить со сдвигом.`;
      properties = `
        <label class="inspector-property">Начало в исходнике<input type="number" step="0.1" min="0" data-inspector-field="sourceStart" value="${Number(clip.sourceStart).toFixed(1)}"></label>
        <label class="inspector-property">Конец в исходнике<input type="number" step="0.1" min="0" data-inspector-field="sourceEnd" value="${Number(clip.sourceEnd).toFixed(1)}"></label>
        <div class="inspector-properties-actions"><button class="btn-sm" type="button" data-inspector-action="seek">Показать клип</button></div>`;
    }
  } else if (selected?.type === 'freeze') {
    const freeze = (videoEdit.freezeFrames || []).find(item => item.id === selected.id);
    if (freeze) {
      title = 'Стоп-кадр';
      badge = 'Кадр';
      name = `На ${fmtTime(freeze.at)} · ${fmtTime(freeze.duration)}`;
      detail = freeze.annotations?.length ? `Рисунок сохранён · штрихов: ${freeze.annotations.length}` : 'Можно изменить длительность или нарисовать подсказку поверх кадра.';
      properties = `
        <label class="inspector-property">Длительность<input type="number" step="0.1" min="0.2" max="10" data-inspector-field="duration" value="${Number(freeze.duration).toFixed(1)}"></label>
        <div class="inspector-properties-actions"><button class="btn-sm" type="button" data-inspector-action="seek">Показать кадр</button></div>`;
    }
  } else if (selected?.type === 'zoom') {
    const zoom = (videoEdit.zoomKeyframes || []).find(item => item.id === selected.id);
    if (zoom) {
      title = 'Приближение';
      badge = 'Zoom';
      name = `${Number(zoom.scaleX ?? zoom.scale ?? 1.4).toFixed(2)}× · ${fmtTime(effectOutputStart(zoom))}`;
      detail = `Длительность ${fmtTime(Math.max(0.1, Number(zoom.duration || 1)))} · дорожка ${Number(zoom.track || 0) + 1}.`;
      properties = `
        <label class="inspector-property">Начало на таймлайне<input type="number" step="0.1" min="0" data-inspector-field="outputAt" value="${effectOutputStart(zoom).toFixed(1)}"></label>
        <label class="inspector-property">Длительность<input type="number" step="0.1" min="0.1" max="60" data-inspector-field="duration" value="${Number(zoom.duration || 1).toFixed(1)}"></label>
        <div class="inspector-properties-actions"><button class="btn-sm" type="button" data-inspector-action="seek">Показать эффект</button></div>`;
    }
  } else if (selected?.type === 'footage') {
    const footage = (videoEdit.footageOverlays || []).find(item => item.id === selected.id);
    if (footage) {
      title = 'Футаж';
      badge = footage.chroma?.enabled ? 'Chroma' : 'Overlay';
      name = footage.name || 'Видео-наложение';
      detail = `${fmtTime(effectOutputStart(footage))} · ${fmtTime(Math.max(0.1, Number(footage.duration || 2)))} · дорожка ${Number(footage.track || 0) + 1}.`;
      properties = `
        <label class="inspector-property">Начало на таймлайне<input type="number" step="0.1" min="0" data-inspector-field="outputAt" value="${effectOutputStart(footage).toFixed(1)}"></label>
        <label class="inspector-property">Длительность<input type="number" step="0.1" min="0.2" max="60" data-inspector-field="duration" value="${Number(footage.duration || 2).toFixed(1)}"></label>
        <div class="inspector-properties-actions"><button class="btn-sm" type="button" data-inspector-action="seek">Показать футаж</button></div>`;
    }
  } else if (selected?.type === 'effectTrack') {
    title = `Дорожка ${Number(selected.track || 0) + 1}`;
    badge = 'Эффекты';
    name = 'Дорожка эффектов';
    detail = 'Новые эффекты будут добавляться на выбранную дорожку.';
  } else if (selected?.type === 'split') {
    title = 'Точка разреза';
    badge = 'Разрез';
    name = fmtTime(selected.at);
    detail = 'Старый маркер разреза. Его можно удалить или превратить в реальные клипы новым разрезом.';
  }
  if (editorEls.inspectorTitle) editorEls.inspectorTitle.textContent = title;
  if (editorEls.inspectorBadge) editorEls.inspectorBadge.textContent = badge;
  if (editorEls.inspectorSelection) {
    editorEls.inspectorSelection.innerHTML = `<strong>${esc(name)}</strong><span>${esc(detail)}</span>`;
  }
  if (editorEls.inspectorProperties) {
    editorEls.inspectorProperties.hidden = !properties;
    editorEls.inspectorProperties.innerHTML = properties;
  }
}

function selectedInspectorTarget() {
  const selected = selectedEditorItem;
  if (!selected) return null;
  if (selected.type === 'clip') return (videoEdit.clips || []).find(item => item.id === selected.id) || null;
  if (selected.type === 'freeze') return (videoEdit.freezeFrames || []).find(item => item.id === selected.id) || null;
  if (selected.type === 'zoom') return (videoEdit.zoomKeyframes || []).find(item => item.id === selected.id) || null;
  if (selected.type === 'footage') return (videoEdit.footageOverlays || []).find(item => item.id === selected.id) || null;
  return null;
}

function selectedInspectorOutputStart() {
  const target = selectedInspectorTarget();
  if (!target) return 0;
  if (selectedEditorItem.type === 'clip') {
    return buildTimelineSegments().find(segment => segment.clipId === target.id)?.outputStart || 0;
  }
  if (selectedEditorItem.type === 'freeze') {
    return buildTimelineSegments().find(segment => segment.type === 'freeze' && segment.id === target.id)?.outputStart
      ?? sourceToOutputTime(target.at);
  }
  return effectOutputStart(target);
}

editorEls.inspectorProperties?.addEventListener('change', event => {
  const input = event.target.closest('[data-inspector-field]');
  const target = selectedInspectorTarget();
  if (!input || !target) return;
  const value = Number(input.value);
  if (!Number.isFinite(value)) { renderVideoEditor(); return; }
  const field = input.dataset.inspectorField;
  pushVideoEditUndo();
  if (selectedEditorItem.type === 'clip') {
    const duration = videoDuration();
    if (field === 'sourceStart') target.sourceStart = Math.max(0, Math.min(value, Number(target.sourceEnd) - 0.05, duration));
    if (field === 'sourceEnd') target.sourceEnd = Math.max(Number(target.sourceStart) + 0.05, Math.min(value, duration));
  } else if (field === 'duration') {
    const minimum = selectedEditorItem.type === 'freeze' || selectedEditorItem.type === 'footage' ? 0.2 : 0.1;
    target.duration = Math.max(minimum, Math.min(60, value));
  } else if (field === 'outputAt' && (selectedEditorItem.type === 'zoom' || selectedEditorItem.type === 'footage')) {
    target.outputAt = Math.max(0, Math.min(editedOutputDuration(), value));
  }
  saveVideoEdit({ skipUndo:true });
});

editorEls.inspectorProperties?.addEventListener('click', event => {
  const action = event.target.closest('[data-inspector-action]')?.dataset.inspectorAction;
  if (action !== 'seek' || !selectedInspectorTarget()) return;
  stopOutputPlayback({ keepPreview:false });
  const outputAt = selectedInspectorOutputStart();
  timelinePreviewOutputTime = outputAt;
  showOutputFrame(outputAt);
  keepTimelinePlayheadVisible(timelineX(outputAt));
  renderVideoEditor();
});

function renderVideoEditor() {
  if (editorEls.editor) {
    editorEls.editor.dataset.mode = activeEditorMode || 'trim';
    editorEls.editor.dataset.selection = selectedEditorItem?.type || 'none';
  }
  const duration = videoDuration();
  videoEdit = normalizedVideoEdit();
  const end = videoEdit.trimEnd || duration;
  const outputDuration = editedOutputDuration();
  const frameDuration = timelineFrameDuration();
  activeEffectTrack = Math.max(0, Math.min((videoEdit.effectTracks || 1) - 1, activeEffectTrack));
  renderEditorInspectorSelection();
  if (editorEls.shell && duration) {
    editorEls.shell.style.width = `${timelineWidthPx()}px`;
  }
  if (editorEls.trimStart) editorEls.trimStart.value = videoEdit.trimStart.toFixed(1);
  if (editorEls.trimEnd) editorEls.trimEnd.value = (end || 0).toFixed(1);
  if (editorEls.volume) editorEls.volume.value = String(videoEdit.audio.volume);
  if (editorEls.volumeLabel) editorEls.volumeLabel.textContent = `${Math.round(videoEdit.audio.volume * 100)}%`;
  if (editorEls.muted) editorEls.muted.checked = videoEdit.audio.muted;
  syncFootageChromaPanel();
  vidPlayer.muted = videoEdit.audio.muted;
  vidPlayer.volume = Math.max(0, Math.min(1, videoEdit.audio.volume));

  const pct = timelinePct;
  const currentX = timelineX(currentOutputTime());
  if (editorEls.playhead) editorEls.playhead.style.left = `${currentX}px`;
  if (outputPlaybackActive || (!vidPlayer.paused && !outputPlaybackActive) || timelineDrag?.kind === 'playhead') {
    keepTimelinePlayheadVisible(currentX);
  }
  if (editorEls.trimRange) {
    editorEls.trimRange.style.left = '0%';
    editorEls.trimRange.style.width = '100%';
    editorEls.trimRange.innerHTML = '<span class="trim-handle start" data-trim-handle="start"></span><span class="trim-handle end" data-trim-handle="end"></span>';
  }
  if (editorEls.markers) {
    const timelineSegments = buildTimelineSegments();
    const clipGroups = new Map();
    timelineSegments.forEach(segment => {
      if (!segment.clipId) return;
      const sourcePoint = segment.sourceStart ?? segment.sourceAt ?? 0;
      const group = clipGroups.get(segment.clipId) || { id:segment.clipId, start:segment.outputStart, end:segment.outputStart, sourceStart:sourcePoint, sourceEnd:sourcePoint };
      group.start = Math.min(group.start, segment.outputStart);
      group.end = Math.max(group.end, segment.outputStart + segment.duration);
      if (segment.type === 'video') {
        group.sourceStart = Math.min(group.sourceStart, segment.sourceStart);
        group.sourceEnd = Math.max(group.sourceEnd, segment.sourceEnd);
      }
      clipGroups.set(segment.clipId, group);
    });
    const clipHtml = [...clipGroups.values()].map((clip, index) => `
      <span class="timeline-video-clip ${selectedEditorItem?.type === 'clip' && selectedEditorItem.id === clip.id ? 'selected' : ''} ${timelineDrag?.kind === 'clip-reorder' && timelineDrag.id === clip.id ? 'moving' : ''}"
        data-clip-id="${esc(clip.id)}" style="${timelineBlockStyle(clip.start, clip.end - clip.start, 10)}"
        title="Клип ${index + 1}: ${fmtTime(clip.sourceStart)}-${fmtTime(clip.sourceEnd)}">
        ${selectedEditorItem?.type === 'clip' && selectedEditorItem.id === clip.id ? '<i class="clip-trim-handle start" data-clip-edge="start" aria-hidden="true"></i>' : ''}
        <b>${index + 1}</b>
        ${selectedEditorItem?.type === 'clip' && selectedEditorItem.id === clip.id ? '<i class="clip-trim-handle end" data-clip-edge="end" aria-hidden="true"></i>' : ''}
      </span>`).join('');
    const splitHtml = Array.isArray(videoEdit.clips) ? '' : videoEdit.splits.map(t => `<span class="timeline-marker split ${selectedEditorItem?.type === 'split' && Math.abs(selectedEditorItem.at - t) < 0.11 ? 'selected' : ''}" data-split-at="${t}" title="Разрез ${fmtTime(t)}" style="left:${pct(sourceToOutputTime(t))}%"></span>`).join('');
    const freezeHtml = videoEdit.freezeFrames.map(f => {
      const freezeSegment = buildTimelineSegments().find(segment => segment.type === 'freeze' && segment.id === f.id);
      const outputStart = freezeSegment?.outputStart ?? sourceToOutputTime(f.at);
      return `
      <span class="timeline-freeze-block ${selectedEditorItem?.type === 'freeze' && selectedEditorItem.id === f.id ? 'selected' : ''}"
        data-freeze-id="${esc(f.id)}"
        title="Стоп-кадр ${fmtTime(f.duration)} на ${fmtTime(f.at)}"
        style="${timelineBlockStyle(outputStart, f.duration)}">
        <span class="freeze-resize start" data-freeze-edge="start"></span>
        ${f.annotations?.length ? '<b class="freeze-drawn-mark" title="На кадре есть рисунок">✎</b>' : ''}+${Number(f.duration || 2).toFixed(1)}с
        <span class="freeze-resize end" data-freeze-edge="end"></span>
      </span>`;
    }).join('');
    editorEls.markers.innerHTML = clipHtml + splitHtml + freezeHtml;
  }
  if (editorEls.effectMarkers) {
    const trackCount = Math.max(1, Number(videoEdit.effectTracks || 1));
    const laneHeight = trackCount * EFFECT_TRACK_HEIGHT;
    if (editorEls.effectLane) {
      editorEls.effectLane.style.setProperty('--effect-lane-height', `${laneHeight}px`);
      editorEls.effectLane.style.height = `${laneHeight}px`;
    }
    const rowsHtml = Array.from({ length: trackCount }, (_, track) => `
      <div class="effect-track-row ${track === activeEffectTrack ? 'active' : ''} ${selectedEditorItem?.type === 'effectTrack' && selectedEditorItem.track === track ? 'selected' : ''}" data-effect-track="${track}" style="top:${track * EFFECT_TRACK_HEIGHT}px;">
        <span class="effect-track-label">Эффекты ${track + 1}</span>
      </div>`).join('');
    const zoomHtml = videoEdit.zoomKeyframes.map(z => `
      <span class="timeline-zoom-block ${selectedEditorItem?.type === 'zoom' && selectedEditorItem.id === z.id ? 'selected' : ''}"
        data-zoom-id="${esc(z.id)}"
        title="Зум ${Number(z.scale || 1).toFixed(1)}x, дорожка ${Number(z.track || 0) + 1}, ${fmtTime(z.duration)}"
        style="top:${Number(z.track || 0) * EFFECT_TRACK_HEIGHT + 6}px;bottom:auto;height:24px;${timelineBlockStyle(effectOutputStart(z), z.duration)}">
        <span class="zoom-resize start" data-zoom-edge="start"></span>
        ${Number(z.scale || 1).toFixed(1)}x
        <span class="zoom-resize end" data-zoom-edge="end"></span>
      </span>`).join('');
    const footageHtml = (videoEdit.footageOverlays || []).map(f => `
      <span class="timeline-footage-block ${selectedEditorItem?.type === 'footage' && selectedEditorItem.id === f.id ? 'selected' : ''} ${f.chromaKey?.enabled ? 'has-chroma' : ''}"
        data-footage-id="${esc(f.id)}"
        title="Футаж ${esc(f.name)} · дорожка ${Number(f.track || 0) + 1}, ${fmtTime(f.duration)}${f.chromaKey?.enabled ? ` · хромакей ${f.chromaKey.color || '#00ff00'}` : ''}"
        style="top:${Number(f.track || 0) * EFFECT_TRACK_HEIGHT + 6}px;bottom:auto;height:24px;${timelineBlockStyle(effectOutputStart(f), f.duration)}">
        <span class="footage-resize start" data-footage-edge="start"></span>
        ${esc(f.name || 'Футаж')}
        ${f.chromaKey?.enabled ? '<span class="footage-chroma-dot"></span>' : ''}
        <span class="footage-resize end" data-footage-edge="end"></span>
      </span>`).join('');
    editorEls.effectMarkers.innerHTML = rowsHtml + zoomHtml + footageHtml;
  }
  if (editorEls.timeLabel) editorEls.timeLabel.textContent = `${fmtTime(vidPlayer.currentTime || 0)} / ${fmtTime(duration)} · итог ${fmtTime(outputDuration)} · каркас ${fmtTime(frameDuration)}`;
  renderVideoTransport();
  const selectedClipIndex = selectedEditorItem?.type === 'clip'
    ? (videoEdit.clips || []).findIndex(clip => clip.id === selectedEditorItem.id)
    : -1;
  const clipLeft = document.getElementById('edit-clip-left');
  const clipRight = document.getElementById('edit-clip-right');
  if (clipLeft) clipLeft.disabled = selectedClipIndex <= 0;
  if (clipRight) clipRight.disabled = selectedClipIndex < 0 || selectedClipIndex >= (videoEdit.clips || []).length - 1;
  syncZoomTransformPanel();
  applyVideoEditPreview();
  syncFreezeDrawingPanel();
  if (editorEls.summary) {
    const parts = [];
    if (videoEdit.trimStart > 0 || (duration && end < duration)) parts.push(`обрезка ${fmtTime(videoEdit.trimStart)}-${fmtTime(end)}`);
    if (videoEdit.splits.length) parts.push(`разрезов: ${videoEdit.splits.length}`);
    if (videoEdit.freezeFrames.length) parts.push(`стоп-кадров: ${videoEdit.freezeFrames.length} (+${fmtTime(videoEdit.freezeFrames.reduce((s, f) => s + Number(f.duration || 2), 0))})`);
    if (videoEdit.zoomKeyframes.length) parts.push(`зумов: ${videoEdit.zoomKeyframes.length}`);
    if (videoEdit.footageOverlays.length) parts.push(`футажей: ${videoEdit.footageOverlays.length}`);
    if (videoEdit.audio.muted) parts.push('звук выключен');
    const chromaCount = videoEdit.footageOverlays.filter(item => item.chromaKey?.enabled).length;
    if (chromaCount) parts.push(`хромакей: ${chromaCount}`);
    if (parts.length) parts.push(`итог: ${fmtTime(editedOutputDuration())}`);
    editorEls.summary.textContent = parts.length ? parts.join(' · ') : 'Видео без правок';
  }
  renderVideoEditConfirmation();
}

function setEditorMode(mode) {
  activeEditorMode = mode || 'trim';
  if (editorEls.editor) editorEls.editor.dataset.mode = activeEditorMode;
  document.querySelectorAll('[data-editor-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.editorMode === activeEditorMode);
  });
  editorEls.effectsPanel?.classList.toggle('open', activeEditorMode === 'effects');
  editorEls.zoomPanel?.classList.toggle('open', activeEditorMode === 'zoom');
  if (activeEditorMode !== 'effects' && editorEls.footageLibrary) editorEls.footageLibrary.hidden = true;
  const hints = {
    trim: 'Клик или drag по таймлайну перематывает. Для обрезки тяни белые края зелёного отрезка или меняй поля старт/конец.',
    split: 'Кликни по нужному месту видео — клип разрежется сразу. Кнопка “Разрезать тут” режет по красному курсору.',
    freeze: 'Добавь стоп-кадр, затем рисуй кистью или прямыми линиями по кадру. Фиолетовый клип можно двигать, тянуть за край и удалить.',
    zoom: 'Выбери силу зума и нажми “Добавить зум”. Зелёный клип на дорожке эффектов можно двигать, растягивать и удалить.',
    effects: 'Выбери футаж на таймлайне, затем включи хромакей и цвет именно для этого блока. Финальный рендер делает модерация/обработка.',
  };
  if (editorEls.hint) editorEls.hint.textContent = hints[activeEditorMode] || hints.trim;
}

function freezeDrawingPoint(event) {
  const rect = editorEls.freezeDrawingCanvas?.getBoundingClientRect();
  if (!rect?.width || !rect?.height) return { x: 0, y: 0 };
  return {
    x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
  };
}

function finishFreezeDrawing(event) {
  if (!freezeDrawingPointer || event.pointerId !== freezeDrawingPointer.pointerId) return;
  try { editorEls.freezeDrawingCanvas?.releasePointerCapture(event.pointerId); } catch (_) {}
  freezeDrawingPointer = null;
  saveVideoEdit();
}

editorEls.freezeDrawingCanvas?.addEventListener('pointerdown', event => {
  const freeze = selectedFreezeClip();
  if (!freeze || freeze.id !== freezeDrawingVisibleId || outputPlaybackActive) return;
  if ((freeze.annotations || []).length >= MAX_FREEZE_ANNOTATION_STROKES) {
    toast(`На одном стоп-кадре можно сохранить до ${MAX_FREEZE_ANNOTATION_STROKES} штрихов`, 'i');
    return;
  }
  event.preventDefault();
  const annotation = createFreezeAnnotation({
    type: freezeDrawingTool,
    color: freezeDrawingColor,
    width: freezeDrawingWidth,
    point: freezeDrawingPoint(event),
  });
  if (!annotation) return;
  freeze.annotations = [...normalizeFreezeAnnotations(freeze.annotations), annotation];
  freezeDrawingPointer = { pointerId: event.pointerId, freezeId: freeze.id, annotation };
  try { editorEls.freezeDrawingCanvas.setPointerCapture(event.pointerId); } catch (_) {}
  renderFreezeDrawing();
  syncFreezeDrawingPanel();
});

editorEls.freezeDrawingCanvas?.addEventListener('pointermove', event => {
  if (!freezeDrawingPointer || event.pointerId !== freezeDrawingPointer.pointerId) return;
  event.preventDefault();
  if (updateFreezeAnnotation(freezeDrawingPointer.annotation, freezeDrawingPoint(event))) {
    renderFreezeDrawing();
  }
});
editorEls.freezeDrawingCanvas?.addEventListener('pointerup', finishFreezeDrawing);
editorEls.freezeDrawingCanvas?.addEventListener('pointercancel', finishFreezeDrawing);
editorEls.freezeDrawingCanvas?.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    editorEls.freezeDrawingUndo?.click();
  }
});

document.querySelectorAll('[data-freeze-draw-tool]').forEach(button => {
  button.addEventListener('click', () => {
    freezeDrawingTool = button.dataset.freezeDrawTool === 'line' ? 'line' : 'brush';
    syncFreezeDrawingPanel();
    editorEls.freezeDrawingCanvas?.focus({ preventScroll: true });
  });
});
document.querySelectorAll('[data-freeze-draw-color]').forEach(button => {
  button.addEventListener('click', () => {
    freezeDrawingColor = button.dataset.freezeDrawColor || '#00d4ff';
    syncFreezeDrawingPanel();
    editorEls.freezeDrawingCanvas?.focus({ preventScroll: true });
  });
});
document.querySelectorAll('[data-freeze-draw-width]').forEach(button => {
  button.addEventListener('click', () => {
    freezeDrawingWidth = Math.max(0.0015, Math.min(0.03, Number(button.dataset.freezeDrawWidth || 0.006)));
    syncFreezeDrawingPanel();
    editorEls.freezeDrawingCanvas?.focus({ preventScroll: true });
  });
});
editorEls.freezeDrawingUndo?.addEventListener('click', () => {
  const freeze = selectedFreezeClip();
  if (!freeze?.annotations?.length) return;
  freeze.annotations = freeze.annotations.slice(0, -1);
  saveVideoEdit();
  editorEls.freezeDrawingCanvas?.focus({ preventScroll: true });
});
editorEls.freezeDrawingClear?.addEventListener('click', () => {
  const freeze = selectedFreezeClip();
  if (!freeze?.annotations?.length) return;
  freeze.annotations = [];
  saveVideoEdit();
  editorEls.freezeDrawingCanvas?.focus({ preventScroll: true });
});
window.addEventListener('resize', () => {
  if (freezeDrawingVisibleId) renderFreezeDrawing();
});

function applyVideoEditPreview() {
  const previewOutputTime = currentOutputTime();
  const { clip: activeZoom, mix: zoomMix } = zoomPreviewStateAtOutput(previewOutputTime);
  const targetScaleX = activeZoom ? Number(activeZoom.scaleX ?? activeZoom.scale ?? 1) : 1;
  const targetScaleY = activeZoom ? Number(activeZoom.scaleY ?? activeZoom.scale ?? 1) : 1;
  const scaleX = 1 + (targetScaleX - 1) * zoomMix;
  const scaleY = 1 + (targetScaleY - 1) * zoomMix;
  const scale = Math.max(scaleX, scaleY, 1);
  const posX = activeZoom ? Number(activeZoom.posX || 0) * zoomMix : 0;
  const posY = activeZoom ? Number(activeZoom.posY || 0) * zoomMix : 0;
  const rotation = activeZoom ? Number(activeZoom.rotation || 0) * zoomMix : 0;
  const anchorX = activeZoom ? 50 + (Number(activeZoom.anchorX ?? 50) - 50) * zoomMix : 50;
  const anchorY = activeZoom ? 50 + (Number(activeZoom.anchorY ?? 50) - 50) * zoomMix : 50;
  const pan = zoomPanForAnchor(anchorX, anchorY, scale);
  const transformOrigin = '50% 50%';
  const transform = `scale(${scale}) translate(${pan.x + posX}px, ${pan.y + posY}px) rotate(${rotation}deg)`;
  if (vidPlayer.style.transformOrigin !== transformOrigin) vidPlayer.style.transformOrigin = transformOrigin;
  if (vidPlayer.style.transform !== transform) vidPlayer.style.transform = transform;
  if (editorEls.freezeOverlay) {
    if (editorEls.freezeOverlay.style.transformOrigin !== transformOrigin) editorEls.freezeOverlay.style.transformOrigin = transformOrigin;
    if (editorEls.freezeOverlay.style.transform !== transform) editorEls.freezeOverlay.style.transform = transform;
  }
  if (editorEls.freezeDrawingCanvas) {
    if (editorEls.freezeDrawingCanvas.style.transformOrigin !== transformOrigin) editorEls.freezeDrawingCanvas.style.transformOrigin = transformOrigin;
    if (editorEls.freezeDrawingCanvas.style.transform !== transform) editorEls.freezeDrawingCanvas.style.transform = transform;
  }
  if (editorEls.freezeDrawingVector) {
    if (editorEls.freezeDrawingVector.style.transformOrigin !== transformOrigin) editorEls.freezeDrawingVector.style.transformOrigin = transformOrigin;
    if (editorEls.freezeDrawingVector.style.transform !== transform) editorEls.freezeDrawingVector.style.transform = transform;
  }
  const activeFootage = activeFootageClipAtOutput(previewOutputTime);
  if (editorEls.footagePreview) {
    if (activeFootage?.url) {
      applyFootageOverlayTransform(activeFootage);
      if (editorEls.footagePreview.dataset.url !== activeFootage.url) {
        editorEls.footagePreview.dataset.url = activeFootage.url;
        editorEls.footagePreview.src = activeFootage.url;
        stopChromaPreview();
      }
      editorEls.footagePreview.muted = activeFootage.muted !== false;
      const clipStart = effectOutputStart(activeFootage);
      const localTime = Math.max(0, previewOutputTime - clipStart);
      if (Number.isFinite(localTime) && Math.abs((editorEls.footagePreview.currentTime || 0) - localTime) > 0.12) {
        try { editorEls.footagePreview.currentTime = localTime; } catch (_) {}
      }
      if ((outputPlaybackActive || !vidPlayer.paused) && editorEls.footagePreview.paused) {
        safePlay(editorEls.footagePreview);
      } else if (!outputPlaybackActive && vidPlayer.paused && !editorEls.footagePreview.paused) {
        editorEls.footagePreview.pause();
      }
      const hasChroma = !!activeFootage.chromaKey?.enabled;
      const isSelectedFootage = selectedEditorItem?.type === 'footage' && selectedEditorItem.id === activeFootage.id;
      editorEls.footagePreview.classList.toggle('show', !hasChroma);
      editorEls.footagePreview.classList.toggle('processing-chroma', hasChroma);
      editorEls.footagePreview.classList.toggle('interactive', isSelectedFootage);
      editorEls.footageCanvas?.classList.toggle('interactive', isSelectedFootage);
      editorEls.footageFrame?.classList.toggle('show', isSelectedFootage);
      if (hasChroma) startChromaPreview(activeFootage);
      else stopChromaPreview();
    } else {
      releaseFootagePreviewResources();
    }
  }
  vidPlayer.style.filter = '';
  editorEls.zoomFrame?.classList.toggle('show', !!activeZoom && (scaleX > 1.01 || scaleY > 1.01));
  if (editorEls.zoomFrame) {
    const frameWidth = Math.max(16, Math.min(46, 54 / Math.max(scale, 1)));
    const frameHeight = Math.max(16, Math.min(46, 54 / Math.max(scale, 1)));
    editorEls.zoomFrame.style.left = `${anchorX}%`;
    editorEls.zoomFrame.style.top = `${anchorY}%`;
    editorEls.zoomFrame.style.width = `${frameWidth}%`;
    editorEls.zoomFrame.style.height = `${frameHeight}%`;
    editorEls.zoomFrame.textContent = activeZoom ? `${scale.toFixed(2)}x` : 'Зум';
  }
}

function timeFromTimelineEvent(event) {
  const duration = videoDuration();
  if (!duration || !editorEls.shell) return 0;
  const rect = editorEls.shell.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  return snapFrameTime(outputToSourceTime(ratio * timelineFrameDuration()));
}

function outputTimeFromTimelineEvent(event) {
  if (!editorEls.shell) return 0;
  const rect = editorEls.shell.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  return ratio * timelineFrameDuration();
}

function timelineSnapPoints() {
  const outputDuration = editedOutputDuration();
  const points = new Set([0, outputDuration, timelineFrameDuration()]);
  buildTimelineSegments().forEach(segment => {
    points.add(segment.outputStart);
    points.add(segment.outputStart + segment.duration);
  });
  (videoEdit.splits || []).forEach(time => points.add(sourceToOutputTime(time)));
  (videoEdit.freezeFrames || []).forEach(freeze => {
    const segment = buildTimelineSegments().find(item => item.type === 'freeze' && item.id === freeze.id);
    const start = segment?.outputStart ?? sourceToOutputTime(freeze.at);
    points.add(start);
    points.add(start + Number(freeze.duration || 2));
  });
  (videoEdit.zoomKeyframes || []).forEach(zoom => {
    const start = effectOutputStart(zoom);
    points.add(start);
    points.add(start + Number(zoom.duration || 2));
  });
  (videoEdit.footageOverlays || []).forEach(footage => {
    const start = effectOutputStart(footage);
    points.add(start);
    points.add(start + Number(footage.duration || 2));
  });
  return [...points].filter(Number.isFinite).sort((a, b) => a - b);
}

function snapOutputTime(outputTime) {
  const frameDuration = timelineFrameDuration();
  const raw = Math.max(0, Math.min(frameDuration, Number(outputTime || 0)));
  if (!timelineMagnetEnabled) return raw;
  const threshold = Math.max(0.07, Math.min(0.28, 12 / Math.max(1, timelinePixelsPerSecond)));
  let best = raw;
  let bestDistance = threshold;
  timelineSnapPoints().forEach(point => {
    const distance = Math.abs(point - raw);
    if (distance <= bestDistance) {
      best = point;
      bestDistance = distance;
    }
  });
  return Math.max(0, Math.min(frameDuration, best));
}

function timelineTimesFromEvent(event, { magnet = true } = {}) {
  const rawOutputTime = outputTimeFromTimelineEvent(event);
  const outputTime = magnet ? snapOutputTime(rawOutputTime) : rawOutputTime;
  return {
    outputTime: Math.max(0, Math.min(editedOutputDuration(), outputTime)),
    sourceTime: snapFrameTime(outputToSourceTime(outputTime)),
  };
}

function effectTrackFromPointerEvent(event) {
  if (!editorEls.effectLane) return activeEffectTrack;
  const trackCount = Math.max(1, Number(videoEdit.effectTracks || 1));
  const rect = editorEls.effectLane.getBoundingClientRect();
  const y = Math.max(0, Math.min(rect.height - 1, event.clientY - rect.top));
  return Math.max(0, Math.min(trackCount - 1, Math.floor(y / EFFECT_TRACK_HEIGHT)));
}

function autoScrollTimelineWhileDragging(event) {
  if (!editorEls.scroll || !timelineDrag) return;
  const maxScroll = editorEls.scroll.scrollWidth - editorEls.scroll.clientWidth;
  if (maxScroll <= 0) return;
  const rect = editorEls.scroll.getBoundingClientRect();
  const edge = 46;
  let delta = 0;
  if (event.clientX > rect.right - edge) {
    delta = Math.min(32, edge - (rect.right - event.clientX));
  } else if (event.clientX < rect.left + edge) {
    delta = -Math.min(32, edge - (event.clientX - rect.left));
  }
  if (!delta) return;
  editorEls.scroll.scrollLeft = Math.max(0, Math.min(maxScroll, editorEls.scroll.scrollLeft + delta));
}

function keepTimelinePlayheadVisible(playheadX) {
  if (!editorEls.scroll || !editorEls.shell) return;
  const maxScroll = editorEls.scroll.scrollWidth - editorEls.scroll.clientWidth;
  if (maxScroll <= 0) return;
  const leftGuard = editorEls.scroll.scrollLeft + 96;
  const rightGuard = editorEls.scroll.scrollLeft + editorEls.scroll.clientWidth - 96;
  let nextScroll = editorEls.scroll.scrollLeft;
  if (playheadX > rightGuard) nextScroll = playheadX - editorEls.scroll.clientWidth + 96;
  else if (playheadX < leftGuard) nextScroll = playheadX - 96;
  nextScroll = Math.max(0, Math.min(maxScroll, nextScroll));
  if (Math.abs(nextScroll - editorEls.scroll.scrollLeft) > 1) {
    editorEls.scroll.scrollLeft = nextScroll;
  }
}

function syncMagnetButton() {
  editorEls.magnet?.classList.toggle('active', timelineMagnetEnabled);
  editorEls.magnet?.setAttribute('aria-pressed', timelineMagnetEnabled ? 'true' : 'false');
  if (editorEls.magnet) editorEls.magnet.title = timelineMagnetEnabled
    ? 'Магнит включён: прилипает к стыкам клипов'
    : 'Магнит выключен';
}

function applyTimelineTool(time, outputTime = null) {
  stopOutputPlayback({ keepPreview: false });
  clearFreezeHold();
  vidPlayer.pause();
  const segment = outputTime === null ? null : segmentForOutputTime(outputTime);
  setFreezeOverlay(segment?.type === 'freeze' ? (freezeFrameImages.get(segment.id) || '') : '', segment?.type === 'freeze' ? segment.id : '');
  timelinePreviewOutputTime = outputTime === null ? sourceToOutputTime(time) : Math.max(0, Math.min(editedOutputDuration(), outputTime));
  vidPlayer.currentTime = clampTime(time);
  renderVideoEditor();
}

function addUniqueTime(list, time) {
  const t = Math.round(clampTime(time) * 10) / 10;
  if (!t && t !== 0) return list;
  if (list.some(v => Math.abs(v - t) < 0.11)) return list.filter(v => Math.abs(v - t) >= 0.11);
  return [...list, t].sort((a, b) => a - b);
}

function cloneVideoEditState(edit = videoEdit) {
  return JSON.parse(JSON.stringify(edit || createDefaultVideoEdit()));
}

function serializedVideoEditState(edit) {
  try { return JSON.stringify(edit || createDefaultVideoEdit()); }
  catch (_) { return ''; }
}

function writeVideoEditHistory() {
  try { localStorage.setItem(VIDEO_EDIT_UNDO_KEY, JSON.stringify(videoEditUndoStack)); } catch (_) {}
  try { localStorage.setItem(VIDEO_EDIT_REDO_KEY, JSON.stringify(videoEditRedoStack)); } catch (_) {}
  if (editorEls.undo) editorEls.undo.disabled = !videoEditUndoStack.length;
  if (editorEls.redo) editorEls.redo.disabled = !videoEditRedoStack.length;
}

function loadVideoEditUndoStack() {
  try {
    const parsed = JSON.parse(localStorage.getItem(VIDEO_EDIT_UNDO_KEY) || '[]');
    videoEditUndoStack = Array.isArray(parsed) ? parsed.slice(-VIDEO_EDIT_UNDO_LIMIT) : [];
  } catch (_) {
    videoEditUndoStack = [];
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(VIDEO_EDIT_REDO_KEY) || '[]');
    videoEditRedoStack = Array.isArray(parsed) ? parsed.slice(-VIDEO_EDIT_UNDO_LIMIT) : [];
  } catch (_) {
    videoEditRedoStack = [];
  }
  writeVideoEditHistory();
}

function pushVideoEditUndo() {
  videoEditUndoStack.push(cloneVideoEditState(normalizedVideoEdit()));
  if (videoEditUndoStack.length > VIDEO_EDIT_UNDO_LIMIT) videoEditUndoStack.shift();
  videoEditRedoStack = [];
  writeVideoEditHistory();
}

function rememberCommittedVideoEdit() {
  lastCommittedVideoEditState = cloneVideoEditState(videoEdit);
}

function undoVideoEdit() {
  const previous = videoEditUndoStack.pop();
  if (!previous) { toast('Нечего отменять', 'i'); return; }
  videoEditRedoStack.push(cloneVideoEditState(normalizedVideoEdit()));
  if (videoEditRedoStack.length > VIDEO_EDIT_UNDO_LIMIT) videoEditRedoStack.shift();
  stopOutputPlayback({ keepPreview: false });
  clearFreezeHold();
  timelinePreviewOutputTime = null;
  selectedEditorItem = null;
  videoEdit = { ...createDefaultVideoEdit(), ...previous };
  writeVideoEditHistory();
  saveVideoEdit({ skipUndo: true });
  toast('Монтаж восстановлен', 's');
}

function redoVideoEdit() {
  const next = videoEditRedoStack.pop();
  if (!next) { toast('Нечего возвращать', 'i'); return; }
  videoEditUndoStack.push(cloneVideoEditState(normalizedVideoEdit()));
  if (videoEditUndoStack.length > VIDEO_EDIT_UNDO_LIMIT) videoEditUndoStack.shift();
  stopOutputPlayback({ keepPreview:false });
  clearFreezeHold();
  timelinePreviewOutputTime = null;
  selectedEditorItem = null;
  videoEdit = { ...createDefaultVideoEdit(), ...next };
  writeVideoEditHistory();
  saveVideoEdit({ skipUndo:true });
  toast('Отменённое изменение возвращено', 's');
}

function saveVideoEdit({ skipUndo = false, preserveConfirmation = false } = {}) {
  if (!skipUndo) clearResetConfirmation();
  if (!skipUndo && lastCommittedVideoEditState) {
    const currentBeforeNormalize = cloneVideoEditState(videoEdit);
    if (serializedVideoEditState(currentBeforeNormalize) !== serializedVideoEditState(lastCommittedVideoEditState)) {
      videoEditUndoStack.push(cloneVideoEditState(lastCommittedVideoEditState));
      if (videoEditUndoStack.length > VIDEO_EDIT_UNDO_LIMIT) videoEditUndoStack.shift();
      videoEditRedoStack = [];
      writeVideoEditHistory();
    }
  }
  videoEdit = normalizedVideoEdit();
  videoEdit.revision = Math.max(0, Number(videoEdit.revision || 0)) + 1;
  if (!preserveConfirmation) {
    videoEdit.confirmation = { status: 'pending', confirmedRevision: null, confirmedAt: null };
  }
  videoEdit.projectV3 = migrateVideoEditToProjectV3(videoEdit, videoDuration());
  saveModeratorVideoEditBackup();
  rememberCommittedVideoEdit();
  renderVideoEditor();
  _saveDraft();
}

function clearResetConfirmation() {
  if (resetConfirmTimer) {
    clearTimeout(resetConfirmTimer);
    resetConfirmTimer = null;
  }
  if (editorEls.reset) editorEls.reset.textContent = 'Сбросить монтаж';
}

function resetVideoEdit() {
  if (!resetConfirmTimer) {
    if (editorEls.reset) editorEls.reset.textContent = 'Точно сбросить?';
    toast('Нажми «Точно сбросить?» ещё раз, чтобы очистить монтаж', 'w');
    resetConfirmTimer = setTimeout(clearResetConfirmation, 4500);
    return;
  }
  pushVideoEditUndo();
  clearResetConfirmation();
  stopOutputPlayback({ keepPreview: false });
  clearFreezeHold();
  timelinePreviewOutputTime = null;
  freezeFrameImages.clear();
  setFreezeOverlay('');
  videoEdit = createDefaultVideoEdit();
  videoEdit.trimEnd = videoDuration();
  selectedEditorItem = null;
  saveVideoEdit({ skipUndo: true });
  toast('Монтаж сброшен. Можно нажать «Отменить»', 's');
}

loadVideoEditUndoStack();
rememberCommittedVideoEdit();

function clearFreezeHold() {
  if (freezeHoldTimer) {
    clearTimeout(freezeHoldTimer);
    freezeHoldTimer = null;
  }
  if (freezeHoldRenderInterval) {
    clearInterval(freezeHoldRenderInterval);
    freezeHoldRenderInterval = null;
  }
  freezeHoldActive = null;
}

dropZone.addEventListener('click', () => vidInput.click());
dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleVideoFile(file);
});
vidInput.addEventListener('change', () => { if (vidInput.files[0]) handleVideoFile(vidInput.files[0]); });
editorEls.footagePreview?.addEventListener('loadeddata', () => {
  if (editorEls.footageStatus?.textContent === 'Не удалось показать футаж в предпросмотре') {
    editorEls.footageStatus.textContent = '';
  }
  applyVideoEditPreview();
});
editorEls.footagePreview?.addEventListener('error', () => {
  if (editorEls.footageStatus) editorEls.footageStatus.textContent = 'Не удалось показать футаж в предпросмотре';
  toast('Браузер не смог показать этот футаж в предпросмотре. Попробуй H.264 MP4/WebM для preview.', 'w');
});
document.querySelectorAll('[data-editor-mode]').forEach(btn => {
  btn.addEventListener('click', () => setEditorMode(btn.dataset.editorMode || 'trim'));
});
editorEls.shell?.addEventListener('click', event => {
  if (suppressTimelineClick) {
    suppressTimelineClick = false;
    return;
  }
  const { outputTime, sourceTime } = timelineTimesFromEvent(event, {
    magnet: false,
  });
  if (activeEditorMode === 'split') {
    splitVideoClipAt(sourceTime);
    return;
  }
  applyTimelineTool(sourceTime, outputTime);
});
editorEls.shell?.addEventListener('pointerdown', event => {
  const duration = videoDuration();
  if (!duration) return;
  const splitMarker = event.target.closest('[data-split-at]');
  if (splitMarker) {
    selectedEditorItem = { type: 'split', at: Number(splitMarker.dataset.splitAt || 0) };
    suppressTimelineClick = true;
    renderVideoEditor();
    event.preventDefault();
    return;
  }
  const clipBlock = event.target.closest('[data-clip-id]');
  if (clipBlock) {
    if (activeEditorMode === 'split') {
      const { sourceTime } = timelineTimesFromEvent(event, { magnet:false });
      splitVideoClipAt(sourceTime);
      suppressTimelineClick = true;
      event.preventDefault();
      return;
    }
    const id = clipBlock.dataset.clipId || '';
    const edge = event.target.closest('[data-clip-edge]')?.dataset.clipEdge || '';
    const clip = (videoEdit.clips || []).find(item => item.id === id);
    selectedEditorItem = { type:'clip', id };
    if (edge && clip) {
      const clips = videoEdit.clips || [];
      const clipIndex = clips.findIndex(item => item.id === id);
      const neighbor = edge === 'start' ? clips[clipIndex - 1] : clips[clipIndex + 1];
      const sharedBoundary = edge === 'start'
        ? neighbor && Math.abs(Number(neighbor.sourceEnd) - Number(clip.sourceStart)) < 0.05
        : neighbor && Math.abs(Number(clip.sourceEnd) - Number(neighbor.sourceStart)) < 0.05;
      timelineDrag = {
        kind:'clip-resize', edge, id, moved:false, startX:event.clientX,
        startSourceStart:Number(clip.sourceStart || 0), startSourceEnd:Number(clip.sourceEnd || 0),
        neighborId:sharedBoundary ? neighbor.id : '',
        neighborSourceStart:Number(neighbor?.sourceStart || 0),
        neighborSourceEnd:Number(neighbor?.sourceEnd || 0),
      };
      safeSetPointerCapture(editorEls.shell, event.pointerId);
      editorEls.shell.classList.add('dragging');
    } else if (clip) {
      const clipSegments = buildTimelineSegments().filter(item => item.clipId === id);
      const clipOutputStart = clipSegments.length
        ? Math.min(...clipSegments.map(item => item.outputStart))
        : Number(clip.timelineStart || 0);
      timelineDrag = {
        kind:'clip-reorder', id, moved:false, changed:false, startX:event.clientX,
        offset:outputTimeFromTimelineEvent(event) - clipOutputStart,
      };
      safeSetPointerCapture(editorEls.shell, event.pointerId);
      editorEls.shell.classList.add('dragging');
    }
    suppressTimelineClick = true;
    renderVideoEditor();
    event.preventDefault();
    return;
  }
  const footageBlock = event.target.closest('[data-footage-id]');
  if (footageBlock) {
    const id = footageBlock.dataset.footageId || '';
    const edge = event.target.closest('[data-footage-edge]')?.dataset.footageEdge || '';
    const footage = (videoEdit.footageOverlays || []).find(item => item.id === id);
    selectedEditorItem = { type: 'footage', id };
    activeEffectTrack = Math.max(0, Number(footage?.track || 0));
    setEditorMode('effects');
    timelineDrag = edge
      ? { kind: 'footage-resize', edge, id, moved: false, startX: event.clientX, startAt: Number(footage?.at || 0), startOutputAt: effectOutputStart(footage), startDuration: Number(footage?.duration || 2) }
      : { kind: 'footage', id, moved: false, offset: footage ? outputTimeFromTimelineEvent(event) - effectOutputStart(footage) : 0 };
    suppressTimelineClick = true;
    safeSetPointerCapture(editorEls.shell, event.pointerId);
    editorEls.shell.classList.add('dragging');
    renderVideoEditor();
    event.preventDefault();
    return;
  }
  const zoomBlock = event.target.closest('[data-zoom-id]');
  if (zoomBlock) {
    const id = zoomBlock.dataset.zoomId || '';
    const edge = event.target.closest('[data-zoom-edge]')?.dataset.zoomEdge || '';
    const zoom = (videoEdit.zoomKeyframes || []).find(item => item.id === id);
    selectedEditorItem = { type: 'zoom', id };
    activeEffectTrack = Math.max(0, Number(zoom?.track || 0));
    setEditorMode('zoom');
    timelineDrag = edge
      ? { kind: 'zoom-resize', edge, id, moved: false, startX: event.clientX, startAt: Number(zoom?.at || 0), startOutputAt: effectOutputStart(zoom), startDuration: Number(zoom?.duration || 2) }
      : { kind: 'zoom', id, moved: false, offset: zoom ? outputTimeFromTimelineEvent(event) - effectOutputStart(zoom) : 0 };
    suppressTimelineClick = true;
    safeSetPointerCapture(editorEls.shell, event.pointerId);
    editorEls.shell.classList.add('dragging');
    renderVideoEditor();
    event.preventDefault();
    return;
  }
  const effectTrackRow = event.target.closest('[data-effect-track]');
  if (effectTrackRow) {
    activeEffectTrack = Math.max(0, Math.min((videoEdit.effectTracks || 1) - 1, Number(effectTrackRow.dataset.effectTrack || 0)));
    selectedEditorItem = { type: 'effectTrack', track: activeEffectTrack };
    suppressTimelineClick = true;
    renderVideoEditor();
    event.preventDefault();
    return;
  }
  const freezeBlock = event.target.closest('[data-freeze-id]');
  if (freezeBlock) {
    const id = freezeBlock.dataset.freezeId || '';
    const edge = event.target.closest('[data-freeze-edge]')?.dataset.freezeEdge || '';
    const freeze = (videoEdit.freezeFrames || []).find(item => item.id === id);
    selectedEditorItem = { type: 'freeze', id };
    previewFreezeForDrawing(id);
    timelineDrag = edge
      ? { kind: 'freeze-resize', edge, id, moved: false, startX: event.clientX, startAt: Number(freeze?.at || 0), startDuration: Number(freeze?.duration || 2) }
      : { kind: 'freeze', id, moved: false, offset: freeze ? timeFromTimelineEvent(event) - freeze.at : 0 };
    suppressTimelineClick = true;
    safeSetPointerCapture(editorEls.shell, event.pointerId);
    editorEls.shell.classList.add('dragging');
    renderVideoEditor();
    event.preventDefault();
    return;
  }
  const handle = event.target.closest('[data-trim-handle]');
  timelineDrag = { kind: handle?.dataset.trimHandle || 'playhead', moved: false };
  safeSetPointerCapture(editorEls.shell, event.pointerId);
  editorEls.shell.classList.add('dragging');
  if (timelineDrag.kind === 'playhead') {
    const { outputTime, sourceTime } = timelineTimesFromEvent(event, { magnet: false });
    applyTimelineTool(sourceTime, outputTime);
  }
  event.preventDefault();
});
function moveTimelinePointer(event) {
  if (!timelineDrag) return;
  if (timelineDrag.kind === 'clip-reorder' && !timelineDrag.moved && Math.abs(event.clientX - timelineDrag.startX) < 4) return;
  timelineDrag.moved = true;
  autoScrollTimelineWhileDragging(event);
  const rawTime = clampTime(timeFromTimelineEvent(event));
  const { outputTime, sourceTime } = timelineTimesFromEvent(event, {
    magnet: timelineDrag.kind !== 'playhead',
  });
  const time = sourceTime;
  if (timelineDrag.kind === 'start') {
    const end = videoEdit.trimEnd || videoDuration();
    const minTrim = end ? Math.min(MIN_TRIM_DURATION_SECONDS, end) : MIN_TRIM_DURATION_SECONDS;
    videoEdit.trimStart = Math.min(time, Math.max(0, end - minTrim));
  } else if (timelineDrag.kind === 'end') {
    const duration = videoDuration();
    const minTrim = duration ? Math.min(MIN_TRIM_DURATION_SECONDS, duration) : MIN_TRIM_DURATION_SECONDS;
    videoEdit.trimEnd = Math.max(time, videoEdit.trimStart + minTrim);
  } else if (timelineDrag.kind === 'freeze') {
    const freeze = (videoEdit.freezeFrames || []).find(item => item.id === timelineDrag.id);
    if (freeze) {
      const rawStart = clampTime(rawTime - (timelineDrag.offset || 0));
      freeze.at = clampTime(outputToSourceTime(snapOutputTime(sourceToOutputTime(rawStart))));
    }
  } else if (timelineDrag.kind === 'clip-resize') {
    const clip = (videoEdit.clips || []).find(item => item.id === timelineDrag.id);
    const neighbor = (videoEdit.clips || []).find(item => item.id === timelineDrag.neighborId);
    if (clip) {
      const delta = (event.clientX - timelineDrag.startX) / timelinePixelsPerSecond;
      const minimum = Math.max(0.05, frameStep());
      if (timelineDrag.edge === 'start') {
        const nextBoundary = Math.max(0, Math.min(
          snapFrameTime(timelineDrag.startSourceStart + delta),
          timelineDrag.startSourceEnd - minimum,
        ));
        clip.sourceStart = neighbor
          ? Math.max(timelineDrag.neighborSourceStart + minimum, nextBoundary)
          : nextBoundary;
        if (neighbor) neighbor.sourceEnd = clip.sourceStart;
      } else {
        const nextBoundary = Math.min(videoDuration(), Math.max(
          snapFrameTime(timelineDrag.startSourceEnd + delta),
          timelineDrag.startSourceStart + minimum,
        ));
        clip.sourceEnd = neighbor
          ? Math.min(timelineDrag.neighborSourceEnd - minimum, nextBoundary)
          : nextBoundary;
        if (neighbor) neighbor.sourceStart = clip.sourceEnd;
      }
    }
  } else if (timelineDrag.kind === 'clip-reorder') {
    const clips = Array.isArray(videoEdit.clips) ? [...videoEdit.clips] : [];
    const currentIndex = clips.findIndex(item => item.id === timelineDrag.id);
    if (currentIndex >= 0) {
      const pointerOutput = Math.max(0, outputTimeFromTimelineEvent(event));
      const draggedClip = clips[currentIndex];
      const nextTimelineStart = snapOutputTime(Math.max(0, pointerOutput - Number(timelineDrag.offset || 0)));
      if (Math.abs(Number(draggedClip.timelineStart || 0) - nextTimelineStart) > 0.001) {
        draggedClip.timelineStart = nextTimelineStart;
        timelineDrag.changed = true;
      }
      const groups = new Map();
      buildTimelineSegments().forEach(segment => {
        if (!segment.clipId) return;
        const group = groups.get(segment.clipId) || { start:segment.outputStart, end:segment.outputStart };
        group.start = Math.min(group.start, segment.outputStart);
        group.end = Math.max(group.end, segment.outputStart + segment.duration);
        groups.set(segment.clipId, group);
      });
      const withoutDragged = clips.filter(item => item.id !== timelineDrag.id);
      let targetIndex = withoutDragged.length;
      for (let index = 0; index < withoutDragged.length; index += 1) {
        const group = groups.get(withoutDragged[index].id);
        if (group && pointerOutput < (group.start + group.end) / 2) { targetIndex = index; break; }
      }
      withoutDragged.splice(targetIndex, 0, draggedClip);
      if (withoutDragged.some((item, index) => item.id !== clips[index]?.id)) {
        videoEdit.clips = withoutDragged;
        timelineDrag.changed = true;
      }
    }
  } else if (timelineDrag.kind === 'freeze-resize') {
    const freeze = (videoEdit.freezeFrames || []).find(item => item.id === timelineDrag.id);
    if (freeze) {
      const delta = (event.clientX - timelineDrag.startX) / timelinePixelsPerSecond;
      if (timelineDrag.edge === 'start') {
        const nextAt = clampTime(timelineDrag.startAt + delta);
        const endAt = timelineDrag.startAt + timelineDrag.startDuration;
        freeze.at = Math.min(nextAt, Math.max(0, endAt - 0.2));
        freeze.duration = Math.max(0.2, Math.min(10, endAt - freeze.at));
      } else {
        freeze.duration = Math.max(0.2, Math.min(10, timelineDrag.startDuration + delta));
      }
    }
  } else if (timelineDrag.kind === 'zoom') {
    const zoom = (videoEdit.zoomKeyframes || []).find(item => item.id === timelineDrag.id);
    if (zoom) {
      const nextOutputStart = snapOutputTime(outputTime - (timelineDrag.offset || 0));
      zoom.outputAt = clampOutputTime(nextOutputStart);
      zoom.at = clampTime(outputToSourceTime(zoom.outputAt));
      zoom.track = effectTrackFromPointerEvent(event);
      activeEffectTrack = zoom.track;
    }
  } else if (timelineDrag.kind === 'zoom-resize') {
    const zoom = (videoEdit.zoomKeyframes || []).find(item => item.id === timelineDrag.id);
    if (zoom) {
      const delta = (event.clientX - timelineDrag.startX) / timelinePixelsPerSecond;
      if (timelineDrag.edge === 'start') {
        const endOutput = timelineDrag.startOutputAt + timelineDrag.startDuration;
        const nextOutputStart = Math.max(0, Math.min(endOutput - 0.2, timelineDrag.startOutputAt + delta));
        zoom.outputAt = clampOutputTime(nextOutputStart);
        zoom.at = clampTime(outputToSourceTime(nextOutputStart));
        zoom.duration = Math.max(0.2, Math.min(10, endOutput - nextOutputStart));
      } else {
        zoom.duration = Math.max(0.2, Math.min(10, timelineDrag.startDuration + delta));
      }
    }
  } else if (timelineDrag.kind === 'footage') {
    const footage = (videoEdit.footageOverlays || []).find(item => item.id === timelineDrag.id);
    if (footage) {
      const nextOutputStart = snapOutputTime(outputTime - (timelineDrag.offset || 0));
      footage.outputAt = clampOutputTime(nextOutputStart);
      footage.at = clampTime(outputToSourceTime(footage.outputAt));
      footage.track = effectTrackFromPointerEvent(event);
      activeEffectTrack = footage.track;
    }
  } else if (timelineDrag.kind === 'footage-resize') {
    const footage = (videoEdit.footageOverlays || []).find(item => item.id === timelineDrag.id);
    if (footage) {
      const delta = (event.clientX - timelineDrag.startX) / timelinePixelsPerSecond;
      if (timelineDrag.edge === 'start') {
        const endOutput = timelineDrag.startOutputAt + timelineDrag.startDuration;
        const nextOutputStart = Math.max(0, Math.min(endOutput - 0.2, timelineDrag.startOutputAt + delta));
        footage.outputAt = clampOutputTime(nextOutputStart);
        footage.at = clampTime(outputToSourceTime(nextOutputStart));
        footage.duration = Math.max(0.2, Math.min(60, endOutput - nextOutputStart));
      } else {
        footage.duration = Math.max(0.2, Math.min(60, timelineDrag.startDuration + delta));
      }
    }
  } else {
    stopOutputPlayback({ keepPreview: false });
    clearFreezeHold();
    vidPlayer.pause();
    timelinePreviewOutputTime = outputTime;
    const segment = segmentForOutputTime(outputTime);
    setFreezeOverlay(segment?.type === 'freeze' ? (freezeFrameImages.get(segment.id) || '') : '', segment?.type === 'freeze' ? segment.id : '');
    vidPlayer.currentTime = snapFrameTime(time);
  }
  renderVideoEditor();
}
function finishTimelinePointer(event) {
  if (!timelineDrag) return;
  const wasTrim = timelineDrag.kind === 'start' || timelineDrag.kind === 'end';
  const wasClip = timelineDrag.kind === 'clip-resize' || timelineDrag.kind === 'clip-reorder';
  const wasFreeze = timelineDrag.kind === 'freeze' || timelineDrag.kind === 'freeze-resize';
  const wasZoom = timelineDrag.kind === 'zoom' || timelineDrag.kind === 'zoom-resize';
  const wasFootage = timelineDrag.kind === 'footage' || timelineDrag.kind === 'footage-resize';
  const changed = timelineDrag.kind !== 'clip-reorder' || !!timelineDrag.changed;
  safeReleasePointerCapture(editorEls.shell, event.pointerId);
  editorEls.shell.classList.remove('dragging');
  const moved = timelineDrag.moved;
  timelineDrag = null;
  suppressTimelineClick = moved || wasClip || wasFreeze || wasZoom || wasFootage;
  if ((wasTrim || wasClip || wasFreeze || wasZoom || wasFootage) && moved && changed) saveVideoEdit();
}
function cancelTimelinePointer() {
  timelineDrag = null;
  editorEls.shell?.classList.remove('dragging');
}
window.addEventListener('pointermove', moveTimelinePointer);
window.addEventListener('pointerup', finishTimelinePointer);
window.addEventListener('pointercancel', cancelTimelinePointer);
editorEls.trimStart?.addEventListener('change', event => {
  videoEdit.trimStart = clampTime(event.target.value);
  const duration = videoDuration();
  const minTrim = duration ? Math.min(MIN_TRIM_DURATION_SECONDS, duration) : MIN_TRIM_DURATION_SECONDS;
  if (videoEdit.trimEnd && videoEdit.trimStart > videoEdit.trimEnd - minTrim) {
    videoEdit.trimStart = Math.max(0, videoEdit.trimEnd - minTrim);
  }
  saveVideoEdit();
});
editorEls.trimEnd?.addEventListener('change', event => {
  videoEdit.trimEnd = clampTime(event.target.value);
  const duration = videoDuration();
  const minTrim = duration ? Math.min(MIN_TRIM_DURATION_SECONDS, duration) : MIN_TRIM_DURATION_SECONDS;
  if (videoEdit.trimEnd < videoEdit.trimStart + minTrim) {
    videoEdit.trimEnd = Math.min(duration || videoEdit.trimStart + minTrim, videoEdit.trimStart + minTrim);
  }
  saveVideoEdit();
});
editorEls.volume?.addEventListener('input', event => {
  videoEdit.audio.volume = Math.max(0, Math.min(2, Number(event.target.value || 1)));
  saveVideoEdit();
});
editorEls.muted?.addEventListener('change', event => {
  videoEdit.audio.muted = !!event.target.checked;
  saveVideoEdit();
});

function updateSelectedFootageChroma(patch) {
  const footage = selectedFootageClip();
  if (!footage) {
    toast('Сначала выбери футаж на таймлайне', 'i');
    syncFootageChromaPanel();
    return;
  }
  footage.chromaKey = normalizeChromaKey({
    ...(footage.chromaKey || {}),
    ...patch,
  });
  saveVideoEdit();
}

editorEls.chromaEnabled?.addEventListener('change', event => {
  updateSelectedFootageChroma({ enabled: !!event.target.checked });
});
editorEls.chromaColor?.addEventListener('input', event => {
  updateSelectedFootageChroma({ color: event.target.value || '#00ff00' });
});
editorEls.chromaStrength?.addEventListener('input', event => {
  updateSelectedFootageChroma({ strength: Number(event.target.value || 0.35) });
});
editorEls.footageScale?.addEventListener('input', event => {
  updateSelectedFootageTransform({ scale: Number(event.target.value || 0.35) });
});

function stagePointToPercent(clientX, clientY) {
  const rect = editorEls.stage?.getBoundingClientRect();
  if (!rect?.width || !rect?.height) return { x: 50, y: 50 };
  return {
    x: Math.max(0, Math.min(100, (clientX - rect.left) / rect.width * 100)),
    y: Math.max(0, Math.min(100, (clientY - rect.top) / rect.height * 100)),
  };
}

function beginFootageStageDrag(event) {
  if (event.button !== 0) return;
  const activeFootage = activeFootageClipAtOutput(currentOutputTime());
  if (!activeFootage) return;
  selectedEditorItem = { type: 'footage', id: activeFootage.id };
  activeEffectTrack = Math.max(0, Number(activeFootage.track || 0));
  setEditorMode('effects');
  const point = stagePointToPercent(event.clientX, event.clientY);
  const handle = event.target.closest?.('[data-footage-stage-handle]')?.dataset.footageStageHandle || '';
  const stageRect = editorEls.stage?.getBoundingClientRect();
  const centerX = stageRect ? stageRect.left + stageRect.width * Number(activeFootage.posX ?? 50) / 100 : event.clientX;
  const centerY = stageRect ? stageRect.top + stageRect.height * Number(activeFootage.posY ?? 50) / 100 : event.clientY;
  const startDistance = Math.max(12, Math.hypot(event.clientX - centerX, event.clientY - centerY));
  footageStageDrag = {
    kind: handle ? 'resize' : 'move',
    pointerId: event.pointerId,
    startX: point.x,
    startY: point.y,
    posX: Number(activeFootage.posX ?? 50),
    posY: Number(activeFootage.posY ?? 50),
    scale: Number(activeFootage.scale ?? 0.35),
    centerX,
    centerY,
    startDistance,
    moved: false,
  };
  safeSetPointerCapture(event.currentTarget, event.pointerId);
  event.preventDefault();
  event.stopPropagation();
  renderVideoEditor();
}

function moveFootageStageDrag(event) {
  if (!footageStageDrag || footageStageDrag.pointerId !== event.pointerId) return;
  if (footageStageDrag.kind === 'resize') {
    const nextDistance = Math.max(12, Math.hypot(event.clientX - footageStageDrag.centerX, event.clientY - footageStageDrag.centerY));
    const nextScale = footageStageDrag.scale * (nextDistance / Math.max(1, footageStageDrag.startDistance));
    footageStageDrag.moved = true;
    updateSelectedFootageTransform({ scale: nextScale }, { persist: false });
    updateTimelinePlaybackUi();
    event.preventDefault();
    return;
  }
  const point = stagePointToPercent(event.clientX, event.clientY);
  const nextX = footageStageDrag.posX + point.x - footageStageDrag.startX;
  const nextY = footageStageDrag.posY + point.y - footageStageDrag.startY;
  footageStageDrag.moved = true;
  updateSelectedFootageTransform({ posX: nextX, posY: nextY }, { persist: false });
  updateTimelinePlaybackUi();
  event.preventDefault();
}

function finishFootageStageDrag(event) {
  if (!footageStageDrag || footageStageDrag.pointerId !== event.pointerId) return;
  safeReleasePointerCapture(event.currentTarget, event.pointerId);
  const moved = footageStageDrag.moved;
  footageStageDrag = null;
  if (moved) saveVideoEdit();
  event.preventDefault();
}

[editorEls.footagePreview, editorEls.footageCanvas, editorEls.footageFrame].forEach(el => {
  el?.addEventListener('pointerdown', beginFootageStageDrag);
  el?.addEventListener('pointermove', moveFootageStageDrag);
  el?.addEventListener('pointerup', finishFootageStageDrag);
  el?.addEventListener('pointercancel', finishFootageStageDrag);
  el?.addEventListener('wheel', event => {
    const footage = selectedFootageClip() || activeFootageClipAtOutput(currentOutputTime());
    if (!footage) return;
    selectedEditorItem = { type: 'footage', id: footage.id };
    activeEffectTrack = Math.max(0, Number(footage.track || 0));
    const direction = event.deltaY > 0 ? -1 : 1;
    const step = event.shiftKey ? 0.02 : 0.06;
    updateSelectedFootageTransform({ scale: Number(footage.scale ?? 0.35) + direction * step });
    event.preventDefault();
  }, { passive: false });
});
function bindZoomTransformInput(el, key, map = value => value) {
  el?.addEventListener('input', event => {
    if (key === 'scaleX' || key === 'scaleY') {
      const scale = map(Number(event.target.value || 1));
      if (editorEls.zoomScaleX) editorEls.zoomScaleX.value = scale.toFixed(2);
      if (editorEls.zoomScaleY) editorEls.zoomScaleY.value = scale.toFixed(2);
      updateSelectedZoomTransform({ scaleX: scale, scaleY: scale, scale });
      syncZoomTransformPanel();
      applyVideoEditPreview();
      return;
    }
    if (key === 'rotation' && editorEls.zoomRotationRange && event.target === editorEls.zoomRotation) {
      editorEls.zoomRotationRange.value = event.target.value;
    }
    if (key === 'rotation' && editorEls.zoomRotation && event.target === editorEls.zoomRotationRange) {
      editorEls.zoomRotation.value = event.target.value;
    }
    updateSelectedZoomTransform({ [key]: map(Number(event.target.value || 0)) });
  });
}

function clampTransformInputValue(el, value) {
  const min = Number(el?.getAttribute('min'));
  const max = Number(el?.getAttribute('max'));
  let next = Number.isFinite(value) ? value : Number(el?.value || 0);
  if (Number.isFinite(min)) next = Math.max(min, next);
  if (Number.isFinite(max)) next = Math.min(max, next);
  return next;
}

function formatTransformInputValue(el, value) {
  const step = String(el?.getAttribute('step') || '1');
  const decimals = step.includes('.') ? step.split('.')[1].length : 0;
  return clampTransformInputValue(el, value).toFixed(decimals);
}

function enterTransformTextEdit(el) {
  if (!el) return;
  el.readOnly = false;
  el.classList.add('editing');
  el.focus();
  requestAnimationFrame(() => el.select());
}

function exitTransformTextEdit(el) {
  if (!el) return;
  el.value = formatTransformInputValue(el, Number(String(el.value).replace(',', '.')));
  el.readOnly = true;
  el.classList.remove('editing');
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function bindTransformDragNumber(el) {
  if (!el) return;
  let drag = null;
  el.addEventListener('dblclick', event => {
    event.preventDefault();
    enterTransformTextEdit(el);
  });
  el.addEventListener('blur', () => exitTransformTextEdit(el));
  el.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      exitTransformTextEdit(el);
      el.blur();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      el.readOnly = true;
      el.classList.remove('editing');
      el.blur();
      syncZoomTransformPanel();
    }
  });
  el.addEventListener('pointerdown', event => {
    if (!el.readOnly || event.button !== 0) return;
    if (event.detail >= 2) {
      enterTransformTextEdit(el);
      event.preventDefault();
      return;
    }
    drag = {
      x: event.clientX,
      start: Number(String(el.value).replace(',', '.')) || 0,
      moved: false,
    };
    safeSetPointerCapture(el, event.pointerId);
    el.classList.add('dragging');
    event.preventDefault();
  });
  el.addEventListener('pointermove', event => {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    if (Math.abs(dx) > 2) drag.moved = true;
    if (!drag.moved) return;
    const step = Number(el.getAttribute('step') || 1) || 1;
    const multiplier = event.shiftKey ? 0.2 : event.altKey ? 0.05 : 0.25;
    const next = drag.start + dx * step * multiplier;
    el.value = formatTransformInputValue(el, next);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const finishDrag = event => {
    if (!drag) return;
    safeReleasePointerCapture(el, event.pointerId);
    el.classList.remove('dragging');
    if (drag.moved) saveVideoEdit();
    drag = null;
  };
  el.addEventListener('pointerup', finishDrag);
  el.addEventListener('pointercancel', finishDrag);
}

let zoomFrameDrag = null;
editorEls.zoomFrame?.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  setEditorMode('zoom');
  zoomFrameDrag = { pointerId: event.pointerId, moved: false };
  editorEls.zoomFrame.classList.add('dragging');
  safeSetPointerCapture(editorEls.zoomFrame, event.pointerId);
  updateZoomAreaFromPoint(event.clientX, event.clientY);
  event.preventDefault();
  event.stopPropagation();
});
editorEls.zoomFrame?.addEventListener('pointermove', event => {
  if (!zoomFrameDrag || zoomFrameDrag.pointerId !== event.pointerId) return;
  zoomFrameDrag.moved = true;
  updateZoomAreaFromPoint(event.clientX, event.clientY);
  event.preventDefault();
});
function finishZoomFrameDrag(event) {
  if (!zoomFrameDrag || zoomFrameDrag.pointerId !== event.pointerId) return;
  safeReleasePointerCapture(editorEls.zoomFrame, event.pointerId);
  editorEls.zoomFrame.classList.remove('dragging');
  zoomFrameDrag = null;
  saveVideoEdit();
  event.preventDefault();
}
editorEls.zoomFrame?.addEventListener('pointerup', finishZoomFrameDrag);
editorEls.zoomFrame?.addEventListener('pointercancel', finishZoomFrameDrag);

bindZoomTransformInput(editorEls.zoomScaleX, 'scaleX', value => Math.max(1, Math.min(EDITOR_MAX_ZOOM, value || 1)));
bindZoomTransformInput(editorEls.zoomScaleY, 'scaleY', value => Math.max(1, Math.min(EDITOR_MAX_ZOOM, value || 1)));
bindZoomTransformInput(editorEls.zoomPosX, 'posX', value => Math.max(-100, Math.min(100, value)));
bindZoomTransformInput(editorEls.zoomPosY, 'posY', value => Math.max(-100, Math.min(100, value)));
bindZoomTransformInput(editorEls.zoomRotation, 'rotation', value => Math.max(-45, Math.min(45, value)));
bindZoomTransformInput(editorEls.zoomRotationRange, 'rotation', value => Math.max(-45, Math.min(45, value)));
bindZoomTransformInput(editorEls.zoomAnchorX, 'anchorX', value => Math.max(0, Math.min(100, value)));
bindZoomTransformInput(editorEls.zoomAnchorY, 'anchorY', value => Math.max(0, Math.min(100, value)));
[
  editorEls.zoomScaleX,
  editorEls.zoomScaleY,
  editorEls.zoomPosX,
  editorEls.zoomPosY,
  editorEls.zoomRotation,
  editorEls.zoomAnchorX,
  editorEls.zoomAnchorY,
].forEach(bindTransformDragNumber);
document.getElementById('edit-zoom-reset')?.addEventListener('click', () => {
  updateSelectedZoomTransform({ scaleX: 1.4, scaleY: 1.4, scale: 1.4, posX: 0, posY: 0, rotation: 0, anchorX: 50, anchorY: 50 });
});
editorEls.timelineZoom?.addEventListener('input', event => {
  timelinePixelsPerSecond = Number(event.target.value || 52);
  renderVideoEditor();
});
editorEls.magnet?.addEventListener('click', () => {
  timelineMagnetEnabled = !timelineMagnetEnabled;
  syncMagnetButton();
  toast(timelineMagnetEnabled ? 'Магнит включён' : 'Магнит выключен', 'i');
});
syncMagnetButton();
document.getElementById('timeline-zoom-in')?.addEventListener('click', () => {
  timelinePixelsPerSecond = Math.min(120, timelinePixelsPerSecond + 8);
  if (editorEls.timelineZoom) editorEls.timelineZoom.value = String(timelinePixelsPerSecond);
  renderVideoEditor();
});
document.getElementById('timeline-zoom-out')?.addEventListener('click', () => {
  timelinePixelsPerSecond = Math.max(12, timelinePixelsPerSecond - 8);
  if (editorEls.timelineZoom) editorEls.timelineZoom.value = String(timelinePixelsPerSecond);
  renderVideoEditor();
});
function fitTimelineToViewport() {
  const duration = timelineFrameDuration();
  const width = Number(editorEls.scroll?.clientWidth || 0);
  if (!duration || !width) return;
  timelinePixelsPerSecond = Math.max(12, Math.min(120, (width - 4) / duration));
  if (editorEls.timelineZoom) editorEls.timelineZoom.value = String(timelinePixelsPerSecond);
  if (editorEls.scroll) editorEls.scroll.scrollLeft = 0;
  renderVideoEditor();
}
document.getElementById('timeline-fit')?.addEventListener('click', fitTimelineToViewport);
document.getElementById('edit-set-in')?.addEventListener('click', () => {
  videoEdit.trimStart = clampTime(vidPlayer.currentTime);
  if (videoEdit.trimEnd && videoEdit.trimStart > videoEdit.trimEnd) videoEdit.trimEnd = videoEdit.trimStart;
  saveVideoEdit();
});
document.getElementById('edit-set-out')?.addEventListener('click', () => {
  videoEdit.trimEnd = clampTime(vidPlayer.currentTime);
  if (videoEdit.trimEnd < videoEdit.trimStart) videoEdit.trimStart = videoEdit.trimEnd;
  saveVideoEdit();
});
function ensureExplicitVideoClips() {
  if (Array.isArray(videoEdit.clips)) return videoEdit.clips;
  const start = clampTime(videoEdit.trimStart);
  const end = clampTime(videoEdit.trimEnd || videoDuration());
  const boundaries = [...new Set([start, ...(videoEdit.splits || []), end]
    .map(clampTime).filter(value => value >= start && value <= end))].sort((a, b) => a - b);
  let timelineStart = 0;
  videoEdit.clips = boundaries.slice(0, -1).map((sourceStart, index) => {
    const clip = {
      id:`clip_${Math.round(sourceStart * 1000)}_${Math.round(boundaries[index + 1] * 1000)}`,
      sourceStart,
      sourceEnd:boundaries[index + 1],
      timelineStart,
    };
    timelineStart += clip.sourceEnd - clip.sourceStart;
    return clip;
  }).filter(clip => clip.sourceEnd - clip.sourceStart >= 0.001);
  return videoEdit.clips;
}

function splitVideoClipAt(time = vidPlayer.currentTime) {
  const at = Math.round(clampTime(time) * 10) / 10;
  const currentClips = ensureExplicitVideoClips();
  const clipIndex = currentClips.findIndex(clip => at > Number(clip.sourceStart) + 0.05 && at < Number(clip.sourceEnd) - 0.05);
  if (clipIndex < 0) { toast('Поставь курсор внутри клипа', 'w'); return; }
  const clip = currentClips[clipIndex];
  const clipTimelineStart = Number(clip.timelineStart || 0);
  const next = [
    { ...clip, id:`clip_${Math.round(Number(clip.sourceStart) * 1000)}_${Math.round(at * 1000)}`, sourceEnd:at, timelineStart:clipTimelineStart },
    { ...clip, id:`clip_${Math.round(at * 1000)}_${Math.round(Number(clip.sourceEnd) * 1000)}`, sourceStart:at, timelineStart:clipTimelineStart + at - Number(clip.sourceStart) },
  ];
  videoEdit.clips = [...currentClips.slice(0, clipIndex), ...next, ...currentClips.slice(clipIndex + 1)];
  videoEdit.splits = addUniqueTime(videoEdit.splits || [], at);
  selectedEditorItem = { type:'clip', id:next[1].id };
  timelinePreviewOutputTime = sourceToOutputTime(at);
  vidPlayer.currentTime = at;
  saveVideoEdit();
}
function splitVideoClipAtPlayhead() {
  splitVideoClipAt(vidPlayer.currentTime);
}
document.getElementById('edit-split')?.addEventListener('click', splitVideoClipAtPlayhead);
document.getElementById('edit-freeze')?.addEventListener('click', () => {
  toggleFreezeAt(vidPlayer.currentTime);
});
function toggleFreezeAt(time) {
  const at = Math.round(clampTime(time) * 10) / 10;
  const freeze = { id: `freeze_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, at, duration: 2, annotations: [] };
  const frame = captureCurrentVideoFrame();
  if (!frame) {
    toast('Не удалось прочитать кадр видео. Перезагрузи страницу и попробуй ещё раз.', 'e');
    logUploadError(new Error('Video frame capture unavailable'), {
      action: 'video_freeze_frame_capture',
      video_host: (() => { try { return new URL(videoUrl).hostname; } catch (_) { return ''; } })(),
      cors_fallback: vidPlayer.dataset.corsFallback || '0',
      ready_state: vidPlayer.readyState,
    });
    return;
  }
  freezeFrameImages.set(freeze.id, frame);
  videoEdit.freezeFrames = [...(videoEdit.freezeFrames || []), freeze];
  selectedEditorItem = { type: 'freeze', id: freeze.id };
  saveVideoEdit();
  previewFreezeForDrawing(freeze.id);
  toast('Стоп-кадр +2 сек добавлен — можно рисовать по кадру', 's');
}

function videoEditConfirmationState() {
  const revision = Math.max(0, Number(videoEdit.revision || 0));
  const confirmation = videoEdit.confirmation || {};
  return confirmation.status === 'confirmed' && Number(confirmation.confirmedRevision) === revision
    ? 'confirmed'
    : 'pending';
}

function renderVideoEditConfirmation() {
  if (!editorEls.confirmation) return;
  const confirmed = videoEditConfirmationState() === 'confirmed';
  editorEls.confirmation.dataset.state = confirmed ? 'confirmed' : 'pending';
  if (editorEls.confirmationTitle) editorEls.confirmationTitle.textContent = confirmed
    ? 'Монтаж подтверждён'
    : 'Есть неподтверждённые изменения';
  if (editorEls.confirmationDetail) editorEls.confirmationDetail.textContent = confirmed
    ? `Зафиксирована версия ${Math.max(0, Number(videoEdit.revision || 0))}. Новые правки потребуют повторного подтверждения.`
    : 'Проверь результат и подтверди монтаж перед отправкой.';
  if (editorEls.confirm) editorEls.confirm.textContent = confirmed ? 'Проверить ещё раз' : 'Подтвердить монтаж';
  if (editorEls.commandbarState) editorEls.commandbarState.textContent = confirmed
    ? `Версия ${Math.max(0, Number(videoEdit.revision || 0))} подтверждена`
    : 'Есть неподтверждённые изменения';
}

function videoEditConfirmationReport() {
  const duration = editedOutputDuration();
  const sourceDuration = videoDuration();
  const explicitClips = Array.isArray(videoEdit.clips) ? videoEdit.clips : null;
  const clips = explicitClips ? explicitClips.length : Math.max(1, (videoEdit.splits || []).length + 1);
  const effects = (videoEdit.freezeFrames || []).length +
    (videoEdit.zoomKeyframes || []).length + (videoEdit.footageOverlays || []).length;
  const issues = [];
  const error = (code, text) => issues.push({ code, text, severity:'error' });
  const warning = (code, text) => issues.push({ code, text, severity:'warning' });
  if (!videoUrl) error('missing_video', 'Исходное видео недоступно. Загрузи его заново.');
  if (!Number.isFinite(duration) || duration < 0.2) error('empty_timeline', 'На таймлайне не осталось воспроизводимого видео.');
  if (!clips) error('missing_clips', 'На таймлайне нет ни одного клипа.');
  if (videoEdit.audio?.muted) warning('muted_audio', 'Звук видео выключен. Проверь, что это сделано намеренно.');
  if (explicitClips) {
    const ids = new Set();
    explicitClips.forEach((clip, index) => {
      const start = Number(clip?.sourceStart);
      const end = Number(clip?.sourceEnd);
      if (!clip?.id || ids.has(clip.id)) error('duplicate_clip', `Клип ${index + 1} имеет повреждённый идентификатор.`);
      ids.add(clip?.id);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > sourceDuration || end - start < Math.max(0.05, frameStep())) {
        error('invalid_clip', `Клип ${index + 1} имеет некорректные границы. Поправь его обрезку.`);
      }
    });
  }
  const timelineEffects = [
    ...(videoEdit.zoomKeyframes || []).map(item => ({ ...item, label:'Зум' })),
    ...(videoEdit.footageOverlays || []).map(item => ({ ...item, label:'Футаж' })),
  ];
  timelineEffects.forEach(item => {
    const start = effectOutputStart(item);
    const itemDuration = Number(item.duration || 0);
    if (!Number.isFinite(start) || !Number.isFinite(itemDuration) || itemDuration <= 0 || start >= duration || start + itemDuration > duration + 0.001) {
      error('effect_outside', `${item.label} выходит за пределы итогового ролика. Перемести или сократи эффект.`);
    }
  });
  if ((videoEdit.footageOverlays || []).some(item => !item.url)) error('missing_footage', 'Есть футаж без доступного файла. Добавь его заново или удали блок.');
  if (explicitClips) {
    (videoEdit.freezeFrames || []).forEach(freeze => {
      const at = Number(freeze.at);
      const belongsToClip = explicitClips.some((clip, index) => at >= Number(clip.sourceStart) && (
        at < Number(clip.sourceEnd) || (index === explicitClips.length - 1 && at <= Number(clip.sourceEnd))
      ));
      if (!belongsToClip) error('orphan_freeze', 'Стоп-кадр больше не относится ни к одному клипу. Перемести или удали его.');
    });
  }
  if (timelineDrag || footageStageDrag || freezeDrawingPointer) error('active_edit', 'Заверши текущее действие на монтажном столе.');
  return { duration, clips, effects, issues, blocking:issues.some(item => item.severity === 'error') };
}

function closeVideoEditConfirmation() {
  if (!editorEls.confirmModal) return;
  editorEls.confirmModal.hidden = true;
  document.body.classList.remove('editor-confirm-open');
  videoEditConfirmationReturnFocus?.focus?.();
  videoEditConfirmationReturnFocus = null;
}

function openVideoEditConfirmation() {
  if (!editorEls.confirmModal) return;
  stopOutputPlayback({ keepPreview: true });
  clearFreezeHold();
  const report = videoEditConfirmationReport();
  videoEditConfirmationReturnFocus = document.activeElement;
  if (editorEls.confirmFacts) editorEls.confirmFacts.innerHTML = `
    <div class="editor-confirm-fact"><b>${fmtTime(report.duration)}</b><span>итоговая длительность</span></div>
    <div class="editor-confirm-fact"><b>${report.clips}</b><span>фрагментов видео</span></div>
    <div class="editor-confirm-fact"><b>${report.effects}</b><span>элементов монтажа</span></div>`;
  if (editorEls.confirmChecks) editorEls.confirmChecks.innerHTML = [
    '<div class="editor-confirm-check">Черновик монтажа сохранён локально.</div>',
    '<div class="editor-confirm-check">Текущая ревизия будет зафиксирована для отправки.</div>',
    ...report.issues.map(issue => `<div class="editor-confirm-check ${issue.severity}">${esc(issue.text)}</div>`),
  ].join('');
  editorEls.confirmCommit.disabled = report.blocking;
  editorEls.confirmModal.hidden = false;
  document.body.classList.add('editor-confirm-open');
  requestAnimationFrame(() => editorEls.confirmCommit?.focus());
}

function confirmVideoEdit() {
  const report = videoEditConfirmationReport();
  if (report.blocking) {
    toast(report.issues.find(item => item.severity === 'error')?.text || 'Исправь ошибки монтажа перед подтверждением', 'w');
    return;
  }
  videoEdit = normalizedVideoEdit();
  videoEdit.confirmation = {
    status: 'confirmed',
    confirmedRevision: Math.max(0, Number(videoEdit.revision || 0)),
    confirmedAt: Date.now(),
  };
  videoEdit.projectV3 = migrateVideoEditToProjectV3(videoEdit, videoDuration());
  saveModeratorVideoEditBackup();
  rememberCommittedVideoEdit();
  renderVideoEditor();
  _saveDraft();
  closeVideoEditConfirmation();
  toast('Монтаж подтверждён', 's');
}

editorEls.confirm?.addEventListener('click', openVideoEditConfirmation);
editorEls.confirmClose?.addEventListener('click', closeVideoEditConfirmation);
editorEls.confirmBack?.addEventListener('click', closeVideoEditConfirmation);
editorEls.confirmCommit?.addEventListener('click', confirmVideoEdit);
editorEls.confirmModal?.addEventListener('click', event => {
  if (event.target === editorEls.confirmModal) closeVideoEditConfirmation();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && editorEls.confirmModal && !editorEls.confirmModal.hidden) {
    event.preventDefault();
    closeVideoEditConfirmation();
  } else if (event.key === 'Escape' && editorEls.playerWrap?.classList.contains('video-editor-fullscreen')) {
    event.preventDefault();
    setVideoEditorFullscreen(false);
  }
});
function deleteSelectedEditorItem() {
  if (!selectedEditorItem) { toast('Сначала выбери блок на таймлайне', 'i'); return; }
  if (selectedEditorItem.type === 'effectTrack') {
    removeEffectTrack(selectedEditorItem.track);
    return;
  }
  if (selectedEditorItem.type === 'clip') {
    const clips = Array.isArray(videoEdit.clips) ? videoEdit.clips : [];
    if (clips.length <= 1) { toast('Нельзя удалить единственный клип', 'w'); return; }
    const index = clips.findIndex(clip => clip.id === selectedEditorItem.id);
    if (index < 0) return;
    const removedClip = clips[index];
    const segments = buildTimelineSegments().filter(segment => segment.clipId === removedClip.id);
    const outputStart = segments.length ? Math.min(...segments.map(segment => segment.outputStart)) : 0;
    const outputEnd = segments.length ? Math.max(...segments.map(segment => segment.outputStart + segment.duration)) : outputStart;
    const removedDuration = Math.max(0, outputEnd - outputStart);
    const ripple = items => (items || []).filter(item => {
      const itemStart = effectOutputStart(item);
      return itemStart < outputStart || itemStart >= outputEnd;
    }).map(item => {
      const itemStart = effectOutputStart(item);
      if (itemStart < outputEnd) return item;
      const outputAt = Math.max(0, itemStart - removedDuration);
      return { ...item, outputAt };
    });
    pushVideoEditUndo();
    videoEdit.clips = clips.filter(clip => clip.id !== removedClip.id);
    videoEdit.zoomKeyframes = ripple(videoEdit.zoomKeyframes);
    videoEdit.footageOverlays = ripple(videoEdit.footageOverlays);
    videoEdit.freezeFrames = (videoEdit.freezeFrames || []).filter(freeze => {
      const belongsToRemoved = freeze.at >= Number(removedClip.sourceStart) && (
        freeze.at < Number(removedClip.sourceEnd) || (index === clips.length - 1 && freeze.at <= Number(removedClip.sourceEnd))
      );
      return !belongsToRemoved;
    });
    selectedEditorItem = null;
    toast(`Клип удалён, таймлайн сдвинут на ${fmtTime(removedDuration)}`, 's');
    saveVideoEdit();
    return;
  }
  if (selectedEditorItem.type === 'freeze') {
    const removedId = selectedEditorItem.id;
    pushVideoEditUndo();
    videoEdit.freezeFrames = (videoEdit.freezeFrames || []).filter(item => item.id !== removedId);
    freezeFrameImages.delete(removedId);
    if (freezeDrawingVisibleId === removedId) setFreezeOverlay('');
    selectedEditorItem = null;
    toast('Стоп-кадр удалён', 's');
    saveVideoEdit();
    return;
  }
  if (selectedEditorItem.type === 'zoom') {
    pushVideoEditUndo();
    videoEdit.zoomKeyframes = (videoEdit.zoomKeyframes || []).filter(item => item.id !== selectedEditorItem.id);
    selectedEditorItem = null;
    toast('Зум удалён', 's');
    saveVideoEdit();
    return;
  }
  if (selectedEditorItem.type === 'footage') {
    pushVideoEditUndo();
    videoEdit.footageOverlays = (videoEdit.footageOverlays || []).filter(item => item.id !== selectedEditorItem.id);
    selectedEditorItem = null;
    toast('Футаж удалён', 's');
    saveVideoEdit();
    return;
  }
  if (selectedEditorItem.type === 'split') {
    pushVideoEditUndo();
    videoEdit.splits = (videoEdit.splits || []).filter(t => Math.abs(t - selectedEditorItem.at) >= 0.11);
    selectedEditorItem = null;
    toast('Разрез удалён', 's');
    saveVideoEdit();
  }
}
document.getElementById('edit-delete-selected')?.addEventListener('click', deleteSelectedEditorItem);
function moveSelectedVideoClip(direction) {
  if (selectedEditorItem?.type !== 'clip' || !Array.isArray(videoEdit.clips)) return;
  const index = videoEdit.clips.findIndex(clip => clip.id === selectedEditorItem.id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= videoEdit.clips.length) return;
  pushVideoEditUndo();
  const clips = [...videoEdit.clips];
  [clips[index], clips[target]] = [clips[target], clips[index]];
  videoEdit.clips = clips;
  saveVideoEdit();
  toast(direction < 0 ? 'Клип перемещён влево' : 'Клип перемещён вправо', 's');
}
document.getElementById('edit-clip-left')?.addEventListener('click', () => moveSelectedVideoClip(-1));
document.getElementById('edit-clip-right')?.addEventListener('click', () => moveSelectedVideoClip(1));
document.getElementById('edit-zoom')?.addEventListener('click', () => {
  addZoomAt(vidPlayer.currentTime);
});
document.getElementById('edit-add-effect-track')?.addEventListener('click', () => {
  videoEdit.effectTracks = Math.max(1, Math.min(8, Number(videoEdit.effectTracks || 1) + 1));
  activeEffectTrack = videoEdit.effectTracks - 1;
  selectedEditorItem = { type: 'effectTrack', track: activeEffectTrack };
  toast(`Добавлена дорожка эффектов ${videoEdit.effectTracks}`, 's');
  saveVideoEdit();
});
function removeEffectTrack(track = activeEffectTrack) {
  const trackCount = Math.max(1, Number(videoEdit.effectTracks || 1));
  const removeTrack = Math.max(0, Math.min(trackCount - 1, Number(track || 0)));
  if (trackCount <= 1) {
    toast('Нельзя удалить последнюю дорожку эффектов', 'i');
    return;
  }
  pushVideoEditUndo();
  videoEdit.zoomKeyframes = (videoEdit.zoomKeyframes || [])
    .filter(item => Number(item.track || 0) !== removeTrack)
    .map(item => ({
      ...item,
      track: Number(item.track || 0) > removeTrack ? Number(item.track || 0) - 1 : Number(item.track || 0),
    }));
  videoEdit.footageOverlays = (videoEdit.footageOverlays || [])
    .filter(item => Number(item.track || 0) !== removeTrack)
    .map(item => ({
      ...item,
      track: Number(item.track || 0) > removeTrack ? Number(item.track || 0) - 1 : Number(item.track || 0),
    }));
  videoEdit.effectTracks = trackCount - 1;
  activeEffectTrack = Math.max(0, Math.min(videoEdit.effectTracks - 1, removeTrack));
  selectedEditorItem = { type: 'effectTrack', track: activeEffectTrack };
  toast(`Дорожка эффектов ${removeTrack + 1} удалена`, 's');
  saveVideoEdit();
}
document.getElementById('edit-remove-effect-track')?.addEventListener('click', () => {
  removeEffectTrack(activeEffectTrack);
});
function readVideoMetadata(file) {
  return new Promise(resolve => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    let settled = false;
    let timeout;
    let dimensions = { width: 0, height: 0 };
    let containerDuration = 0;
    const done = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const finishWhenDurationIsReady = () => {
      dimensions = {
        width: Number(video.videoWidth || dimensions.width || 0),
        height: Number(video.videoHeight || dimensions.height || 0),
      };
      const nativeDuration = Number(video.duration);
      const duration = Number.isFinite(nativeDuration) && nativeDuration > 0
        ? nativeDuration
        : containerDuration;
      if (!Number.isFinite(duration) || duration <= 0) return false;
      done({ duration, ...dimensions });
      return true;
    };
    file.arrayBuffer()
      .then(buffer => {
        containerDuration = parseIsoBmffDuration(buffer);
        finishWhenDurationIsReady();
      })
      .catch(() => {});
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      if (finishWhenDurationIsReady()) return;
      // Some MP4 files expose Infinity until the browser probes their end.
      // Seeking the detached metadata player makes Chromium resolve the real duration.
      try { video.currentTime = Number.MAX_SAFE_INTEGER; } catch (_) {}
    };
    video.ondurationchange = finishWhenDurationIsReady;
    video.oncanplay = finishWhenDurationIsReady;
    video.onerror = () => done({ duration: 0, width: 0, height: 0 });
    timeout = setTimeout(() => done({ duration: containerDuration, ...dimensions }), 8000);
    video.src = url;
    video.load();
  });
}
function readVideoUrlMetadata(url) {
  return new Promise(resolve => {
    const video = document.createElement('video');
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    video.preload = 'metadata';
    video.crossOrigin = 'anonymous';
    video.onloadedmetadata = () => done({
      duration: Number.isFinite(video.duration) ? video.duration : 0,
    });
    video.onerror = () => done({ duration: 0 });
    video.src = url;
    setTimeout(() => done({ duration: 0 }), 3500);
  });
}
function addFootageOverlay({ url, name, duration, chromaKey = null }) {
  const outputDuration = editedOutputDuration() || videoDuration();
  const outputAt = clampOutputTime(currentOutputTime());
  const currentAt = outputToSourceTime(outputAt);
  const at = Math.round(clampTime(currentAt) * 10) / 10;
  const clipDuration = Math.max(0.2, Math.min(60, Number(duration || 2), Math.max(0.2, outputDuration - outputAt)));
  const track = Math.max(0, Math.min((videoEdit.effectTracks || 1) - 1, activeEffectTrack));
  const id = `footage_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  videoEdit.footageOverlays = [
    ...(videoEdit.footageOverlays || []),
    {
      id, url, name, at, outputAt, duration: clipDuration, track,
      muted: true, posX: 50, posY: 50, scale: 0.35,
      ...(chromaKey ? { chromaKey: normalizeChromaKey(chromaKey) } : {}),
    },
  ];
  selectedEditorItem = { type: 'footage', id };
  activeEffectTrack = track;
  setEditorMode('effects');
  toast('Футаж добавлен на таймлайн', 's');
  saveVideoEdit();
}
const BUILT_IN_FOOTAGE = Object.freeze([
  { id:'pulse-circle', name:'Импульс способности', description:'Подсветить бросок или активацию умения.', tag:'Акцент', url:'/assets/footage/pulse-circle.mp4', preview:'/assets/footage/pulse-circle-preview.mp4', duration:2 },
  { id:'tactical-scan', name:'Тактический скан', description:'Показать траекторию, позицию или участок карты.', tag:'Инфо', url:'/assets/footage/tactical-scan.mp4', preview:'/assets/footage/tactical-scan-preview.mp4', duration:2 },
  { id:'target-lock', name:'Захват цели', description:'Зафиксировать точку прицела или место приземления.', tag:'Прицел', url:'/assets/footage/target-lock.mp4', preview:'/assets/footage/target-lock-preview.mp4', duration:2 },
  { id:'danger-frame', name:'Опасная зона', description:'Выделить ошибку, угрозу или опасный тайминг.', tag:'Alert', url:'/assets/footage/danger-frame.mp4', preview:'/assets/footage/danger-frame-preview.mp4', duration:2 },
  { id:'speed-streaks', name:'Рывок', description:'Подчеркнуть быстрый выход, пик или переход.', tag:'Motion', url:'/assets/footage/speed-streaks.mp4', preview:'/assets/footage/speed-streaks-preview.mp4', duration:2 },
]);

function footageLibraryShell(content) {
  return `<div class="footage-library-backdrop" data-footage-close></div>
    <section class="footage-library-dialog" role="dialog" aria-modal="true" aria-labelledby="footage-library-title">
      <header class="footage-library-head">
        <div><span class="footage-library-kicker">VLineups effects</span><h3 class="footage-library-title" id="footage-library-title">Выбери футаж</h3><p>Он появится на активной дорожке с позиции курсора.</p></div>
        <div class="footage-library-actions"><button class="btn-sm" type="button" data-footage-upload-new>Загрузить свой</button><button class="footage-library-close" type="button" data-footage-close aria-label="Закрыть библиотеку">×</button></div>
      </header>
      <nav class="footage-library-tabs" aria-label="Разделы библиотеки"><button type="button" class="active" data-footage-tab="built-in">Встроенные</button><button type="button" data-footage-tab="materials">Мои материалы</button></nav>
      <div class="footage-library-body">${content}</div>
    </section>`;
}

function builtInFootageHtml() {
  return `<div class="footage-library-section" data-footage-section="built-in"><div class="footage-library-list built-in-list">${BUILT_IN_FOOTAGE.map(item => `
    <article class="footage-library-item built-in">
      <div class="footage-library-preview"><video src="${item.preview}" muted loop autoplay playsinline preload="metadata"></video><span>${esc(item.tag)}</span></div>
      <div class="footage-library-item-copy"><strong>${esc(item.name)}</strong><p>${esc(item.description)}</p><small>Анимация · ${item.duration} сек. · фон удалится автоматически</small></div>
      <button class="footage-library-add" type="button" data-built-in-footage="${item.id}">+ Добавить</button>
    </article>`).join('')}</div></div>`;
}

function renderFootageLibrary() {
  if (!editorEls.footageLibrary) return;
  const builtInHtml = builtInFootageHtml();
  let materialsHtml = '<div class="empty-state"><strong>Загрузка материалов…</strong>Сейчас подтянем опубликованные футажи.</div>';
  if (authorMaterialsError) {
    materialsHtml = `<div class="empty-state"><strong>Не удалось загрузить материалы</strong>${esc(authorMaterialsError)}</div>`;
  } else if (authorMaterialsLoaded) {
    const materials = (isCurrentUserAdmin() ? authorMaterials : authorMaterials.filter(item => item.is_published !== false)).filter(item => String(item.video_url || '').trim());
    materialsHtml = materials.length ? `<div class="footage-library-material-head"><span>Опубликованные материалы</span><button class="btn-sm" type="button" data-footage-refresh>Обновить</button></div><div class="footage-library-list material-list">${materials.map(item => `
      <article class="footage-library-item"><div class="footage-library-item-copy"><strong>${esc(firstText(item.title, item.video_file_name, 'Футаж'))}</strong><p>${esc(firstText(item.description, item.video_file_name, 'Готовый материал'))}</p></div><button class="footage-library-add" type="button" data-footage-material="${esc(item.id || '')}">+ Добавить</button></article>`).join('')}</div>` : '<div class="empty-state"><strong>Здесь пока пусто</strong>Загрузи свой файл — он сразу появится на таймлайне.</div>';
  } else if (!authorMaterialsLoading) {
    loadAuthorMaterials();
  }
  editorEls.footageLibrary.innerHTML = footageLibraryShell(`${builtInHtml}<div class="footage-library-section" data-footage-section="materials" hidden>${materialsHtml}</div>`);
}
function closeFootageLibrary() {
  if (!editorEls.footageLibrary || editorEls.footageLibrary.hidden) return;
  editorEls.footageLibrary.hidden = true;
  editorEls.footageLibrary.querySelectorAll('video').forEach(video => video.pause());
  document.body.classList.remove('footage-library-open');
}
function openFootageLibrary() {
  if (!videoUrl) { toast('Сначала загрузи основное видео', 'i'); return; }
  setEditorMode('effects');
  if (!editorEls.footageLibrary) return;
  editorEls.footageLibrary.hidden = false;
  document.body.classList.add('footage-library-open');
  renderFootageLibrary();
}
async function addMaterialFootageToTimeline(id) {
  const material = authorMaterials.find(item => item.id === id);
  const url = String(material?.video_url || '').trim();
  if (!url) { toast('У материала нет видео', 'e'); return; }
  if (editorEls.footageStatus) editorEls.footageStatus.textContent = 'Добавляем материал...';
  const meta = await readVideoUrlMetadata(url);
  if (editorEls.footageStatus) editorEls.footageStatus.textContent = '';
  addFootageOverlay({
    url,
    name: firstText(material.title, material.video_file_name, 'Футаж'),
    duration: meta.duration || 2,
  });
}
async function handleFootageFile(file) {
  if (!isVideoFile(file)) { toast('Выбери .mp4, .mov или .webm футаж', 'e'); return; }
  if (file.size > 50 * 1024 * 1024) { toast('Футаж превышает 50 МБ', 'e'); return; }
  const previewWarning = transparentPreviewWarning(file.name);
  if (previewWarning) toast(previewWarning, 'w');
  if (editorEls.footageStatus) editorEls.footageStatus.textContent = previewWarning || 'Подготовка футажа...';
  const meta = await readVideoMetadata(file);
  const upload = uploadVideoToSelectel(file, pct => {
    if (editorEls.footageStatus) editorEls.footageStatus.textContent = `Футаж ${Math.round(pct * 100)}%`;
  });
  try {
    const url = await upload;
    if (editorEls.footageStatus) editorEls.footageStatus.textContent = '';
    addFootageOverlay({
      url,
      name: file.name.replace(/\.[^.]+$/, '') || 'Футаж',
      duration: meta.duration || 2,
    });
    closeFootageLibrary();
  } catch (error) {
    if (editorEls.footageStatus) editorEls.footageStatus.textContent = '';
    if (error?.message !== 'canceled') toast('Ошибка загрузки футажа: ' + (error?.message || error), 'e');
  } finally {
    if (editorEls.footageInput) editorEls.footageInput.value = '';
  }
}
document.getElementById('edit-add-footage')?.addEventListener('click', openFootageLibrary);
editorEls.footageLibrary?.addEventListener('click', event => {
  const materialBtn = event.target.closest('[data-footage-material]');
  const builtInBtn = event.target.closest('[data-built-in-footage]');
  const refreshBtn = event.target.closest('[data-footage-refresh]');
  const uploadBtn = event.target.closest('[data-footage-upload-new]');
  const closeBtn = event.target.closest('[data-footage-close]');
  const tabBtn = event.target.closest('[data-footage-tab]');
  if (closeBtn) { closeFootageLibrary(); return; }
  if (tabBtn) {
    const tab = tabBtn.dataset.footageTab;
    editorEls.footageLibrary.querySelectorAll('[data-footage-tab]').forEach(button => button.classList.toggle('active', button === tabBtn));
    editorEls.footageLibrary.querySelectorAll('[data-footage-section]').forEach(section => { section.hidden = section.dataset.footageSection !== tab; });
    return;
  }
  const builtIn = BUILT_IN_FOOTAGE.find(item => item.id === builtInBtn?.dataset.builtInFootage);
  if (builtIn) {
    addFootageOverlay({
      url: builtIn.url,
      name: builtIn.name,
      duration: builtIn.duration,
      chromaKey: { enabled: true, color: '#00ff00', strength: 0.35 },
    });
    closeFootageLibrary();
  }
  if (materialBtn) { addMaterialFootageToTimeline(materialBtn.dataset.footageMaterial || ''); closeFootageLibrary(); }
  if (refreshBtn) loadAuthorMaterials({ force: true });
  if (uploadBtn) editorEls.footageInput?.click();
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeFootageLibrary(); });
editorEls.footageInput?.addEventListener('change', () => {
  const file = editorEls.footageInput.files?.[0];
  if (file) handleFootageFile(file);
});
function addZoomAt(time, { silent = false } = {}) {
  const outputAt = clampOutputTime(currentOutputTime());
  const at = Math.round(clampTime(outputToSourceTime(outputAt)) * 10) / 10;
  const track = Math.max(0, Math.min((videoEdit.effectTracks || 1) - 1, activeEffectTrack));
  const scale = Math.max(1, Math.min(EDITOR_MAX_ZOOM, Number(editorEls.zoomScaleX?.value || editorEls.zoomScaleY?.value || 1.4)));
  const scaleX = scale;
  const scaleY = scale;
  const posX = Math.max(-100, Math.min(100, Number(editorEls.zoomPosX?.value || 0)));
  const posY = Math.max(-100, Math.min(100, Number(editorEls.zoomPosY?.value || 0)));
  const rotation = Math.max(-45, Math.min(45, Number(editorEls.zoomRotation?.value || 0)));
  const anchorX = Math.max(0, Math.min(100, Number(editorEls.zoomAnchorX?.value || 50)));
  const anchorY = Math.max(0, Math.min(100, Number(editorEls.zoomAnchorY?.value || 50)));
  const id = `zoom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  videoEdit.zoomKeyframes = [
    ...(videoEdit.zoomKeyframes || []).filter(item => Number(item.track || 0) !== track || Math.abs(effectOutputStart(item) - outputAt) >= 0.11),
    { id, at, outputAt, scale: Math.max(scaleX, scaleY), scaleX, scaleY, posX, posY, rotation, anchorX, anchorY, duration: 2, track },
  ];
  selectedEditorItem = { type: 'zoom', id };
  activeEffectTrack = track;
  setEditorMode('zoom');
  vidPlayer.currentTime = at;
  if (!silent) toast(`Зум ${scaleX.toFixed(2)}x/${scaleY.toFixed(2)}x на 2 сек добавлен`, 's');
  saveVideoEdit();
}
editorEls.undo?.addEventListener('click', undoVideoEdit);
editorEls.redo?.addEventListener('click', redoVideoEdit);
document.getElementById('edit-reset')?.addEventListener('click', resetVideoEdit);

function isVideoFile(file) {
  return file && (
    file.type.startsWith('video/') ||
    /\.(mp4|mov|webm)$/i.test(file.name)
  );
}

async function handleVideoFile(file) {
  if (!isVideoFile(file)) { toast('Выбери видеофайл', 'e'); return; }
  if (file.size > 50 * 1024 * 1024) { toast('Видео превышает 50 МБ', 'e'); return; }
  const localMetadata = await readVideoMetadata(file);
  if (localMetadata.width !== 1920 || localMetadata.height !== 1080) {
    const actualSize = localMetadata.width && localMetadata.height
      ? ` Загружено: ${localMetadata.width}×${localMetadata.height}.`
      : '';
    toast(`Видео должно быть записано строго в 1920×1080 (Full HD).${actualSize}`, 'e');
    return;
  }
  resetVideoViewerZoom();
  pendingVideoSeekRatio = null;
  if (videoXhr) { videoXhr.abort(); videoXhr = null; }
  releaseLocalVideoPreview();
  localVideoPreviewUrl = URL.createObjectURL(file);
  knownVideoDuration = 0;
  syncKnownVideoDuration(localMetadata.duration);
  videoUrl = null;
  dropZone.style.display = 'none';
  document.getElementById('vid-player-wrap').style.display = 'none';
  const prog = document.getElementById('vid-upload-progress');
  prog.style.display = '';
  document.getElementById('vid-pct').textContent = '0%';
  document.getElementById('vid-prog').style.width = '0%';

  const upload = uploadCompatibleLineupVideo(file, pct => {
    const p = Math.round(pct * 100);
    document.getElementById('vid-pct').textContent = p + '%';
    document.getElementById('vid-prog').style.width = p + '%';
  });
  videoXhr = upload;

  let _cancelled = false;
  document.getElementById('vid-cancel-btn').onclick = () => {
    _cancelled = true;
    upload.abort();
    prog.style.display = 'none';
    dropZone.style.display = '';
    videoUrl = null; videoXhr = null;
    releaseLocalVideoPreview();
    knownVideoDuration = 0;
    videoEdit = createDefaultVideoEdit();
    rememberCommittedVideoEdit();
    validateForm();
  };

  try {
    const url = await upload;
    if (_cancelled) return;
    videoUrl = url;
    moderatorVideoRemovalRequested = false;
    videoXhr = null;
    prog.style.display = 'none';
    vidPlayer.dataset.corsFallback = '0';
    vidPlayer.dataset.proxyRetry = '0';
    vidPlayer.dataset.videoErrorReported = '0';
    // Use the original local file during this editing session. A just-created
    // Cloudinary transformation can start rendering frames before its MP4
    // duration/index is available, which leaves native controls at 0:00.
    vidPlayer.removeAttribute('crossorigin');
    vidPlayer.src = localVideoPreviewUrl || videoEditorSourceUrl(url);
    vidPlayer.load();
    document.getElementById('vid-player-wrap').style.display = '';
    videoEdit = createDefaultVideoEdit();
    videoEditUndoStack = [];
    videoEditRedoStack = [];
    writeVideoEditHistory();
    rememberCommittedVideoEdit();
    toast('Видео загружено ✅', 's');
    validateForm(); _saveDraft();
    renderVideoEditor();
  } catch (e) {
    if (e.message === 'canceled') return;
    videoXhr = null;
    prog.style.display = 'none';
    dropZone.style.display = '';
    releaseLocalVideoPreview();
    knownVideoDuration = 0;
    toast('Ошибка загрузки: ' + e.message, 'e');
  }
}

vidPlayer.addEventListener('timeupdate', () => {
  if (!vidPlayer.duration) return;
  const editorExpanded = editorEls.toggle?.getAttribute('aria-expanded') !== 'false';
  const start = editorExpanded ? (videoEdit.trimStart || 0) : 0;
  const end = editorExpanded ? (videoEdit.trimEnd || vidPlayer.duration) : vidPlayer.duration;
  if (vidPlayer.currentTime < start) vidPlayer.currentTime = start;
  if (vidPlayer.currentTime > end) {
    if (outputPlaybackActive) stopOutputPlayback({ keepPreview: true });
    else vidPlayer.pause();
    // Keep the playhead at the end. Rewinding here made short clips appear to
    // "jump back" a second after playback started and prevented frame capture.
    vidPlayer.currentTime = Math.max(start, Math.min(end, vidPlayer.duration || end));
    playedFreezeHolds.clear();
  }
  updateTimelinePlaybackUi();
  lastVideoTime = vidPlayer.currentTime;
});
function handleVideoDurationReady() {
  syncKnownVideoDuration(vidPlayer.duration);
  if (pendingVideoSeekRatio !== null && videoDuration() > 0) {
    vidScrubber.value = String(pendingVideoSeekRatio * 100);
    pendingVideoSeekRatio = null;
    seekFromScrubberValue();
    return;
  }
  renderVideoEditor();
}
vidPlayer.addEventListener('loadedmetadata', handleVideoDurationReady);
vidPlayer.addEventListener('durationchange', handleVideoDurationReady);
vidPlayer.addEventListener('loadeddata', handleVideoDurationReady);
vidPlayer.addEventListener('canplay', handleVideoDurationReady);
vidPlayer.addEventListener('error', () => {
  // Storage itself does not expose CORS. Never switch to its direct URL:
  // retry the same-origin proxy once so playback and frame capture stay valid.
  if (videoUrl && vidPlayer.dataset.proxyRetry !== '1') {
    const current = Number.isFinite(vidPlayer.currentTime) ? vidPlayer.currentTime : 0;
    vidPlayer.dataset.proxyRetry = '1';
    vidPlayer.dataset.corsFallback = '0';
    vidPlayer.crossOrigin = 'anonymous';
    const proxyUrl = videoEditorSourceUrl(videoUrl);
    vidPlayer.src = `${proxyUrl}${proxyUrl.includes('?') ? '&' : '?'}retry=${Date.now()}`;
    vidPlayer.load();
    vidPlayer.addEventListener('loadedmetadata', () => {
      if (current > 0 && vidPlayer.duration) {
        vidPlayer.currentTime = Math.min(current, Math.max(0, vidPlayer.duration - 0.05));
      }
      renderVideoEditor();
    }, { once: true });
    return;
  }
  if (vidPlayer.dataset.videoErrorReported !== '1') {
    vidPlayer.dataset.videoErrorReported = '1';
    toast('Видео не загрузилось через защищённый прокси. Обнови страницу через несколько секунд.', 'e');
  }
});
vidPlayer.addEventListener('play',  () => {
  if (!outputPlaybackActive) {
    timelinePreviewOutputTime = null;
    setFreezeOverlay('');
    outputPlaybackTime = null;
  }
  vidPlayBtn.textContent = '⏸';
  if (fullscreenVidPlayBtn) fullscreenVidPlayBtn.textContent = '⏸';
  lastVideoTime = vidPlayer.currentTime;
  if (!outputPlaybackActive) startSmoothTimelineUi();
});
vidPlayer.addEventListener('pause', () => {
  if (!outputPlaybackActive) vidPlayBtn.textContent = '▶';
  if (!outputPlaybackActive && fullscreenVidPlayBtn) fullscreenVidPlayBtn.textContent = '▶';
  stopSmoothTimelineUi();
  updateTimelinePlaybackUi();
});
vidPlayer.addEventListener('seeking', () => {
  clearFreezeHold();
  if (!outputPlaybackActive) outputPlaybackTime = null;
  lastVideoTime = vidPlayer.currentTime;
  updateTimelinePlaybackUi({ keepVisible: true });
});
function seekFromScrubberValue() {
  const editorExpanded = editorEls.toggle?.getAttribute('aria-expanded') !== 'false';
  stopOutputPlayback({ keepPreview: false });
  clearFreezeHold();
  playedFreezeHolds.clear();
  const ratio = sharedScrubberToOutputTime(vidScrubber.value, Number(vidScrubber.max || 100), 1);
  const duration = editorExpanded ? editedOutputDuration() : videoDuration();
  if (!duration) {
    pendingVideoSeekRatio = ratio;
    return;
  }
  pendingVideoSeekRatio = null;
  setFreezeOverlay('');
  const targetTime = sharedScrubberToOutputTime(vidScrubber.value, Number(vidScrubber.max || 100), duration);
  if (!Number.isFinite(targetTime)) {
    pendingVideoSeekRatio = ratio;
    return;
  }
  if (editorExpanded) {
    showOutputFrame(targetTime);
    timelinePreviewOutputTime = targetTime;
  } else {
    timelinePreviewOutputTime = null;
    vidPlayer.currentTime = targetTime;
  }
  updateTimelinePlaybackUi();
}

function videoEditorSourceUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw, window.location.href);
    const proxyHosts = new Set([
      'd5adab93-7400-49ad-b1f9-66966c03d203.selstorage.ru',
      'valorant-lineups-video.s3.ru-3.storage.selcloud.ru',
    ]);
    return proxyHosts.has(parsed.hostname)
      ? `/api/valorant-proxy?url=${encodeURIComponent(parsed.href)}`
      : raw;
  } catch (_) {
    return raw;
  }
}

vidScrubber.addEventListener('input', seekFromScrubberValue);
fullscreenVidScrubber?.addEventListener('input', () => {
  vidScrubber.value = fullscreenVidScrubber.value;
  seekFromScrubberValue();
  renderVideoTransport();
});
fullscreenVidScrubber?.addEventListener('pointerdown', () => {
  scrubberDragging = true;
  scrubberResumePlayback = outputPlaybackActive || !vidPlayer.paused;
  if (outputPlaybackActive) stopOutputPlayback({ keepPreview: true });
  else if (scrubberResumePlayback) vidPlayer.pause();
});
vidScrubber.addEventListener('pointerdown', event => {
  scrubberDragging = true;
  scrubberResumePlayback = outputPlaybackActive || !vidPlayer.paused;
  if (outputPlaybackActive) stopOutputPlayback({ keepPreview: true });
  else if (scrubberResumePlayback) vidPlayer.pause();
});
const finishScrubberDrag = () => {
  if (!scrubberDragging) return;
  const resumeAt = currentOutputTime();
  scrubberDragging = false;
  updateTimelinePlaybackUi();
  if (scrubberResumePlayback) startOutputPlayback(resumeAt);
  scrubberResumePlayback = false;
};
vidScrubber.addEventListener('pointerup', finishScrubberDrag);
fullscreenVidScrubber?.addEventListener('pointerup', finishScrubberDrag);
const cancelScrubberDrag = () => {
  scrubberDragging = false;
  scrubberResumePlayback = false;
  updateTimelinePlaybackUi();
};
vidScrubber.addEventListener('pointercancel', cancelScrubberDrag);
window.addEventListener('pointerup', finishScrubberDrag);
window.addEventListener('pointercancel', cancelScrubberDrag);
vidPlayBtn.addEventListener('click', toggleEditorPlayback);
fullscreenVidPlayBtn?.addEventListener('click', toggleEditorPlayback);
vidMuteBtn?.addEventListener('click', () => { vidPlayer.muted = !vidPlayer.muted; });
vidVolume?.addEventListener('input', () => {
  vidPlayer.volume = Number(vidVolume.value);
  vidPlayer.muted = vidPlayer.volume === 0;
});
fullscreenVidMuteBtn?.addEventListener('click', () => { vidPlayer.muted = !vidPlayer.muted; });
fullscreenVidVolume?.addEventListener('input', () => {
  vidPlayer.volume = Number(fullscreenVidVolume.value);
  vidPlayer.muted = vidPlayer.volume === 0;
});
vidPlayer.addEventListener('volumechange', () => {
  if (vidVolume) vidVolume.value = String(vidPlayer.muted ? 0 : vidPlayer.volume);
  if (vidMuteBtn) {
    vidMuteBtn.textContent = vidPlayer.muted || vidPlayer.volume === 0 ? '🔇' : vidPlayer.volume < .5 ? '🔉' : '🔊';
    vidMuteBtn.setAttribute('aria-label', vidPlayer.muted ? 'Включить звук' : 'Выключить звук');
  }
  if (fullscreenVidVolume) fullscreenVidVolume.value = String(vidPlayer.muted ? 0 : vidPlayer.volume);
  if (fullscreenVidMuteBtn) {
    fullscreenVidMuteBtn.textContent = vidPlayer.muted || vidPlayer.volume === 0 ? '🔇' : vidPlayer.volume < .5 ? '🔉' : '🔊';
    fullscreenVidMuteBtn.setAttribute('aria-label', vidPlayer.muted ? 'Включить звук' : 'Выключить звук');
  }
});

// One player language for published lineups and author materials. The editor
// uses the same controls above, while keeping its timeline-specific behavior.
const unifiedVideoPlayers = new WeakMap();

function unifiedVideoTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
}

function enhanceUnifiedVideo(video) {
  if (!(video instanceof HTMLVideoElement) || unifiedVideoPlayers.has(video)) return;
  if (video.id === 'vid-player' || video.classList.contains('footage-preview-overlay')) return;
  const shell = document.createElement('div');
  shell.className = 'unified-video-player';
  shell.tabIndex = 0;
  shell.setAttribute('aria-label', 'Видеоплеер');
  video.parentNode.insertBefore(shell, video);
  shell.appendChild(video);
  video.controls = false;
  video.playsInline = true;
  video.classList.add('uvp-media');
  shell.insertAdjacentHTML('beforeend', `
    <button class="uvp-center-play" type="button" aria-label="Воспроизвести"><span>▶</span></button>
    <div class="uvp-buffer" hidden><i></i></div>
    <div class="uvp-controls">
      <input class="uvp-progress" type="range" min="0" max="1000" step="1" value="0" aria-label="Позиция видео">
      <div class="uvp-transport">
        <button class="uvp-icon-button uvp-play" type="button" aria-label="Воспроизвести">▶</button>
        <button class="uvp-skip" type="button" data-skip="-10" aria-label="Назад на 10 секунд">−10</button>
        <button class="uvp-skip" type="button" data-skip="10" aria-label="Вперёд на 10 секунд">+10</button>
        <output class="uvp-time">0:00 / 0:00</output>
        <span class="uvp-spacer"></span>
        <button class="uvp-icon-button uvp-mute" type="button" aria-label="Выключить звук">🔊</button>
        <input class="uvp-volume" type="range" min="0" max="1" step="0.05" value="1" aria-label="Громкость">
        <button class="uvp-icon-button uvp-fullscreen" type="button" aria-label="На весь экран">⛶</button>
      </div>
    </div>`);
  const play = shell.querySelector('.uvp-play');
  const centerPlay = shell.querySelector('.uvp-center-play');
  const progress = shell.querySelector('.uvp-progress');
  const time = shell.querySelector('.uvp-time');
  const mute = shell.querySelector('.uvp-mute');
  const volume = shell.querySelector('.uvp-volume');
  const buffer = shell.querySelector('.uvp-buffer');
  const toggle = () => video.paused ? video.play().catch(() => {}) : video.pause();
  const render = () => {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const ratio = duration ? video.currentTime / duration : 0;
    progress.value = String(Math.round(ratio * 1000));
    progress.style.setProperty('--uvp-progress', `${ratio * 100}%`);
    time.textContent = `${unifiedVideoTime(video.currentTime)} / ${unifiedVideoTime(duration)}`;
    const paused = video.paused || video.ended;
    play.textContent = paused ? '▶' : '❚❚';
    play.setAttribute('aria-label', paused ? 'Воспроизвести' : 'Пауза');
    centerPlay.classList.toggle('is-hidden', !paused);
    mute.textContent = video.muted || video.volume === 0 ? '🔇' : video.volume < .5 ? '🔉' : '🔊';
    volume.value = String(video.muted ? 0 : video.volume);
  };
  play.addEventListener('click', toggle);
  centerPlay.addEventListener('click', toggle);
  video.addEventListener('click', toggle);
  progress.addEventListener('input', () => {
    if (Number.isFinite(video.duration)) video.currentTime = Number(progress.value) / 1000 * video.duration;
    render();
  });
  shell.querySelectorAll('[data-skip]').forEach(button => button.addEventListener('click', () => {
    video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + Number(button.dataset.skip)));
  }));
  mute.addEventListener('click', () => { video.muted = !video.muted; });
  volume.addEventListener('input', () => {
    video.volume = Number(volume.value);
    video.muted = video.volume === 0;
  });
  shell.querySelector('.uvp-fullscreen').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement === shell) await document.exitFullscreen();
      else if (shell.requestFullscreen) await shell.requestFullscreen();
      else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
    } catch (_) {
      // Fullscreen may be denied by the browser or embedded context.
    }
  });
  shell.addEventListener('keydown', event => {
    if (event.target.matches('input')) return;
    if (event.code === 'Space') { event.preventDefault(); toggle(); }
    else if (event.key === 'ArrowLeft') video.currentTime = Math.max(0, video.currentTime - 5);
    else if (event.key === 'ArrowRight') video.currentTime = Math.min(video.duration || 0, video.currentTime + 5);
    else if (event.key.toLowerCase() === 'm') video.muted = !video.muted;
    else if (event.key.toLowerCase() === 'f') shell.querySelector('.uvp-fullscreen').click();
  });
  ['loadedmetadata', 'timeupdate', 'play', 'pause', 'ended', 'volumechange'].forEach(name => video.addEventListener(name, render));
  ['waiting', 'stalled'].forEach(name => video.addEventListener(name, () => { buffer.hidden = false; }));
  ['playing', 'canplay', 'seeked'].forEach(name => video.addEventListener(name, () => { buffer.hidden = true; }));
  unifiedVideoPlayers.set(video, { shell, render });
  render();
}

function enhanceUnifiedVideos(root = document) {
  root.querySelectorAll?.('video.detail-video, video.material-video').forEach(enhanceUnifiedVideo);
}

enhanceUnifiedVideos();
new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(node => {
  if (!(node instanceof Element)) return;
  if (node.matches?.('video.detail-video, video.material-video')) enhanceUnifiedVideo(node);
  enhanceUnifiedVideos(node);
}))).observe(document.body, { childList: true, subtree: true });
editorEls.stage?.addEventListener('dblclick', event => {
  if (event.target.closest('.video-player-fullscreen-controls,.video-player-fullscreen-close')) return;
  setVideoPlayerFullscreen(document.fullscreenElement !== editorEls.stage);
});
document.addEventListener('keydown', event => {
  if (document.fullscreenElement !== editorEls.stage || event.target.matches('input,textarea,select')) return;
  if (event.code === 'Space') { event.preventDefault(); toggleEditorPlayback(); }
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    const duration = editedOutputDuration() || videoDuration();
    const target = Math.max(0, Math.min(duration, currentOutputTime() + (event.key === 'ArrowRight' ? 5 : -5)));
    stopOutputPlayback({ keepPreview: false });
    showOutputFrame(target);
    renderVideoTransport();
  } else if (event.key.toLowerCase() === 'm') vidPlayer.muted = !vidPlayer.muted;
  else if (event.key.toLowerCase() === 'f') setVideoPlayerFullscreen(false);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    videoHiddenAt = Date.now();
    stopSmoothTimelineUi();
    stopChromaPreview();
    if (editorEls.footagePreview && !editorEls.footagePreview.paused) editorEls.footagePreview.pause();
    return;
  }
  const hiddenMs = videoHiddenAt ? Date.now() - videoHiddenAt : 0;
  reviveEditorVideo(hiddenMs > 5 * 60 * 1000 ? 'stale-visible' : 'visible');
  if (!vidPlayer.paused && !outputPlaybackActive) startSmoothTimelineUi();
  applyVideoEditPreview();
});
window.addEventListener('pageshow', event => {
  if (event.persisted) reviveEditorVideo('pageshow');
});
document.getElementById('vid-remove-btn').addEventListener('click', () => {
  stopOutputPlayback({ keepPreview: false });
  clearFreezeHold();
  releaseFootagePreviewResources({ releaseCanvas: true });
  timelinePreviewOutputTime = null;
  freezeFrameImages.clear();
  setFreezeOverlay('');
  resetVideoViewerZoom();
  vidPlayer.src = '';
  releaseLocalVideoPreview();
  knownVideoDuration = 0;
  videoUrl = null;
  if (moderatorDraftSourceId) moderatorVideoRemovalRequested = true;
  videoEdit = createDefaultVideoEdit();
  rememberCommittedVideoEdit();
  document.getElementById('vid-player-wrap').style.display = 'none';
  dropZone.style.display = '';
  vidInput.value = '';
  validateForm(); _saveDraft();
});

// Frame capture — pause first so the frame is stable, set crossOrigin before src
document.getElementById('vid-frame-btn').addEventListener('click', async () => {
  if (!vidPlayer.videoWidth) { toast('Видео ещё не готово', 'i'); return; }
  if (screenshots.length >= 5) { toast('Максимум 5 скриншотов', 'i'); return; }
  const btn = document.getElementById('vid-frame-btn');
  btn.disabled = true; btn.textContent = '⏳';
  try {
    vidPlayer.pause();
    await new Promise(r => setTimeout(r, 50));
    applyVideoEditPreview();
    const blob = await captureEditedVideoFrameBlob();
    if (!blob) throw new Error('Не удалось захватить кадр');
    const compressed = await compressImage(blob);
    const localUrl = URL.createObjectURL(blob);
    const entry = { localUrl, cloudUrl: null, uploading: true };
    screenshots.push(entry);
    renderScreenshots();
    const url = await uploadToCloudinary(compressed);
    entry.cloudUrl = url; entry.uploading = false;
    renderScreenshots(); _saveDraft();
    toast('Кадр добавлен ✅', 's');
  } catch (e) {
    toast('Ошибка: ' + e.message, 'e');
  } finally {
    btn.disabled = false; btn.textContent = '📷 Кадр';
  }
});

// Global keyboard shortcuts for video player
document.addEventListener('pointerdown', event => {
  const wrap = document.getElementById('vid-player-wrap');
  videoEditorHotkeysActive = !!(wrap && wrap.contains(event.target));
}, true);

function hasVideoForHotkeys() {
  const player = document.getElementById('vid-player');
  return !!(player && (player.currentSrc || player.src) && !player.error);
}

function isTextTypingTarget(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
  if (target.tagName !== 'INPUT') return false;
  const type = String(target.type || 'text').toLowerCase();
  return ['text', 'email', 'password', 'search', 'url', 'tel', 'number'].includes(type);
}

function handleVideoEditorSpace(event, shouldToggle) {
  const isSpace = event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar';
  if (!isSpace || !hasVideoForHotkeys()) return false;
  const wrap = document.getElementById('vid-player-wrap');
  const insideEditor = !!(wrap && wrap.contains(event.target));
  if (!insideEditor && !videoEditorHotkeysActive) return false;
  if (isTextTypingTarget(event.target) && !insideEditor) return false;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation?.();
  if (document.activeElement && document.activeElement !== document.body && !isTextTypingTarget(document.activeElement)) {
    document.activeElement.blur?.();
  }
  if (shouldToggle) {
    toggleEditorPlayback();
  }
  return true;
}

['keydown', 'keypress', 'keyup'].forEach(type => {
  window.addEventListener(type, event => {
    handleVideoEditorSpace(event, type === 'keydown');
  }, true);
});

document.addEventListener('keydown', e => {
  const target = e.target;
  const isSpace = e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar';
  const player = document.getElementById('vid-player');
  if (handleVideoEditorSpace(e, true)) return;
  const wrap = document.getElementById('vid-player-wrap');
  const insideEditor = !!(wrap && wrap.contains(target));
  const mapWrap = document.getElementById('map-wrap');
  const mapVisible = !!(mapWrap && mapWrap.offsetParent !== null);
  const mapRect = mapVisible ? mapWrap.getBoundingClientRect() : null;
  const mapInViewport = !!(mapRect && mapRect.bottom > 60 && mapRect.top < window.innerHeight);
  const noCommandModifiers = !e.ctrlKey && !e.metaKey && !e.altKey;
  if (!isTextTypingTarget(target) && !insideEditor && mapInViewport && noCommandModifiers) {
    if (e.code === 'Digit1' || e.code === 'Numpad1') {
      const positionButton = document.getElementById('mode-position');
      if (positionButton && positionButton.style.display !== 'none' && !positionButton.disabled) {
        e.preventDefault();
        e.stopPropagation();
        setMapMode('position');
        return;
      }
    }
    if (e.code === 'Digit2' || e.code === 'Numpad2') {
      const trajectoryButton = document.getElementById('mode-trajectory');
      if (trajectoryButton && trajectoryButton.style.display !== 'none' && !trajectoryButton.disabled) {
        e.preventDefault();
        e.stopPropagation();
        setMapMode('trajectory');
        return;
      }
    }
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.code === 'KeyZ' &&
      !isTextTypingTarget(target) && !insideEditor && mapVisible && mapMode === 'trajectory') {
    const points = activeTrajectoryPoints();
    if (points.length) {
      e.preventDefault();
      e.stopPropagation();
      window.undoTraj();
    }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.code === 'KeyB' &&
      !isTextTypingTarget(target) && (insideEditor || videoEditorHotkeysActive) && hasVideoForHotkeys()) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();
    splitVideoClipAtPlayhead();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyY' || (e.shiftKey && e.code === 'KeyZ')) &&
      !isTextTypingTarget(target) && (insideEditor || videoEditorHotkeysActive)) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();
    redoVideoEdit();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ' && (insideEditor || videoEditorHotkeysActive)) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();
    undoVideoEdit();
    return;
  }
  const isTyping = isTextTypingTarget(target);
  if (isTyping) return;
  if (!e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'KeyZ' &&
      (insideEditor || videoEditorHotkeysActive) && hasVideoForHotkeys()) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();
    resetVideoViewerZoom({ announce: videoViewerZoom.scale > 1.001 });
    return;
  }
  if ((e.code === 'Delete' || e.code === 'Backspace') && selectedEditorItem && (insideEditor || videoEditorHotkeysActive)) {
    e.preventDefault();
    e.stopPropagation();
    deleteSelectedEditorItem();
    return;
  }
  if (isSpace) {
    if (player && (player.currentSrc || player.src) && !player.error) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur?.();
      toggleEditorPlayback();
    }
  }
  if (e.code === 'ArrowRight') {
    if ((insideEditor || videoEditorHotkeysActive) && player && (player.currentSrc || player.src) && !player.error) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      stepEditorFrame(1);
    }
  }
  if (e.code === 'ArrowLeft') {
    if ((insideEditor || videoEditorHotkeysActive) && player && (player.currentSrc || player.src) && !player.error) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      stepEditorFrame(-1);
    }
  }
}, true);


// ── Screenshots ───────────────────────────────────────────────────────────────
document.getElementById('btn-add-shot').addEventListener('click', () => {
  if (screenshots.length >= 5) { toast('Максимум 5 скриншотов', 'i'); return; }
  document.getElementById('shot-file-input').click();
});
document.getElementById('shot-file-input').addEventListener('change', e => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  files.forEach(file => {
    if (screenshots.length >= 5) { toast('Максимум 5 скриншотов', 'i'); return; }
    if (!file.type.startsWith('image/')) return;
    const localUrl = URL.createObjectURL(file);
    const entry = { localUrl, cloudUrl: null, uploading: true };
    screenshots.push(entry);
    renderScreenshots();
    compressImage(file).then(blob => uploadToCloudinary(blob)).then(url => {
      entry.cloudUrl = url; entry.uploading = false;
      renderScreenshots(); _saveDraft();
    }).catch(err => {
      toast('Ошибка загрузки фото: ' + err.message, 'e');
      const idx = screenshots.indexOf(entry);
      if (idx !== -1) {
        if (entry.localUrl?.startsWith('blob:')) URL.revokeObjectURL(entry.localUrl);
        screenshots.splice(idx, 1);
      }
      renderScreenshots();
    });
  });
});

let screenshotDrag = null;
let suppressScreenshotPreviewUntil = 0;

function syncScreenshotOrderDom(row) {
  row.querySelectorAll('.shot-item').forEach((item, index) => {
    item.dataset.shotIndex = String(index);
    const image = item.querySelector('[data-shot-preview]');
    const remove = item.querySelector('.rm');
    if (image) {
      image.dataset.shotPreview = String(index);
      image.alt = `Скриншот ${index + 1}`;
    }
    if (remove) remove.dataset.idx = String(index);
  });
}

function bindScreenshotSorting(row) {
  document.querySelectorAll('.shot-drag-ghost').forEach(ghost => ghost.remove());
  row.classList.remove('sorting');
  row.querySelectorAll('.shot-item').forEach(slot => {
    slot.style.visibility = '';
    slot.classList.remove('dragging');
  });

  row.querySelectorAll('.shot-item').forEach(item => {
    const image = item.querySelector('[data-shot-preview]');
    if (!image) return;
    image.draggable = false;
    image.addEventListener('dragstart', event => event.preventDefault());
    image.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      if (screenshotDrag) return;
      screenshotDrag = {
        pointerId: event.pointerId,
        item,
        startX: event.clientX,
        startY: event.clientY,
        offsetX: event.clientX - item.getBoundingClientRect().left,
        offsetY: event.clientY - item.getBoundingClientRect().top,
        slotCenters: [...row.querySelectorAll('.shot-item')].map(slot => {
          const rect = slot.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }),
        ghost: null,
        moved: false,
      };

      const moveDrag = moveEvent => {
        if (!screenshotDrag || screenshotDrag.pointerId !== moveEvent.pointerId || screenshotDrag.item !== item) return;
        if (!screenshotDrag.moved && Math.hypot(moveEvent.clientX - screenshotDrag.startX, moveEvent.clientY - screenshotDrag.startY) < 8) return;
        if (!screenshotDrag.moved) {
          screenshotDrag.moved = true;
          const rect = item.getBoundingClientRect();
          const ghost = item.cloneNode(true);
          ghost.classList.add('shot-drag-ghost');
          ghost.querySelector('.rm')?.remove();
          ghost.style.width = `${rect.width}px`;
          ghost.style.height = `${rect.height}px`;
          document.body.appendChild(ghost);
          screenshotDrag.ghost = ghost;
          item.style.visibility = 'hidden';
          item.classList.add('dragging');
          row.classList.add('sorting');
        }
        const ghost = screenshotDrag.ghost;
        if (ghost) {
          ghost.style.left = `${moveEvent.clientX - screenshotDrag.offsetX}px`;
          ghost.style.top = `${moveEvent.clientY - screenshotDrag.offsetY}px`;
        }
        const to = screenshotDrag.slotCenters.reduce((best, center, index) => {
          const distance = Math.hypot(moveEvent.clientX - center.x, moveEvent.clientY - center.y);
          return distance < best.distance ? { index, distance } : best;
        }, { index: 0, distance: Infinity }).index;
        const items = [...row.querySelectorAll('.shot-item')];
        const from = items.indexOf(item);
        if (from >= 0 && to >= 0 && from !== to) {
          const [entry] = screenshots.splice(from, 1);
          screenshots.splice(to, 0, entry);
          const remaining = [...row.querySelectorAll('.shot-item')].filter(candidate => candidate !== item);
          if (to >= remaining.length) row.insertBefore(item, row.querySelector('.btn-add-shot'));
          else row.insertBefore(item, remaining[to]);
          syncScreenshotOrderDom(row);
        }
        moveEvent.preventDefault();
      };

      const finishDrag = finishEvent => {
        if (!screenshotDrag || screenshotDrag.pointerId !== event.pointerId || screenshotDrag.item !== item) return;
        const moved = screenshotDrag.moved;
        screenshotDrag.ghost?.remove();
        screenshotDrag = null;
        item.style.visibility = '';
        item.classList.remove('dragging');
        row.classList.remove('sorting');
        window.removeEventListener('pointermove', moveDrag, true);
        window.removeEventListener('pointerup', finishDrag, true);
        window.removeEventListener('pointercancel', finishDrag, true);
        window.removeEventListener('blur', cancelDrag);
        if (moved) {
          suppressScreenshotPreviewUntil = performance.now() + 350;
          renderModeratorScreenshotRail();
          _saveDraft();
          finishEvent?.preventDefault?.();
        }
      };

      const cancelDrag = () => finishDrag({ preventDefault() {} });
      window.addEventListener('pointermove', moveDrag, true);
      window.addEventListener('pointerup', finishDrag, true);
      window.addEventListener('pointercancel', finishDrag, true);
      window.addEventListener('blur', cancelDrag);
    });
    image.addEventListener('pointermove', event => {
      if (!screenshotDrag || screenshotDrag.pointerId !== event.pointerId || screenshotDrag.item !== item) return;
      event.preventDefault();
    });
  });
}

function renderScreenshots() {
  const row = document.getElementById('shots-row');
  row.innerHTML = screenshots.map((s, i) => `
    <div class="shot-item" data-shot-index="${i}">
      <img src="${esc(s.localUrl)}" alt="Скриншот ${i + 1}" data-shot-preview="${i}" style="opacity:${s.uploading ? 0.5 : 1};cursor:zoom-in;">
      <button class="rm" data-idx="${i}">✕</button>
    </div>`).join('');
  if (screenshots.length < 5) {
    row.innerHTML += `<button class="btn-add-shot" id="btn-add-shot">+</button>`;
    document.getElementById('btn-add-shot').addEventListener('click', () => {
      if (screenshots.length >= 5) { toast('Максимум 5 скриншотов', 'i'); return; }
      document.getElementById('shot-file-input').click();
    });
  }
  row.querySelectorAll('.rm').forEach(b => {
    b.addEventListener('click', event => {
      event.stopPropagation();
      const idx = parseInt(b.dataset.idx);
      if (screenshots[idx].localUrl?.startsWith('blob:')) URL.revokeObjectURL(screenshots[idx].localUrl);
      screenshots.splice(idx, 1);
      renderScreenshots(); _saveDraft();
    });
  });
  row.querySelectorAll('[data-shot-preview]').forEach(img => {
    img.addEventListener('click', () => {
      if (performance.now() < suppressScreenshotPreviewUntil) return;
      const shot = screenshots[Number(img.dataset.shotPreview)];
      if (shot?.localUrl) openScreenshotPreview(shot.localUrl, img.alt);
    });
  });
  bindScreenshotSorting(row);
  renderModeratorScreenshotRail();
}

let moderatorShotRailFrame = 0;
let moderatorShotRailTimer = 0;
const MODERATOR_SHOT_RAIL_AUTO_CLOSE_MS = 30_000;
const MODERATOR_SHOT_RAIL_MIN_VIEWPORT_WIDTH = 900;

function updateModeratorShotRailToggle() {
  const rail = document.getElementById('moderator-shot-rail');
  const toggle = rail?.querySelector('[data-moderator-rail-toggle]');
  if (!rail || !toggle) return;
  const collapsed = rail.classList.contains('is-collapsed');
  toggle.textContent = collapsed ? '›' : '‹';
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.setAttribute('aria-label', collapsed ? 'Открыть панель кадров' : 'Скрыть панель кадров');
  toggle.title = collapsed ? 'Открыть кадры' : 'Скрыть кадры';
}

function cancelModeratorShotRailTimer() {
  clearTimeout(moderatorShotRailTimer);
  moderatorShotRailTimer = 0;
}

function scheduleModeratorShotRailClose() {
  const rail = document.getElementById('moderator-shot-rail');
  cancelModeratorShotRailTimer();
  if (!rail || rail.hidden || rail.classList.contains('is-collapsed') || rail.matches(':hover') || rail.contains(document.activeElement)) return;
  moderatorShotRailTimer = window.setTimeout(() => {
    if (rail.hidden || rail.matches(':hover') || rail.contains(document.activeElement)) return;
    rail.classList.add('is-collapsed');
    updateModeratorShotRailToggle();
  }, MODERATOR_SHOT_RAIL_AUTO_CLOSE_MS);
}

function openModeratorShotRail() {
  const rail = document.getElementById('moderator-shot-rail');
  if (!rail) return;
  rail.classList.remove('is-collapsed');
  updateModeratorShotRailToggle();
  scheduleModeratorShotRailClose();
}

function bindModeratorShotRailDrawer() {
  const rail = document.getElementById('moderator-shot-rail');
  if (!rail || rail.dataset.drawerBound === 'true') return;
  rail.dataset.drawerBound = 'true';
  rail.addEventListener('pointerenter', cancelModeratorShotRailTimer);
  rail.addEventListener('pointerleave', scheduleModeratorShotRailClose);
  rail.addEventListener('focusin', cancelModeratorShotRailTimer);
  rail.addEventListener('focusout', () => requestAnimationFrame(scheduleModeratorShotRailClose));
  rail.addEventListener('click', event => {
    const toggle = event.target.closest('[data-moderator-rail-toggle]');
    if (toggle) {
      if (rail.classList.contains('is-collapsed')) openModeratorShotRail();
      else {
        cancelModeratorShotRailTimer();
        rail.classList.add('is-collapsed');
        updateModeratorShotRailToggle();
      }
      return;
    }
    const shotButton = event.target.closest('[data-moderator-shot]');
    if (!shotButton) return;
    if (performance.now() < suppressScreenshotPreviewUntil) return;
    const shot = screenshots[Number(shotButton.dataset.moderatorShot)];
    const src = shot?.localUrl || shot?.cloudUrl || '';
    if (src) openScreenshotPreview(src, `Скриншот ${Number(shotButton.dataset.moderatorShot) + 1}`);
  });
}

function updateModeratorScreenshotRailVisibility() {
  cancelAnimationFrame(moderatorShotRailFrame);
  moderatorShotRailFrame = requestAnimationFrame(() => {
    moderatorShotRailFrame = 0;
    const rail = document.getElementById('moderator-shot-rail');
    const editor = document.querySelector('.map-editor-shell');
    const uploadPanel = document.getElementById('workspace-upload');
    const form = uploadPanel?.querySelector('.form-layout');
    if (!rail || !editor || !form) return;
    const editorRect = editor.getBoundingClientRect();
    const formRect = form.getBoundingClientRect();
    const visible = screenshots.length > 0 && window.innerWidth >= MODERATOR_SHOT_RAIL_MIN_VIEWPORT_WIDTH &&
      uploadPanel?.classList.contains('active') && editorRect.top < window.innerHeight * .58 && formRect.bottom > 82;
    const wasHidden = rail.hidden;
    rail.hidden = !visible;
    if (!visible) {
      cancelModeratorShotRailTimer();
    } else if (wasHidden) {
      openModeratorShotRail();
    }
  });
}

function renderModeratorScreenshotRail() {
  const rail = document.getElementById('moderator-shot-rail');
  if (!rail) return;
  if (!screenshots.length) {
    rail.innerHTML = '';
    rail.hidden = true;
    return;
  }
  rail.innerHTML = `<button class="moderator-shot-rail-toggle" type="button" data-moderator-rail-toggle aria-expanded="true" aria-label="Скрыть панель кадров">‹</button><div class="moderator-shot-rail-head">Кадры лайнапа <span>${screenshots.length}</span></div><div class="moderator-shot-rail-list">${screenshots.map((shot, index) => `
    <button class="moderator-shot-rail-item" type="button" draggable="true" data-moderator-shot="${index}" aria-label="Открыть скриншот ${index + 1}. Можно перетащить для изменения порядка">
      <img src="${esc(shot.localUrl || shot.cloudUrl || '')}" alt="Скриншот ${index + 1}">
      <b class="moderator-shot-rail-index">${index + 1}</b>
    </button>`).join('')}</div>`;
  bindModeratorShotRailDrawer();
  bindModeratorScreenshotSorting(rail.querySelector('.moderator-shot-rail-list'));
  updateModeratorShotRailToggle();
  updateModeratorScreenshotRailVisibility();
}

function bindModeratorScreenshotSorting(list) {
  if (!list) return;
  let fromIndex = -1;
  let dropped = false;
  list.querySelectorAll('.moderator-shot-rail-item').forEach(item => {
    item.addEventListener('dragstart', event => {
      fromIndex = Number(item.dataset.moderatorShot);
      dropped = false;
      item.classList.add('is-dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(fromIndex));
    });
    item.addEventListener('dragover', event => {
      if (fromIndex < 0) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      list.querySelectorAll('.is-drop-target').forEach(node => node.classList.remove('is-drop-target'));
      item.classList.add('is-drop-target');
    });
    item.addEventListener('drop', event => {
      event.preventDefault();
      const toIndex = Number(item.dataset.moderatorShot);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
      const [entry] = screenshots.splice(fromIndex, 1);
      screenshots.splice(toIndex, 0, entry);
      dropped = true;
      suppressScreenshotPreviewUntil = performance.now() + 350;
      renderScreenshots();
      _saveDraft();
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('is-dragging');
      list.querySelectorAll('.is-drop-target').forEach(node => node.classList.remove('is-drop-target'));
      fromIndex = -1;
      if (dropped) dropped = false;
    });
  });
}

window.addEventListener('scroll', updateModeratorScreenshotRailVisibility, { passive:true });
window.addEventListener('resize', updateModeratorScreenshotRailVisibility);

function openScreenshotPreview(src, alt = 'Предпросмотр скриншота') {
  document.getElementById('shot-preview-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'shot-preview-overlay';
  overlay.className = 'shot-preview-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `<img src="${esc(src)}" alt="${esc(alt)}"><button class="shot-preview-close" type="button" aria-label="Закрыть">✕</button>`;
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKeyDown);
  };
  const onKeyDown = event => { if (event.key === 'Escape') close(); };
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  overlay.querySelector('.shot-preview-close').addEventListener('click', close);
  overlay.querySelector('img').addEventListener('click', event => event.stopPropagation());
  document.addEventListener('keydown', onKeyDown);
  document.body.appendChild(overlay);
  overlay.querySelector('.shot-preview-close').focus();
}

// ── Map minimap ───────────────────────────────────────────────────────────────
const MAP_FALLBACK_URLS = {
  'Haven':    'https://media.valorant-api.com/maps/2bee0dc9-4ffe-519b-1cbd-7fbe763a6047/displayicon.png',
  'Bind':     'https://media.valorant-api.com/maps/2c9d57ec-4431-9c5e-2939-8f9ef6dd5cba/displayicon.png',
  'Ascent':   'https://media.valorant-api.com/maps/7eaecc1b-4337-bbf6-6ab9-04b8f06b3319/displayicon.png',
  'Split':    'https://media.valorant-api.com/maps/d960549e-485c-e861-8d71-aa9d1aed12a2/displayicon.png',
  'Icebox':   'https://media.valorant-api.com/maps/e2ad5c54-4114-a870-9641-8ea21279579a/displayicon.png',
  'Breeze':   'https://media.valorant-api.com/maps/2fb9a4fd-47b8-4e7d-a969-74b4046ebd53/displayicon.png',
  'Fracture': 'https://media.valorant-api.com/maps/b529448b-4d60-346e-e89e-00a4c527a405/displayicon.png',
  'Pearl':    'https://media.valorant-api.com/maps/fd267378-4d1d-484f-ff52-77821ed10dc2/displayicon.png',
  'Lotus':    'https://media.valorant-api.com/maps/2fe4ed3a-450a-948b-6d6b-e89a78e680a9/displayicon.png',
  'Sunset':   'https://media.valorant-api.com/maps/92584fbe-486a-b1b2-9faa-39eb02e28435/displayicon.png',
  'Abyss':    'https://media.valorant-api.com/maps/224b0a95-48b9-d703-cc5f-3e8e0f488ea8/displayicon.png',
  'Corrode':  'https://media.valorant-api.com/maps/1c18ab1f-420d-0d8b-71d0-77ad3c439115/displayicon.png',
  'Summit':   'https://media.valorant-api.com/maps/756da597-416b-c0f2-f47b-afbdf28670bc/displayicon.png',
};

document.getElementById('map-wrap')?.addEventListener('dragstart', e => e.preventDefault());
document.getElementById('map-img')?.addEventListener('dragstart', e => e.preventDefault());
document.getElementById('map-wrap')?.addEventListener('dragover', e => {
  if (normalizeContentCategory(selectedCategory) !== 'defense') return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
document.getElementById('map-wrap')?.addEventListener('drop', e => {
  if (normalizeContentCategory(selectedCategory) !== 'defense') return;
  e.preventDefault();
  const abilityName = e.dataTransfer?.getData('application/x-defense-ability') || e.dataTransfer?.getData('text/plain') || '';
  const ab = selectedAgentAbilities().find(item => item.ability === abilityName);
  if (ab) selectedDefenseAbility = ab;
  const { x, y } = eventToMapPoint(e);
  placeDefenseAbilityAt(x, y);
});

let defenseMarkerDrag = null;
let defenseLinePointDrag = null;
let defenseRadiusDrag = null;
// Marker DOM nodes are recreated by renderDefenseAbilityMarkers() during a drag.
// Keep pointer tracking on the window handlers below instead of capturing a node
// that is detached by the first render (which throws InvalidStateError in Chromium).
document.getElementById('defense-ability-markers')?.addEventListener('pointerdown', e => {
  const radiusAnchor = e.target.closest('[data-defense-radius-index]');
  if (radiusAnchor) { e.preventDefault(); e.stopPropagation(); defenseRadiusDrag={index:Number(radiusAnchor.dataset.defenseRadiusIndex),pointerId:e.pointerId}; selectedDefenseMarkerIndex=defenseRadiusDrag.index; return; }
  const anchor = e.target.closest('[data-defense-line-index]');
  if (anchor && normalizeContentCategory(selectedCategory) === 'defense') {
    e.preventDefault();
    e.stopPropagation();
    defenseLinePointDrag = {
      index: Number(anchor.dataset.defenseLineIndex),
      pointIndex: Number(anchor.dataset.defenseLinePoint),
      pointerId: e.pointerId,
    };
    selectedDefenseAbility = null;
    selectedDefenseMarkerIndex = defenseLinePointDrag.index;
    setMapMode('position');
    renderDefenseAbilityPanel();
    renderDefenseAbilityMarkers();
    return;
  }
  const marker = e.target.closest('[data-defense-marker-index]');
  if (!marker || normalizeContentCategory(selectedCategory) !== 'defense') return;
  e.preventDefault();
  e.stopPropagation();
  defenseMarkerDrag = {
    index: Number(marker.dataset.defenseMarkerIndex),
    pointerId: e.pointerId,
    moved: false,
  };
  selectedDefenseAbility = null;
  selectedDefenseMarkerIndex = Number(marker.dataset.defenseMarkerIndex);
  setMapMode('position');
  renderDefenseAbilityPanel();
  renderDefenseAbilityMarkers();
});
document.getElementById('side-row').querySelectorAll('.pill-btn').forEach(b => {
  b.addEventListener('click', () => {
    document.getElementById('side-row').querySelectorAll('.pill-btn').forEach(x => x.classList.remove('selected'));
    b.classList.add('selected');
    selectedRoundSide = b.dataset.val;
    if (selectedRoundSide !== 'attack') {
      spikeUsage = null;
      spikeX = spikeY = null;
      if (mapMode === 'spike') setMapMode('position');
    }
    renderSpikeControls();
    applyMapViewTransform();
    validateForm(); _saveDraft();
  });
});

function renderSpikeControls() {
  const group = document.getElementById('spike-choice');
  const placeButton = document.getElementById('mode-spike');
  const unusedButton = document.getElementById('spike-not-used');
  const marker = document.getElementById('spike-marker');
  const attackLineup = normalizeContentCategory(selectedCategory) === 'lineup' && selectedRoundSide === 'attack';
  if (group) group.hidden = !attackLineup;
  placeButton?.classList.toggle('is-selected', attackLineup && spikeUsage === 'placed');
  unusedButton?.classList.toggle('is-selected', attackLineup && spikeUsage === 'not_used');
  placeButton?.setAttribute('aria-pressed', String(attackLineup && spikeUsage === 'placed'));
  unusedButton?.setAttribute('aria-pressed', String(attackLineup && spikeUsage === 'not_used'));
  if (!marker) return;
  if (!attackLineup || spikeUsage !== 'placed' || spikeX === null || spikeY === null) {
    marker.hidden = true;
    return;
  }
  const content = mapContentRect();
  marker.hidden = false;
  marker.style.left = `${(content.left + spikeX * content.width) / content.wrapWidth * 100}%`;
  marker.style.top = `${(content.top + spikeY * content.height) / content.wrapHeight * 100}%`;
}

function spikeSubmissionPayload(contentType = selectedCategory, roundSide = selectedRoundSide) {
  if (normalizeContentCategory(contentType) !== 'lineup' || roundSide !== 'attack') return {};
  if (spikeUsage === 'placed') return { spike_usage:'placed', spike_x:spikeX, spike_y:spikeY };
  if (spikeUsage === 'not_used') return { spike_usage:'not_used' };
  return {};
}

document.getElementById('mode-spike')?.addEventListener('click', () => {
  spikeUsage = 'placed';
  setMapMode('spike');
  renderSpikeControls();
  validateForm();
  _saveDraft();
});
document.getElementById('spike-not-used')?.addEventListener('click', () => {
  spikeUsage = 'not_used';
  spikeX = spikeY = null;
  if (mapMode === 'spike') setMapMode('position');
  renderSpikeControls();
  validateForm();
  _saveDraft();
});
document.getElementById('defense-ability-markers')?.addEventListener('click', e => {
  if (e.target.closest('[data-defense-marker-index]')) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);
window.addEventListener('pointermove', e => {
  if (defenseRadiusDrag?.pointerId === e.pointerId) {
    const item=defenseAbilities[defenseRadiusDrag.index]; if (!item) return;
    const p=eventToMapPoint(e), c=defenseAbilityCenter(item);
    item.shape_radius=Math.max(.02, Math.min(.25, Math.hypot(p.x-c.x,p.y-c.y)*Math.sqrt(2)));
    renderDefenseAbilityMarkers(); return;
  }
  if (defenseAbilityDrag && defenseAbilityDrag.pointerId === e.pointerId) {
    defenseAbilityDrag.moved = true;
    setAbilityDragGhostPosition(e);
    return;
  }
  if (defenseLinePointDrag && defenseLinePointDrag.pointerId === e.pointerId) {
    const item = defenseAbilities[defenseLinePointDrag.index];
    if (!item) return;
    setDefenseAbilityEndpoint(item, defenseLinePointDrag.pointIndex, eventToMapPoint(e));
    renderDefenseAbilityMarkers();
    return;
  }
  if (!defenseMarkerDrag || defenseMarkerDrag.pointerId !== e.pointerId) return;
  defenseMarkerDrag.moved = true;
  const { x, y } = eventToMapPoint(e);
  const item = defenseAbilities[defenseMarkerDrag.index];
  if (!item) return;
  if (['line_segment','sensor_rect','wall_sections'].includes(defenseShapeKind(item))) {
    const oldCenter = defenseAbilityCenter(item);
    const dx = x - oldCenter.x;
    const dy = y - oldCenter.y;
    item.points = normalizedDefensePoints(item).map((point, pointIndex) => ({
      ...(['sensor_rect','wall_sections'].includes(defenseShapeKind(item)) ? { role:pointIndex === 0 ? 'pivot' : 'rotation' } : {}),
      x: clamp01(point.x + dx),
      y: clamp01(point.y + dy),
    }));
  }
  item.x = x;
  item.y = y;
  renderDefenseAbilityMarkers();
});
function finishDefenseMarkerDrag(e) {
  if (!defenseMarkerDrag || defenseMarkerDrag.pointerId !== e.pointerId) return;
  const { x, y } = eventToMapPoint(e);
  moveDefenseAbilityTo(defenseMarkerDrag.index, x, y);
  defenseMarkerDrag = null;
}
window.addEventListener('pointerup', finishDefenseMarkerDrag);
window.addEventListener('pointerup', e => { if (defenseRadiusDrag?.pointerId === e.pointerId) { defenseRadiusDrag=null; _saveDraft(); } });
window.addEventListener('pointercancel', e => { if (defenseMarkerDrag?.pointerId === e.pointerId) defenseMarkerDrag = null; });
function finishDefenseLinePointDrag(e) {
  if (!defenseLinePointDrag || defenseLinePointDrag.pointerId !== e.pointerId) return;
  const item = defenseAbilities[defenseLinePointDrag.index];
  if (item) {
    setDefenseAbilityEndpoint(item, defenseLinePointDrag.pointIndex, eventToMapPoint(e));
    validateForm(); _saveDraft();
  }
  defenseLinePointDrag = null;
  renderDefenseAbilityMarkers();
}
window.addEventListener('pointerup', finishDefenseLinePointDrag);
window.addEventListener('pointercancel', e => { if (defenseLinePointDrag?.pointerId === e.pointerId) defenseLinePointDrag = null; });

function finishDefenseAbilityDrag(e) {
  if (!defenseAbilityDrag || defenseAbilityDrag.pointerId !== e.pointerId) return;
  const drag = defenseAbilityDrag;
  removeAbilityDragGhost();
  defenseAbilityDrag = null;
  const wrap = document.getElementById('map-wrap');
  const rect = wrap?.getBoundingClientRect();
  const overMap = rect && e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
  if (overMap) {
    selectedDefenseAbility = drag.ability;
    const { x, y } = eventToMapPoint(e);
    placeDefenseAbilityAt(x, y);
    return;
  }
  renderDefenseAbilityPanel();
}
window.addEventListener('pointerup', finishDefenseAbilityDrag);
window.addEventListener('pointercancel', e => {
  if (defenseAbilityDrag?.pointerId !== e.pointerId) return;
  removeAbilityDragGhost();
  defenseAbilityDrag = null;
  renderDefenseAbilityPanel();
});

function areaFromMapPoints(a, b) {
  const x1 = Math.min(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const x2 = Math.max(a.x, b.x);
  const y2 = Math.max(a.y, b.y);
  return {
    x: x1,
    y: y1,
    width: Math.max(0.01, x2 - x1),
    height: Math.max(0.01, y2 - y1),
  };
}

document.getElementById('map-wrap')?.addEventListener('pointerdown', e => {
  if (
    normalizeContentCategory(selectedCategory) === 'defense' &&
    mapMode === 'defenseAbility' &&
    selectedDefenseAbility?.shape?.kind === 'line_segment'
  ) {
    const img = document.getElementById('map-img');
    if (img?.style.display === 'none') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const start = eventToMapPoint(e);
    defenseLineDraft = {
      ability: selectedDefenseAbility.ability,
      slot: selectedDefenseAbility.slot,
      icon: selectedDefenseAbility.icon,
      shape_kind: 'line_segment',
      x: start.x,
      y: start.y,
      points: [start, start],
      pointerId: e.pointerId,
    };
    renderDefenseAbilityMarkers();
    safeSetPointerCapture(e.currentTarget, e.pointerId);
    return;
  }
  if (normalizeContentCategory(selectedCategory) !== 'defense' || mapMode !== 'zoom') return;
  const img = document.getElementById('map-img');
  if (img?.style.display === 'none') return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const start = eventToMapPoint(e);
  defenseZoomDrag = { start, pointerId: e.pointerId, moved: false };
  defenseZoomStart = start;
  defenseZoomArea = { x: start.x, y: start.y, width: 0.01, height: 0.01 };
  renderCategoryMapExtras();
  safeSetPointerCapture(e.currentTarget, e.pointerId);
});

window.addEventListener('pointermove', e => {
  if (defenseLineDraft && defenseLineDraft.pointerId === e.pointerId) {
    e.preventDefault();
    const end = eventToMapPoint(e);
    const points = normalizedDefensePoints({ ...defenseLineDraft, points: [defenseLineDraft.points[0], end] });
    const center = defenseAbilityCenter({ ...defenseLineDraft, points });
    defenseLineDraft = { ...defenseLineDraft, x: center.x, y: center.y, points };
    renderDefenseAbilityMarkers();
    return;
  }
  if (!defenseZoomDrag || defenseZoomDrag.pointerId !== e.pointerId) return;
  e.preventDefault();
  defenseZoomDrag.moved = true;
  defenseZoomArea = areaFromMapPoints(defenseZoomDrag.start, eventToMapPoint(e));
  renderCategoryMapExtras();
});

function finishDefenseZoomDrag(e) {
  if (!defenseZoomDrag || defenseZoomDrag.pointerId !== e.pointerId) return;
  const area = areaFromMapPoints(defenseZoomDrag.start, eventToMapPoint(e));
  defenseZoomArea = area.width >= 0.01 && area.height >= 0.01 ? area : null;
  defenseZoomStart = null;
  defenseZoomDrag = null;
  defenseZoomJustSelected = true;
  renderCategoryMapExtras();
  setMapMode('position');
  validateForm(); _saveDraft();
  setTimeout(() => { defenseZoomJustSelected = false; }, 0);
}
window.addEventListener('pointerup', finishDefenseZoomDrag);
window.addEventListener('pointercancel', e => {
  if (defenseZoomDrag?.pointerId !== e.pointerId) return;
  defenseZoomStart = null;
  defenseZoomDrag = null;
  renderCategoryMapExtras();
});

function finishDefenseLineDraft(e) {
  if (!defenseLineDraft || defenseLineDraft.pointerId !== e.pointerId) return;
  const draft = defenseLineDraft;
  const points = normalizedDefensePoints({ ...draft, points: [draft.points[0], eventToMapPoint(e)] });
  const distance = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
  defenseLineDraft = null;
  if (distance < 0.01) {
    renderDefenseAbilityMarkers();
    toast('Протяни линию между двумя стенками', 'w');
    return;
  }
  const center = defenseAbilityCenter({ shape_kind: 'line_segment', points });
  placeDefenseAbilityAt(center.x, center.y, { shapeKind: 'line_segment', points });
  defenseLineJustCreated = true;
  setTimeout(() => { defenseLineJustCreated = false; }, 0);
}
window.addEventListener('pointerup', finishDefenseLineDraft);
window.addEventListener('pointercancel', e => {
  if (defenseLineDraft?.pointerId !== e.pointerId) {
    return;
  }
  defenseLineDraft = null;
  renderDefenseAbilityMarkers();
});

let mapLoadGeneration = 0;
let mapInteractionReady = false;

async function loadMapMinimap() {
  const generation = ++mapLoadGeneration;
  const mapName = document.getElementById('sel-map').value;
  const img     = document.getElementById('map-img');
  const ph      = document.getElementById('map-placeholder');
  const marker  = document.getElementById('map-marker');
  mapInteractionReady = false;
  img.onload = null;
  img.onerror = null;
  if (!mapName) {
    img.style.display = 'none'; ph.style.display = '';
    marker.style.display = 'none';
    markerX = markerY = null; trajectoryPoints = [];
    extraAbilityTrajectories = [];
    selectedExtraAbilityIndex = null;
    wallbangTargetX = wallbangTargetY = null;
    spikeUsage = null; spikeX = spikeY = null;
    defenseZoomStart = null;
    defenseZoomArea = null;
    renderTrajectory();
    renderCategoryMapExtras();
    renderSpikeControls();
    return;
  }
  ph.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text2);">Загружаем карту…</div>`;
  ph.style.display = '';
  img.style.display = 'none';
  await loadMapAnnotations();
  if (generation !== mapLoadGeneration || document.getElementById('sel-map').value !== mapName) return;
  applyMapViewTransform();
  const apiUrl = mapsData.find(m => m.displayName === mapName)?.displayIcon;
  const fallbackUrl = MAP_FALLBACK_URLS[mapName];
  const candidates = [...new Set([
    proxiedValorantUrl(apiUrl),
    proxiedValorantUrl(fallbackUrl),
    fallbackUrl,
  ].filter(Boolean))];
  if (candidates.length) {
    let attempt = 0;
    let timeoutId = null;
    let finished = false;
    const armTimeout = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => fail('timeout'), 12000);
    };
    const finish = () => {
      if (generation !== mapLoadGeneration || document.getElementById('sel-map').value !== mapName) return;
      if (finished) return;
      finished = true;
      clearTimeout(timeoutId);
      mapInteractionReady = true;
      img.style.display = 'block';
      ph.style.display = 'none';
      applyMapViewTransform();
      if (markerX != null && markerY != null) setMarkerPosition(markerX, markerY);
      renderTrajectory();
      renderMapSiteLabels();
      renderCategoryMapExtras();
      renderSpikeControls();
      refreshMapGeometryAfterLayout();
    };
    const fail = reason => {
      if (generation !== mapLoadGeneration || document.getElementById('sel-map').value !== mapName) return;
      if (finished) return;
      clearTimeout(timeoutId);
      attempt += 1;
      if (attempt < candidates.length) {
        img.src = candidates[attempt];
        armTimeout();
        if (img.complete && img.naturalWidth > 0) queueMicrotask(finish);
        return;
      }
      mapInteractionReady = false;
      img.style.display = 'none';
      ph.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text2);">Карта недоступна. Обнови страницу или выбери карту ещё раз.</div>`;
      ph.style.display = '';
      logUploadError(new Error('Map image failed to load'), {
        action: 'map_image_load_failed', map: mapName, reason, attempts: candidates.length,
        orientation_ready: mapAnnotationsReady, quarter_turns: currentMapQuarterTurns(),
      });
    };
    img.crossOrigin = 'anonymous';
    img.onerror = () => fail('image_error');
    img.onload = finish;
    img.src = candidates[0];
    armTimeout();
    if (img.complete && img.naturalWidth > 0) queueMicrotask(finish);
    marker.style.display = 'none';
    markerX = markerY = null; trajectoryPoints = [];
    extraAbilityTrajectories = [];
    selectedExtraAbilityIndex = null;
    wallbangTargetX = wallbangTargetY = null;
    spikeUsage = null; spikeX = spikeY = null;
    defenseZoomStart = null;
    defenseZoomArea = null;
    renderTrajectory();
    renderMapSiteLabels();
    renderCategoryMapExtras();
  } else {
    mapInteractionReady = false;
    img.style.display = 'none';
    ph.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text2);">Миникарта не найдена</div>`;
    ph.style.display = '';
    logUploadError(new Error('Map image URL is missing'), { action: 'map_image_url_missing', map: mapName });
  }
  validateForm();
}

// Map mode switcher — exposed to window for inline onclick
function setMapMode(mode) {
  mapMode = mode;
  document.getElementById('mode-position').classList.toggle('selected-mode',   mode === 'position');
  document.getElementById('mode-trajectory').classList.toggle('selected-mode', mode === 'trajectory');
  document.getElementById('mode-wallbang-target')?.classList.toggle('selected-mode', mode === 'target');
  document.getElementById('mode-defense-zoom')?.classList.toggle('selected-mode', mode === 'zoom');
  document.getElementById('mode-spike')?.classList.toggle('selected-mode', mode === 'spike');
  const defense = normalizeContentCategory(selectedCategory) === 'defense';
  const wallbang = normalizeContentCategory(selectedCategory) === 'wallbang';
  document.getElementById('mode-position').style.display = defense ? 'none' : '';
  document.getElementById('mode-trajectory').style.display = (defense || wallbang) ? 'none' : '';
  const targetBtn = document.getElementById('mode-wallbang-target');
  const targetClear = document.getElementById('wallbang-target-clear');
  if (targetBtn) targetBtn.style.display = wallbang ? '' : 'none';
  if (targetClear) targetClear.style.display = wallbang ? '' : 'none';
  document.getElementById('traj-undo').style.display  = mode === 'trajectory' ? '' : 'none';
  document.getElementById('traj-clear').style.display = mode === 'trajectory' ? '' : 'none';
  document.getElementById('map-wrap')?.classList.toggle('zoom-picking', mode === 'zoom');
  const hint = document.getElementById('map-hint');
  if (hint) {
    if (mode === 'target') hint.textContent = 'Кликни на карте точку, куда прилетает прострел.';
    else if (mode === 'spike') hint.textContent = 'Кликни на место установки Spike.';
    else if (mode === 'zoom') hint.textContent = 'Зажми мышь на карте и выдели прямоугольник zoom-области.';
    else if (mode === 'defenseAbility') hint.textContent = selectedDefenseAbility?.shape?.kind === 'line_segment'
      ? 'Зажми на карте и протяни линию между двумя стенками.'
      : (selectedDefenseAbility ? 'Кликни по карте или перетащи абилку, чтобы поставить точку сетапа.' : 'Обычный режим: перетаскивай уже поставленные абилки по карте.');
    else if (mode === 'trajectory' && activeExtraAbility()) hint.textContent = `Рисуешь доп. траекторию: ${activeExtraAbility().ability}`;
    else if (mode === 'trajectory') hint.textContent = 'Рисуешь основную траекторию';
    else hint.textContent = 'Выбери режим и кликни на карту';
  }
}
window.setMapMode = setMapMode;
window.undoTraj  = function() {
  const points = activeTrajectoryPoints();
  points.pop();
  setActiveTrajectoryPoints(points);
  renderExtraAbilityPanel();
  renderTrajectory();
  _saveDraft();
};
window.clearTraj = function() {
  setActiveTrajectoryPoints([]);
  renderExtraAbilityPanel();
  renderTrajectory();
  validateForm(); _saveDraft();
};

function mapContentRect() {
  const wrap = document.getElementById('map-wrap');
  const img = document.getElementById('map-img');
  const ww = wrap.clientWidth || 1;
  const wh = wrap.clientHeight || 1;
  const iw = img.naturalWidth || ww;
  const ih = img.naturalHeight || wh;
  const scale = Math.min(ww / iw, wh / ih);
  const width = iw * scale;
  const height = ih * scale;
  return {
    left: (ww - width) / 2,
    top: (wh - height) / 2,
    width,
    height,
    wrapWidth: ww,
    wrapHeight: wh,
  };
}

let mapGeometryRefreshFrame = 0;
function refreshMapGeometryAfterLayout() {
  cancelAnimationFrame(mapGeometryRefreshFrame);
  mapGeometryRefreshFrame = requestAnimationFrame(() => {
    mapGeometryRefreshFrame = requestAnimationFrame(() => {
      mapGeometryRefreshFrame = 0;
      applyMapViewTransform();
      if (markerX !== null && markerY !== null) setMarkerPosition(markerX, markerY);
      renderTrajectory();
      renderMapSiteLabels();
      renderCategoryMapExtras();
      renderDefenseAbilityMarkers();
    });
  });
}

const mapWrapResizeObserver = typeof ResizeObserver === 'function'
  ? new ResizeObserver(() => refreshMapGeometryAfterLayout())
  : null;
const observedMapWrap = document.getElementById('map-wrap');
if (observedMapWrap) mapWrapResizeObserver?.observe(observedMapWrap);
window.addEventListener('resize', refreshMapGeometryAfterLayout);

let mapViewScale = 1;
let mapViewPanX = 0;
let mapViewPanY = 0;
let mapViewPanDrag = null;
let mapViewPanSuppressClick = false;

function clampMapViewPan() {
  const wrap = document.getElementById('map-wrap');
  if (!wrap) return;
  mapViewPanX = Math.max(wrap.clientWidth * (1 - mapViewScale), Math.min(0, mapViewPanX));
  mapViewPanY = Math.max(wrap.clientHeight * (1 - mapViewScale), Math.min(0, mapViewPanY));
}

function applyMapViewTransform() {
  clampMapViewPan();
  const stage = document.getElementById('map-stage');
  const orientationLayer = document.getElementById('map-orientation-layer');
  if (!stage || !orientationLayer) return;
  const quarterTurns = currentMapQuarterTurns();
  stage.style.transform = `translate(${mapViewPanX}px, ${mapViewPanY}px) scale(${mapViewScale})`;
  orientationLayer.dataset.quarterTurns = String(quarterTurns);
  orientationLayer.style.transform = `rotate(${quarterTurns * 90}deg)`;
  orientationLayer.style.setProperty('--map-counter-rotation', `${quarterTurns * -90}deg`);
}

function resetMapView() {
  mapViewScale = 1;
  mapViewPanX = 0;
  mapViewPanY = 0;
  applyMapViewTransform();
}

document.getElementById('map-wrap')?.addEventListener('wheel', event => {
  if (document.getElementById('map-img')?.style.display === 'none') return;
  event.preventDefault();
  const rect = event.currentTarget.getBoundingClientRect();
  const cursorX = event.clientX - rect.left;
  const cursorY = event.clientY - rect.top;
  const worldX = (cursorX - mapViewPanX) / mapViewScale;
  const worldY = (cursorY - mapViewPanY) / mapViewScale;
  const factor = event.deltaY < 0 ? 1.14 : 1 / 1.14;
  const nextScale = Math.max(1, Math.min(5, mapViewScale * factor));
  mapViewPanX = cursorX - worldX * nextScale;
  mapViewPanY = cursorY - worldY * nextScale;
  mapViewScale = nextScale;
  applyMapViewTransform();
}, { passive: false });

document.getElementById('map-wrap')?.addEventListener('pointerdown', event => {
  if (event.button !== 0 && event.button !== 1) return;
  if (mapMode === 'zoom' || defenseZoomDrag) return;
  if (
    normalizeContentCategory(selectedCategory) === 'defense' &&
    mapMode === 'defenseAbility' &&
    selectedDefenseAbility?.shape?.kind === 'line_segment'
  ) return;
  if (mapViewScale <= 1 || event.target.closest('.defense-ability-marker,.map-marker')) return;
  mapViewPanDrag = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    panX: mapViewPanX,
    panY: mapViewPanY,
    dragging: event.button === 1,
  };
  if (event.button === 1) {
    event.preventDefault();
    event.stopImmediatePropagation();
    event.currentTarget.classList.add('map-panning');
  }
  safeSetPointerCapture(event.currentTarget, event.pointerId);
});
window.addEventListener('pointermove', event => {
  if (!mapViewPanDrag || mapViewPanDrag.pointerId !== event.pointerId) return;
  if (!mapViewPanDrag.dragging) {
    const distance = Math.hypot(event.clientX - mapViewPanDrag.x, event.clientY - mapViewPanDrag.y);
    if (distance < 5) return;
    mapViewPanDrag.dragging = true;
    document.getElementById('map-wrap')?.classList.add('map-panning');
  }
  event.preventDefault();
  mapViewPanSuppressClick = true;
  mapViewPanX = mapViewPanDrag.panX + event.clientX - mapViewPanDrag.x;
  mapViewPanY = mapViewPanDrag.panY + event.clientY - mapViewPanDrag.y;
  applyMapViewTransform();
});
function finishMapViewPan(event) {
  if (!mapViewPanDrag || mapViewPanDrag.pointerId !== event.pointerId) return;
  const dragged = mapViewPanDrag.dragging;
  mapViewPanDrag = null;
  document.getElementById('map-wrap')?.classList.remove('map-panning');
  if (dragged) setTimeout(() => { mapViewPanSuppressClick = false; }, 0);
}
window.addEventListener('pointerup', finishMapViewPan);
window.addEventListener('pointercancel', finishMapViewPan);

function eventToMapPoint(e) {
  const wrap = document.getElementById('map-wrap');
  const rect = wrap.getBoundingClientRect();
  const content = mapContentRect();
  let localX = (e.clientX - rect.left - mapViewPanX) / mapViewScale;
  let localY = (e.clientY - rect.top - mapViewPanY) / mapViewScale;
  const quarterTurns = currentMapQuarterTurns();
  for (let i = 0; i < quarterTurns; i++) {
    const previousX = localX;
    localX = localY;
    localY = content.wrapWidth - previousX;
  }
  const px = localX - content.left;
  const py = localY - content.top;
  return {
    x: Math.max(0, Math.min(1, px / content.width)),
    y: Math.max(0, Math.min(1, py / content.height)),
  };
}

function setMarkerPosition(x, y) {
  const marker = document.getElementById('map-marker');
  const content = mapContentRect();
  const left = content.left + x * content.width;
  const top = content.top + y * content.height;
  marker.style.display = '';
  marker.style.left = (left / content.wrapWidth * 100) + '%';
  marker.style.top = (top / content.wrapHeight * 100) + '%';
}

function trajectoryFromMarker(points = trajectoryPoints) {
  return trajectoryFromMarkerFor(points);
}

function rejectMapInteractionWhileLoading() {
  if (mapInteractionReady) return false;
  // Clicking the placeholder (including before a map was selected) is normal
  // user input, not an application error. Actual image failures are reported
  // by loadMapMinimap(), with the URL attempt and failure reason attached.
  if (document.getElementById('sel-map')?.value) {
    toast('Карта ещё загружается. Подожди секунду.', 'i');
  }
  return true;
}

function addTrajectoryPoint(x, y) {
  const points = activeTrajectoryPoints();
  const extra = activeExtraAbility();
  if (extra && points.length === 0) {
    points.push({ x, y });
    setActiveTrajectoryPoints(points);
    setMarkerPosition(x, y);
    updateMarkerIcon();
  } else {
    if (!extra && markerX !== null && points.length === 0) {
      points.push({ x: markerX, y: markerY });
    }
    points.push({ x, y });
    setActiveTrajectoryPoints(points);
  }
  renderExtraAbilityPanel();
  renderTrajectory();
  validateForm();
  _saveDraft();
}

document.getElementById('map-wrap')?.addEventListener('contextmenu', event => {
  if (mapMode !== 'trajectory') return;
  event.preventDefault();
  event.stopPropagation();
  if (rejectMapInteractionWhileLoading()) return;
  const img = document.getElementById('map-img');
  if (!img || img.style.display === 'none') return;
  const { x, y } = eventToMapPoint(event);
  addTrajectoryPoint(x, y);
});

document.getElementById('map-wrap').addEventListener('click', e => {
  if (mapViewPanSuppressClick) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  e.preventDefault();
  if (rejectMapInteractionWhileLoading()) return;
  if (defenseZoomJustSelected) return;
  if (defenseLineJustCreated) return;
  const img = document.getElementById('map-img');
  if (img.style.display === 'none') return;
  const { x, y } = eventToMapPoint(e);
  if (mapMode === 'spike') {
    spikeUsage = 'placed';
    spikeX = x;
    spikeY = y;
    renderSpikeControls();
  } else if (mapMode === 'position') {
    if (normalizeContentCategory(selectedCategory) === 'defense') return;
    const extra = activeExtraAbility();
    if (extra) {
      const points = normalizeTrajectoryPoints(extra.trajectory);
      if (points.length) points[0] = { x, y };
      else points.push({ x, y });
      extra.trajectory = points;
    } else {
      markerX = x; markerY = y;
      if (trajectoryPoints.length) trajectoryPoints[0] = { x, y };
    }
    if (!extra && normalizeContentCategory(selectedCategory) === 'wallbang' && wallbangTargetX !== null) {
      trajectoryPoints = [{ x, y }, { x: wallbangTargetX, y: wallbangTargetY }];
    }
    setMarkerPosition(x, y);
    updateMarkerIcon();
    renderExtraAbilityPanel();
    renderTrajectory();
  } else if (mapMode === 'target') {
    wallbangTargetX = x; wallbangTargetY = y;
    if (markerX !== null) trajectoryPoints = [{ x: markerX, y: markerY }, { x, y }];
    renderTrajectory();
    renderCategoryMapExtras();
  } else if (mapMode === 'defenseAbility') {
    placeDefenseAbilityAt(x, y);
  } else if (mapMode === 'zoom') {
    return;
  } else {
    addTrajectoryPoint(x, y);
    return;
  }
  validateForm(); _saveDraft();
});

function renderTrajectory() {
  const container = document.getElementById('traj-container');
  container.innerHTML = '';
  const ns  = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
  const content = mapContentRect();
  const defs = document.createElementNS(ns, 'defs');
  svg.appendChild(defs);
  let drew = false;

  function addMarker(id, color) {
    if (defs.querySelector(`#${id}`)) return;
    const mkr = document.createElementNS(ns, 'marker');
    mkr.setAttribute('id', id);
    mkr.setAttribute('markerWidth', '10');
    mkr.setAttribute('markerHeight', '8');
    mkr.setAttribute('refX', '10');
    mkr.setAttribute('refY', '4');
    mkr.setAttribute('orient', 'auto');
    mkr.setAttribute('markerUnits', 'userSpaceOnUse');
    const tri = document.createElementNS(ns, 'polygon');
    tri.setAttribute('points', '0 0, 10 4, 0 8');
    tri.setAttribute('fill', color);
    mkr.appendChild(tri);
    defs.appendChild(mkr);
  }

  function drawPath(rawPoints, { color, markerId, opacity = 0.85, width = 2, orderLabel = '', useMainStart = false, iconUrl = '' }) {
    const path = useMainStart
      ? trajectoryFromMarkerFor(rawPoints)
      : normalizeTrajectoryPoints(rawPoints);
    if (!path.length) return;
    drew = true;
    if (path.length >= 2) {
      addMarker(markerId, color);
      const coords = path.map(p => `${(content.left + p.x * content.width).toFixed(1)},${(content.top + p.y * content.height).toFixed(1)}`).join(' ');
      const poly = document.createElementNS(ns, 'polyline');
      poly.setAttribute('points', coords);
      poly.setAttribute('fill', 'none');
      poly.setAttribute('stroke', color);
      poly.setAttribute('stroke-opacity', String(opacity));
      poly.setAttribute('stroke-width', String(width));
      poly.setAttribute('stroke-linejoin', 'round');
      poly.setAttribute('stroke-linecap', 'round');
      poly.setAttribute('marker-end', `url(#${markerId})`);
      svg.appendChild(poly);
    }
    path.forEach((point, i) => {
      const cx = (content.left + point.x * content.width).toFixed(1);
      const cy = (content.top + point.y * content.height).toFixed(1);
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('cx', cx);
      dot.setAttribute('cy', cy);
      dot.setAttribute('r', i === 0 ? '5' : '3.5');
      dot.setAttribute('fill', color);
      dot.setAttribute('fill-opacity', String(opacity));
      dot.setAttribute('stroke', 'rgba(255,255,255,0.45)');
      dot.setAttribute('stroke-width', '0.5');
      svg.appendChild(dot);
      if (i === 0 && iconUrl) {
        const iconBackdrop = document.createElementNS(ns, 'circle');
        iconBackdrop.setAttribute('cx', cx);
        iconBackdrop.setAttribute('cy', cy);
        iconBackdrop.setAttribute('r', '10');
        iconBackdrop.setAttribute('fill', 'rgba(7,18,31,.94)');
        iconBackdrop.setAttribute('stroke', color);
        iconBackdrop.setAttribute('stroke-width', '1.6');
        iconBackdrop.setAttribute('class', 'trajectory-start-icon-backdrop');
        svg.appendChild(iconBackdrop);
        const icon = document.createElementNS(ns, 'image');
        icon.setAttribute('href', iconUrl);
        icon.setAttributeNS('http://www.w3.org/1999/xlink', 'href', iconUrl);
        icon.setAttribute('x', String(Number(cx) - 9));
        icon.setAttribute('y', String(Number(cy) - 9));
        icon.setAttribute('width', '18');
        icon.setAttribute('height', '18');
        icon.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        icon.setAttribute('class', 'trajectory-start-icon');
        icon.setAttribute('transform', `rotate(${-currentMapQuarterTurns() * 90} ${cx} ${cy})`);
        svg.appendChild(icon);
      }
      if (orderLabel && i === path.length - 1) {
        const label = document.createElementNS(ns, 'text');
        label.setAttribute('x', String(Number(cx) + 7));
        label.setAttribute('y', String(Number(cy) - 7));
        label.setAttribute('fill', color);
        label.setAttribute('font-size', '11');
        label.setAttribute('font-weight', '800');
        label.setAttribute('paint-order', 'stroke');
        label.setAttribute('stroke', 'rgba(2,6,23,.85)');
        label.setAttribute('stroke-width', '3');
        label.textContent = orderLabel;
        svg.appendChild(label);
      }
    });
  }

  drawPath(trajectoryPoints, {
    color: '#FF4655',
    markerId: 'ul-arr-primary',
    opacity: activeExtraAbility() ? 0.42 : 0.88,
    width: activeExtraAbility() ? 1.8 : 2.4,
    useMainStart: true,
    iconUrl: (() => {
      const agent = agentsList.find(a => a.displayName === selectedAgent);
      const ability = (agent?.abilities || []).find(ab => ab.displayName === selectedAbility || ab.slot === selectedAbility || normalizeAbilityName(agent.displayName, ab.displayName, ab.slot) === selectedAbility);
      return ability?.displayIcon || '';
    })(),
  });
  extraAbilityTrajectories.forEach((item, idx) => {
    const active = selectedExtraAbilityIndex === idx;
    drawPath(item.trajectory, {
      color: active ? '#50d6ff' : '#9b7bff',
      markerId: `ul-arr-extra-${idx}`,
      opacity: active ? 0.95 : 0.48,
      width: active ? 2.6 : 1.9,
      orderLabel: `+${idx + 1}`,
      iconUrl: extraAbilityIcon(item),
    });
  });

  if (drew) container.appendChild(svg);
  scheduleNearbyTitleSuggestions();
}

function updateMarkerIcon() {
  const img = document.getElementById('marker-icon');
  if (!img) return;
  const agent = agentsList.find(a => a.displayName === selectedAgent);
  if (!agent) { img.style.display = 'none'; return; }
  const ability = (agent.abilities || []).find(ab =>
    ab.displayName === selectedAbility ||
    ab.slot === selectedAbility ||
    normalizeAbilityName(agent.displayName, ab.displayName, ab.slot) === selectedAbility
  );
  const iconUrl = ability?.displayIcon || '';
  const marker = document.getElementById('map-marker');
  if (marker) marker.style.visibility = '';
  if (iconUrl) {
    img.src = iconUrl;
    img.style.display = 'block';
  } else {
    img.style.display = 'none';
  }
}

// ── Draft persistence ─────────────────────────────────────────────────────────
const _DRAFT_KEY = 'vl_lineup_draft';
const _DRAFTS_KEY = 'vl_lineup_drafts';
const _ACTIVE_DRAFT_ID_KEY = 'vl_active_lineup_draft_id';
const _DRAFT_MIGRATED_KEY = 'vl_lineup_draft_migrated_v2';
const MAX_SAVED_DRAFTS = 5;
let moderatorAutosaveTimer = null;
let moderatorAutosaveDirty = false;
let moderatorAutosaveRequest = null;
let moderatorAutosaveToken = '';

function collectDraftData() {
  return {
    map:        document.getElementById('sel-map')?.value || '',
    agent:      selectedAgent,
    ability:    selectedAbility,
    sovaCharge,
    sovaBounces,
    category:   selectedCategory,
    difficulty: selectedDifficulty,
    roundSide: selectedRoundSide,
    spikeUsage, spikeX, spikeY,
    title:      document.getElementById('inp-title')?.value || '',
    desc:       document.getElementById('inp-desc')?.value || '',
    markerX, markerY, mapMode,
    trajectory: trajectoryPoints,
    extraAbilities: extraAbilityTrajectories,
    selectedExtraAbilityIndex,
    wallbangTargetX,
    wallbangTargetY,
    wallbangWeapons: selectedWallbangWeapons(),
    defenseSite: defenseSiteValue(),
    defenseNumber: defenseNumberValue(),
    defenseZoomArea,
    defenseAbilities,
    sageWallHandlesHidden,
    videoUrl,
    videoEdit: videoUrl ? normalizedVideoEdit() : createDefaultVideoEdit(),
    screenshots: screenshots.filter(s => s.cloudUrl).map(s => s.cloudUrl),
    resubmissionSourceId,
    moderatorDraftSourceId,
    moderatorAuthor: moderatorSelectedAuthor,
  };
}

function moderatorAutosavePayload() {
  const contentType = normalizeContentCategory(selectedCategory || 'lineup');
  const ability = categoryNeedsAbility(contentType)
    ? normalizeAbilityName(selectedAgent, selectedAbility)
    : '';
  const data = {
    map: document.getElementById('sel-map')?.value || '',
    agent: contentType === 'wallbang' ? '' : selectedAgent,
    ability,
    title: document.getElementById('inp-title')?.value || '',
    description: document.getElementById('inp-desc')?.value || '',
    difficulty: selectedDifficulty || '',
    round_side: selectedRoundSide || '',
    ...spikeSubmissionPayload(contentType, selectedRoundSide),
    position_x: contentType === 'defense' ? 0 : markerX,
    position_y: contentType === 'defense' ? 0 : markerY,
    trajectory: contentType === 'defense' ? [] : trajectoryFromMarker(),
    extra_abilities: contentType === 'lineup' ? extraAbilityTrajectories.map((item, index) => ({
      ability: item.ability || '', icon: item.icon || '', order:index + 1,
      trajectory: trajectoryForSave(item), range_radius:Number(item.range_radius) || 0,
      ...(isSovaArrowSelection(selectedAgent, item.ability) ? { sova_charge:Number(item.sova_charge), sova_bounces:Number(item.sova_bounces) } : {}),
      effect_shape: item.effect_shape || 'circle',
    })) : [],
    sova_shots: contentType === 'lineup' ? buildSovaShotsPayload(ability) : [],
    category: contentType,
    content_type: contentType,
    screenshots: screenshots.filter(item => item.cloudUrl).map(item => item.cloudUrl),
    video_url: videoUrl || '',
    video_edit: videoUrl ? normalizedVideoEdit() : null,
    video_remove_requested: moderatorVideoRemovalRequested,
    user_id: moderatorSelectedAuthor?.uid || '',
    submitted_by: moderatorSelectedAuthor?.name || '',
    ...(contentType === 'wallbang' ? {
      weapons:selectedWallbangWeapons(), target_x:wallbangTargetX, target_y:wallbangTargetY,
    } : {}),
    ...(contentType === 'defense' ? defenseSubmissionPayload() : {}),
  };
  if (isSovaArrowSelection(selectedAgent, ability)) {
    data.sova_charge = sovaCharge;
    data.sova_bounces = sovaBounces;
  }
  return data;
}

function scheduleModeratorAutosave() {
  if (!moderatorDraftSourceId || !currentUser) return;
  moderatorAutosaveDirty = true;
  clearTimeout(moderatorAutosaveTimer);
  moderatorAutosaveTimer = setTimeout(() => { flushModeratorAutosave().catch(() => {}); }, 900);
}

async function flushModeratorAutosave({ keepalive = false, reportError = false } = {}) {
  clearTimeout(moderatorAutosaveTimer);
  moderatorAutosaveTimer = null;
  if (!moderatorDraftSourceId || !currentUser || !moderatorAutosaveDirty) return true;
  if (moderatorAutosaveRequest) {
    await moderatorAutosaveRequest.catch(() => {});
    if (!moderatorAutosaveDirty) return true;
  }
  const lineupId = moderatorDraftSourceId;
  const payload = moderatorAutosavePayload();
  moderatorAutosaveDirty = false;
  moderatorAutosaveRequest = (async () => {
    const token = keepalive && moderatorAutosaveToken
      ? moderatorAutosaveToken
      : await currentUser.getIdToken();
    moderatorAutosaveToken = token;
    const response = await fetch('/api/moderation', {
      method:'POST', keepalive,
      headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
      body:JSON.stringify({ lineupId, action:'autosave_draft', data:payload }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error || `Ошибка ${response.status}`), { status: response.status });
    return true;
  })();
  try {
    await moderatorAutosaveRequest;
    return true;
  } catch (error) {
    if (error?.status === 404 || error?.status === 409) {
      moderatorAutosaveDirty = false;
      if (moderatorDraftSourceId === lineupId) {
        moderatorDraftSourceId = '';
        moderatorSelectedAuthor = null;
        moderationController?.clearClaim?.();
        try { sessionStorage.removeItem(MODERATOR_EDIT_SESSION_KEY); } catch (_) {}
        showModeratorAuthorPicker();
        toast('Это задание уже обработано или закрыто как дубль. Очередь обновлена.', 'i');
        switchWorkspaceTab('moderation');
      }
      return false;
    }
    moderatorAutosaveDirty = true;
    logUploadError(error, { action:'moderator_autosave_failed', lineup_id:lineupId, keepalive });
    if (reportError) toast('Не удалось сохранить правки модератора: ' + (error.message || error), 'e');
    return false;
  } finally {
    moderatorAutosaveRequest = null;
  }
}

async function saveModeratorProgress() {
  const lineupId = moderatorDraftSourceId;
  const button = document.getElementById('btn-save-draft');
  if (!lineupId || !currentUser || button?.disabled) return false;
  const originalText = button?.textContent || '💾 Сохранить без подтверждения';
  if (button) {
    button.disabled = true;
    button.textContent = 'Сохранение…';
  }
  try {
    clearTimeout(moderatorAutosaveTimer);
    moderatorAutosaveTimer = null;
    if (moderatorAutosaveRequest) await moderatorAutosaveRequest.catch(() => {});
    moderatorAutosaveDirty = false;
    const token = await currentUser.getIdToken();
    const response = await fetch('/api/moderation', {
      method:'POST',
      headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
      body:JSON.stringify({ lineupId, action:'save_progress', data:moderatorAutosavePayload() }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error || `Ошибка ${response.status}`), { status:response.status });
    clearModeratorVideoEditBackup(lineupId);
    moderationController?.clearClaim?.();
    moderatorDraftSourceId = '';
    moderatorSelectedAuthor = null;
    try { sessionStorage.removeItem(MODERATOR_EDIT_SESSION_KEY); } catch (_) {}
    showModeratorAuthorPicker();
    resetUploadForm();
    switchWorkspaceTab('moderation');
    await moderationController?.load?.();
    toast('Изменения сохранены без подтверждения. Лайнап остался в очереди.', 's');
    return true;
  } catch (error) {
    logUploadError(error, { action:'moderator_save_progress_failed', lineup_id:lineupId });
    toast('Не удалось сохранить без подтверждения: ' + (error.message || error), 'e');
    return false;
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function rejectModeratorDraft() {
  const lineupId = moderatorDraftSourceId;
  const button = document.getElementById('btn-reject-moderation');
  if (!lineupId || !currentUser || button?.disabled) return false;
  const reason = prompt('Что автор должен исправить? Укажи причину отказа — от 10 до 500 символов.')?.trim() || '';
  if (!reason) return false;
  if (reason.length < 10 || reason.length > 500) {
    toast('Причина должна содержать от 10 до 500 символов', 'e');
    return false;
  }
  if (!confirm('Отклонить лайнап? Автор получит указанную причину и сможет отправить материал заново.')) return false;

  const originalText = button?.textContent || '⛔ Отклонить лайнап';
  const actionButtons = ['btn-submit', 'btn-save-draft', 'btn-reject-moderation', 'btn-cancel-moderation', 'btn-reset-upload']
    .map(id => document.getElementById(id))
    .filter(Boolean);
  actionButtons.forEach(item => { item.disabled = true; });
  if (button) button.textContent = 'Отклонение…';
  try {
    clearTimeout(moderatorAutosaveTimer);
    moderatorAutosaveTimer = null;
    if (moderatorAutosaveRequest) await moderatorAutosaveRequest.catch(() => {});
    moderatorAutosaveDirty = false;
    const token = await currentUser.getIdToken();
    const response = await fetch('/api/moderation', {
      method:'POST',
      headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
      body:JSON.stringify({ lineupId, action:'reject', reason }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error || `Ошибка ${response.status}`), { status:response.status });
    clearModeratorVideoEditBackup(lineupId);
    moderationController?.clearClaim?.();
    moderatorDraftSourceId = '';
    moderatorSelectedAuthor = null;
    try { sessionStorage.removeItem(MODERATOR_EDIT_SESSION_KEY); } catch (_) {}
    showModeratorAuthorPicker();
    resetUploadForm();
    renderResubmissionBanner();
    switchWorkspaceTab('moderation');
    await moderationController?.load?.();
    toast('Лайнап отклонён, причина отправлена автору', 's');
    return true;
  } catch (error) {
    logUploadError(error, { action:'moderator_reject_failed', lineup_id:lineupId });
    toast('Не удалось отклонить лайнап: ' + (error.message || error), 'e');
    return false;
  } finally {
    actionButtons.forEach(item => { if (item.isConnected) item.disabled = false; });
    if (button?.isConnected) button.textContent = originalText;
  }
}

function hasDraftContent(draft) {
  return !!(
    draft &&
    (draft.title || draft.desc || draft.map || draft.agent || draft.ability ||
      draft.videoUrl || draft.markerX != null || draft.trajectory?.length ||
      draft.extraAbilities?.length || draft.extra_abilities?.length ||
      draft.wallbangTargetX != null || draft.wallbangWeapons?.length ||
      draft.defenseSite || draft.defenseZoomArea || draft.defenseAbilities?.length ||
      draft.screenshots?.length || draft.videoEdit?.splits?.length ||
      draft.videoEdit?.freezeFrames?.length || draft.videoEdit?.zoomKeyframes?.length ||
      draft.videoEdit?.footageOverlays?.length || Number(draft.videoEdit?.effectTracks || 1) > 1 ||
      draft.videoEdit?.audio?.muted || Number(draft.videoEdit?.audio?.volume ?? 1) !== 1 ||
      draft.videoEdit?.chromaKey?.enabled || Number(draft.videoEdit?.trimStart || 0) > 0 ||
      Number(draft.videoEdit?.trimEnd || 0) > 0 ||
      draft.resubmissionSourceId)
  );
}

function getSavedDrafts() {
  let drafts = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(_DRAFTS_KEY) || '[]');
    if (Array.isArray(parsed)) drafts = parsed;
  } catch (_) {}
  try {
    if (!localStorage.getItem(_DRAFT_MIGRATED_KEY)) {
      const legacy = JSON.parse(localStorage.getItem(_DRAFT_KEY) || 'null');
      if (hasDraftContent(legacy)) {
        const now = Date.now();
        drafts = [{
          ...legacy,
          id: `draft_${now}_legacy`,
          createdAt: now,
          updatedAt: now,
        }, ...drafts];
        localStorage.setItem(_DRAFTS_KEY, JSON.stringify(drafts));
      }
      localStorage.setItem(_DRAFT_MIGRATED_KEY, '1');
    }
  } catch (_) {}
  const safeDrafts = drafts.filter(draft => !draft?.moderatorDraftSourceId);
  if (safeDrafts.length !== drafts.length) writeSavedDrafts(safeDrafts);
  return safeDrafts.filter(hasDraftContent).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

function writeSavedDrafts(drafts) {
  try {
    localStorage.setItem(_DRAFTS_KEY, JSON.stringify(drafts.filter(hasDraftContent).slice(0, MAX_SAVED_DRAFTS)));
  } catch (_) {
    toast('Не удалось сохранить черновик: память браузера заполнена', 'e');
  }
}

function saveCurrentDraftSnapshot() {
  if (moderatorDraftSourceId) {
    toast('Модераторская проверка сохраняется только обратно в очередь', 'w');
    return;
  }
  const draft = collectDraftData();
  if (!hasDraftContent(draft)) {
    toast('Черновик пустой', 'w');
    return;
  }
  if (getSavedDrafts().length >= MAX_SAVED_DRAFTS) {
    toast(`Можно хранить не больше ${MAX_SAVED_DRAFTS} черновиков. Удали один из старых.`, 'w');
    return;
  }
  const now = Date.now();
  const id = `draft_${now}_${Math.random().toString(36).slice(2, 8)}`;
  const saved = { ...draft, id, createdAt: now, updatedAt: now };
  writeSavedDrafts([saved, ...getSavedDrafts()]);
  try {
    localStorage.setItem(_ACTIVE_DRAFT_ID_KEY, id);
    localStorage.setItem(_DRAFT_KEY, JSON.stringify(saved));
  } catch (_) {}
  renderDrafts();
  renderAuthorWorkspace();
  toast('Черновик сохранён', 's');
  resetUploadForm();
}

function saveCurrentDraftCopy(message = 'Черновик сохранён') {
  if (moderatorDraftSourceId) return false;
  const draft = collectDraftData();
  if (!hasDraftContent(draft)) return false;
  if (getSavedDrafts().length >= MAX_SAVED_DRAFTS) {
    toast(`Можно хранить не больше ${MAX_SAVED_DRAFTS} черновиков. Удали один из старых.`, 'w');
    return false;
  }
  const now = Date.now();
  const id = `draft_${now}_${Math.random().toString(36).slice(2, 8)}`;
  const saved = { ...draft, id, createdAt: now, updatedAt: now };
  writeSavedDrafts([saved, ...getSavedDrafts()]);
  renderDrafts();
  renderAuthorWorkspace();
  toast(message, 's');
  return true;
}

function categoryHasPlacedData(category = selectedCategory) {
  const normalized = normalizeContentCategory(category);
  if (normalized === 'lineup') {
    return !!(selectedAbility || markerX !== null || trajectoryPoints.length || extraAbilityTrajectories.length);
  }
  if (normalized === 'wallbang') {
    return !!(selectedWallbangWeapons().length || markerX !== null || wallbangTargetX !== null || trajectoryPoints.length);
  }
  if (normalized === 'defense') {
    return !!(defenseSiteValue() || defenseZoomArea || defenseAbilities.length);
  }
  return false;
}

function resetCategorySpecificData() {
  selectedAbility = null;
  spikeUsage = null;
  spikeX = spikeY = null;
  markerX = null;
  markerY = null;
  trajectoryPoints = [];
  extraAbilityTrajectories = [];
  selectedExtraAbilityIndex = null;
  wallbangTargetX = null;
  wallbangTargetY = null;
  defenseZoomStart = null;
  defenseZoomArea = null;
  selectedDefenseAbility = null;
  selectedDefenseMarkerIndex = null;
  defenseAbilities = [];
  defenseLineDraft = null;
  defenseLineJustCreated = false;
  sageWallHandlesHidden = false;
  mapMode = 'position';
  document.getElementById('abilities-row')?.querySelectorAll('.ability-btn').forEach(btn => btn.classList.remove('selected'));
  document.querySelectorAll('#wallbang-weapons input[type="checkbox"]').forEach(input => { input.checked = false; });
  const marker = document.getElementById('map-marker');
  if (marker) marker.style.display = 'none';
  const site = document.getElementById('defense-site');
  const number = document.getElementById('defense-number');
  if (site) site.value = '';
  if (number) number.value = '1';
  renderTrajectory();
  renderExtraAbilityPanel();
  renderCategoryMapExtras();
  renderSpikeControls();
  renderDefenseAbilityPanel();
  renderDefenseAbilityMarkers();
}

function deleteSavedDraft(id) {
  if (!id) return;
  writeSavedDrafts(getSavedDrafts().filter(draft => draft.id !== id));
  try {
    if (localStorage.getItem(_ACTIVE_DRAFT_ID_KEY) === id) {
      localStorage.removeItem(_ACTIVE_DRAFT_ID_KEY);
      localStorage.removeItem(_DRAFT_KEY);
    }
  } catch (_) {}
}

function deleteActiveSavedDraft() {
  let activeId = '';
  try { activeId = localStorage.getItem(_ACTIVE_DRAFT_ID_KEY) || ''; } catch (_) {}
  if (activeId) deleteSavedDraft(activeId);
}

function resumeSavedDraft(id) {
  const draft = getSavedDrafts().find(item => item.id === id);
  if (!draft) {
    toast('Черновик не найден', 'e');
    return;
  }
  try {
    localStorage.setItem(_ACTIVE_DRAFT_ID_KEY, id);
    localStorage.setItem(_DRAFT_KEY, JSON.stringify(draft));
  } catch (_) {}
  resetUploadForm({ keepDraft: true });
  _restoreDraft(draft);
  toast('Черновик открыт', 's');
}

function updateActiveSavedDraft(draft) {
  let activeId = '';
  try { activeId = localStorage.getItem(_ACTIVE_DRAFT_ID_KEY) || ''; } catch (_) {}
  if (!activeId) return;
  const drafts = getSavedDrafts();
  const idx = drafts.findIndex(item => item.id === activeId);
  if (idx === -1) return;
  drafts[idx] = { ...drafts[idx], ...draft, id: activeId, updatedAt: Date.now() };
  writeSavedDrafts(drafts);
}

function _saveDraft() {
  if (moderatorDraftSourceId) {
    scheduleModeratorAutosave();
    return;
  }
  try {
    const draft = collectDraftData();
    localStorage.setItem(_DRAFT_KEY, JSON.stringify(draft));
    updateActiveSavedDraft(draft);
  } catch(_) {}
}

function _clearDraft() {
  try { localStorage.removeItem(_DRAFT_KEY); } catch(_) {}
  try { localStorage.removeItem(_ACTIVE_DRAFT_ID_KEY); } catch(_) {}
  resubmissionSourceId = '';
  moderatorDraftSourceId = '';
  moderatorRewardOptIn = false;
  renderResubmissionBanner();
}

function _restoreDraft(sourceDraft = null) {
  let d = sourceDraft;
  try { if (!d) d = JSON.parse(localStorage.getItem(_DRAFT_KEY)); } catch(_) {}
  if (!d) return;
  if (!sourceDraft && d.moderatorDraftSourceId) {
    try { localStorage.removeItem(_DRAFT_KEY); } catch (_) {}
    try { localStorage.removeItem(_ACTIVE_DRAFT_ID_KEY); } catch (_) {}
    return;
  }
  resubmissionSourceId = d.resubmissionSourceId || '';
  moderatorDraftSourceId = d.moderatorDraftSourceId || '';
  moderatorRewardOptIn = d.moderatorRewardOptIn === true;
  moderatorSelectedAuthor = d.moderatorAuthor?.uid ? d.moderatorAuthor : null;
  sageWallHandlesHidden = d.sageWallHandlesHidden === true;
  showModeratorAuthorPicker(moderatorSelectedAuthor);
  renderResubmissionBanner();

  // Text fields
  if (d.title) { const el = document.getElementById('inp-title'); if (el) { el.value = d.title; document.getElementById('title-count').textContent = d.title.length; } }
  if (d.desc)  { const el = document.getElementById('inp-desc');  if (el) { el.value = d.desc;  document.getElementById('desc-count').textContent  = d.desc.length;  } }

  // Category & difficulty
  if (d.category) {
    const restoredCategory = normalizeContentCategory(d.category);
    const btn = document.querySelector(`#cat-row .pill-btn[data-val="${restoredCategory}"]`);
    if (btn && !btn.disabled && !btn.classList.contains('locked')) {
      document.getElementById('cat-row').querySelectorAll('.pill-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedCategory = restoredCategory;
      updateCategoryUi();
    }
  }
  if (d.difficulty) {
    const btn = document.querySelector(`#diff-row .pill-btn[data-val="${d.difficulty}"]`);
    if (btn) { document.getElementById('diff-row').querySelectorAll('.pill-btn').forEach(b => b.classList.remove('selected')); btn.classList.add('selected'); selectedDifficulty = d.difficulty; }
  }
  if (d.roundSide || d.round_side) {
    const side = d.roundSide || d.round_side;
    const btn = document.querySelector(`#side-row .pill-btn[data-val="${side}"]`);
    if (btn) { document.getElementById('side-row').querySelectorAll('.pill-btn').forEach(b => b.classList.remove('selected')); btn.classList.add('selected'); selectedRoundSide = side; applyMapViewTransform(); }
  }
  spikeUsage = d.spikeUsage || d.spike_usage || null;
  spikeX = d.spikeX ?? d.spike_x ?? null;
  spikeY = d.spikeY ?? d.spike_y ?? null;
  if (selectedRoundSide !== 'attack') {
    spikeUsage = null;
    spikeX = spikeY = null;
  }
  renderSpikeControls();

  // Map + marker (load minimap, then place marker after image loads)
  if (d.map) {
    const sel = document.getElementById('sel-map');
    if (sel) {
      sel.value = d.map;
      window.syncProductionMapGallery?.();
    }
    renderDefenseSiteOptions(d.defenseSite || '');
    const img = document.getElementById('map-img');
    const ph  = document.getElementById('map-placeholder');
    const apiUrl = mapsData.find(m => m.displayName === d.map)?.displayIcon;
    const url    = apiUrl || MAP_FALLBACK_URLS[d.map];
    if (url && img) {
      mapInteractionReady = false;
      img.crossOrigin = 'anonymous'; img.style.display = 'block';
      if (ph) ph.style.display = 'none';
      const afterLoad = () => {
        mapInteractionReady = true;
        applyMapViewTransform();
        if (d.mapMode) setMapMode(d.mapMode);
        if (d.trajectory?.length) { trajectoryPoints = d.trajectory; renderTrajectory(); }
        if (normalizeContentCategory(d.category) === 'wallbang' && d.wallbangTargetX != null) {
          wallbangTargetX = Number(d.wallbangTargetX);
          wallbangTargetY = Number(d.wallbangTargetY);
        }
        if (d.defenseZoomArea) {
          defenseZoomArea = d.defenseZoomArea;
        }
        if (Array.isArray(d.defenseAbilities)) {
          defenseAbilities = d.defenseAbilities
            .map((item, idx) => {
              const catalogShape = defensePlacementShape(d.agent || selectedAgent, item.ability, item.slot);
              const storedShapeKind = item.shape_kind || item.shape?.kind || 'point';
              const hasCanonicalGeometry = catalogShape.kind !== 'point' || /^deadlock$/i.test(String(d.agent || selectedAgent || '').trim());
              const shapeKind = hasCanonicalGeometry ? catalogShape.kind : storedShapeKind;
              const points = ['line_segment','sensor_rect','wall_sections'].includes(shapeKind)
                ? normalizedDefensePoints(item).map((point, pointIndex) => ({
                    ...(['sensor_rect','wall_sections'].includes(shapeKind) ? { role:pointIndex === 0 ? 'pivot' : 'rotation' } : {}),
                    x:point.x, y:point.y,
                  }))
                : [];
              const center = ['line_segment','sensor_rect','wall_sections'].includes(shapeKind)
                ? defenseAbilityCenter({ ...item, shape_kind: shapeKind, points })
                : { x: Number(item.x), y: Number(item.y) };
              return {
                ability: item.ability || '',
                slot: item.slot || '',
                icon: item.icon || '',
                x: Number(center.x),
                y: Number(center.y),
                shape_kind: shapeKind,
                shape_radius: Number(catalogShape.radius || item.shape_radius || item.shape?.radius || 0),
                shape_anchor: item.shape_anchor || catalogShape.anchor || 'edge_midpoints',
                shape_width: Number(item.shape_width || catalogShape.width || 0.12),
                shape_height: Number(item.shape_height || catalogShape.height || 0.08),
                shape_rotation: Number(item.shape_rotation ?? catalogShape.rotation ?? 0),
                active_sections: shapeKind === 'wall_sections' ? normalizedWallSections(item.active_sections) : [],
                section_count: shapeKind === 'wall_sections' ? normalizedWallSections(item.active_sections).length : 0,
                points,
                order: Number(item.order || idx + 1),
              };
            })
            .filter(item => item.ability && Number.isFinite(item.x) && Number.isFinite(item.y));
          selectedDefenseMarkerIndex = defenseAbilities.length ? defenseAbilities.length - 1 : null;
        }
        if (d.markerX != null) {
          markerX = d.markerX; markerY = d.markerY;
          setMarkerPosition(d.markerX, d.markerY);
          updateMarkerIcon();
        }
        renderCategoryMapExtras();
        renderSpikeControls();
        renderDefenseAbilityMarkers();
        refreshMapGeometryAfterLayout();
        syncConfiguredDefenseAbilityShapes();
        validateForm();
      };
      img.addEventListener('load', afterLoad, { once: true });
      img.addEventListener('error', () => {
        mapInteractionReady = false;
        logUploadError(new Error('Draft map image failed to load'), {
          action: 'draft_map_image_load_failed', map: d.map, url_host: (() => { try { return new URL(url).host; } catch (_) { return ''; } })(),
        });
        loadMapMinimap();
      }, { once: true });
      img.src = url;
      if (img.complete && img.naturalWidth) queueMicrotask(afterLoad);
    }
  }

  // Agent
  if (d.agent && agentsList.length) {
    const agent = agentsList.find(a => a.displayName === d.agent);
    if (agent) {
      const card = document.querySelector(`.agent-card[data-uuid="${agent.uuid}"]`);
      if (card) card.classList.add('selected');
      selectAgent(agent);
      if (d.ability) {
        const ability = (agent.abilities || []).find(ab =>
          ab.displayName === d.ability ||
          ab.slot === d.ability ||
          normalizeAbilityName(agent.displayName, ab.displayName, ab.slot) === d.ability
        );
        selectedAbility = normalizeAbilityName(agent.displayName, ability?.displayName || d.ability, ability?.slot || d.ability);
        sovaCharge = Math.max(0, Math.min(3, Number(d.sovaCharge ?? d.sova_charge) || 0));
        sovaBounces = Math.max(0, Math.min(2, Number(d.sovaBounces ?? d.sova_bounces) || 0));
        renderSovaShotPanel();
        const abilBtn = [...document.querySelectorAll('.ability-btn')].find(btn =>
          btn.dataset.key === selectedAbility || btn.dataset.slot === d.ability
        );
        if (abilBtn) { document.querySelectorAll('.ability-btn').forEach(b => b.classList.remove('selected')); abilBtn.classList.add('selected'); updateMarkerIcon(); }
      }
      const restoredExtras = Array.isArray(d.extraAbilities) ? d.extraAbilities : (Array.isArray(d.extra_abilities) ? d.extra_abilities : []);
      extraAbilityTrajectories = restoredExtras
        .map((item, idx) => normalizeExtraAbilityItem(item, idx))
        .filter(Boolean)
        .slice(0, 2)
        .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
        .map((item, idx) => ({ ...item, order: idx + 1 }));
      selectedExtraAbilityIndex = Number.isInteger(d.selectedExtraAbilityIndex) &&
        d.selectedExtraAbilityIndex >= 0 &&
        d.selectedExtraAbilityIndex < extraAbilityTrajectories.length
        ? d.selectedExtraAbilityIndex
        : null;
      const restoredStart = activeExtraAbility()?.trajectory?.[0];
      if (restoredStart) setMarkerPosition(restoredStart.x, restoredStart.y);
      updateMarkerIcon();
      renderExtraAbilityPanel();
      renderTrajectory();
    }
  }

  if (Array.isArray(d.wallbangWeapons)) {
    renderWallbangWeapons();
    const weapons = new Set(d.wallbangWeapons);
    document.querySelectorAll('#wallbang-weapons input[type="checkbox"]').forEach(input => {
      input.checked = weapons.has(input.value);
    });
  }
  if (d.defenseSite) {
    renderDefenseSiteOptions(d.defenseSite);
  }
  if (d.defenseNumber) {
    const el = document.getElementById('defense-number');
    if (el) el.value = d.defenseNumber;
  }
  renderDefenseAbilityPanel();
  if (defenseAbilities.length) syncConfiguredDefenseAbilityShapes();

  // Video
  if (d.videoUrl) {
    videoUrl = d.videoUrl;
    const localVideoEdit = moderatorVideoEditBackup(d.moderatorDraftSourceId || '', d.videoUrl);
    videoEdit = { ...createDefaultVideoEdit(), ...(localVideoEdit || d.videoEdit || d.video_edit || {}) };
    knownVideoDuration = Number(videoEdit.trimEnd) || 0;
    rememberCommittedVideoEdit();
    const dropZ = document.getElementById('drop-zone');
    const wrap  = document.getElementById('vid-player-wrap');
    const vid   = document.getElementById('vid-player');
    if (dropZ) dropZ.style.display = 'none';
    if (wrap)  wrap.style.display = 'none';
    if (vid)   {
      vid.dataset.corsFallback = '0';
      vid.dataset.proxyRetry = '0';
      vid.dataset.videoErrorReported = '0';
      vid.removeAttribute('src');
      vid.load();
    }
    loadCompleteVideoForEditor(d.videoUrl);
  } else {
    videoEdit = createDefaultVideoEdit();
    rememberCommittedVideoEdit();
  }

  // Screenshots (already uploaded — use cloud URL for display)
  if (d.screenshots?.length) {
    screenshots = d.screenshots.map(url => ({ localUrl: url, cloudUrl: url, uploading: false }));
    renderScreenshots();
  }

  validateForm();
}

// ── Validation ────────────────────────────────────────────────────────────────
let formValidationAttempted = false;

function validationCard(id) {
  return document.getElementById(id)?.closest('.card, .category-extra-card, .map-editor-card') || null;
}

function collectFormValidationErrors() {
  const category = normalizeContentCategory(selectedCategory || '');
  const errors = [];
  const add = (message, target, input = null) => errors.push({ message, target, input });
  const mapCard = validationCard('sel-map');
  const mapEditorCard = validationCard('map-wrap');

  if (!document.getElementById('sel-map').value) add('Выбери карту.', mapCard, document.getElementById('sel-map'));
  if (!selectedCategory) add('Выбери категорию материала.', validationCard('cat-row'));
  if (selectedCategory && !canSubmitContentCategory(selectedCategory)) add('Выбранная категория закрыта для отправки.', validationCard('cat-row'));
  if (category && categoryNeedsAgent(category) && !selectedAgent) add('Выбери агента.', validationCard('agents-grid'));
  if (categoryNeedsAbility(category) && !selectedAbility) add('Выбери способность агента.', validationCard('abilities-row'));
  if (!selectedDifficulty) add('Укажи сложность.', validationCard('diff-row'));
  if (!selectedRoundSide) add('Выбери сторону раунда.', validationCard('side-row'));
  if (!document.getElementById('inp-title').value.trim()) add('Напиши название материала.', validationCard('inp-title'), document.getElementById('inp-title'));
  const readyScreenshots = screenshots.filter(item => item.cloudUrl && !item.uploading);
  if (!readyScreenshots.length) {
    add(screenshots.some(item => item.uploading)
      ? 'Дождись окончания загрузки хотя бы одного кадра.'
      : 'Добавь хотя бы один обязательный кадр из видео.', validationCard('shots-row'));
  }

  if (category === 'lineup' && markerX === null) add('Поставь позицию броска на карте.', mapEditorCard);
  if (category === 'lineup' && selectedRoundSide === 'attack') {
    if (!['placed', 'not_used'].includes(spikeUsage)) {
      add('Укажи Spike на карте или выбери «Не используется».', mapEditorCard);
    } else if (spikeUsage === 'placed' && (spikeX === null || spikeY === null)) {
      add('Поставь Spike на карте.', mapEditorCard);
    }
  }
  if (category === 'wallbang') {
    if (!selectedWallbangWeapons().length) add('Выбери оружие для прострела.', validationCard('wallbang-weapons'));
    if (markerX === null) add('Поставь позицию выстрела на карте.', mapEditorCard);
    if (wallbangTargetX === null) add('Поставь точку попадания на карте.', mapEditorCard);
  }
  if (category === 'defense') {
    if (!defenseSiteValue()) add('Выбери плент для защитного сетапа.', validationCard('defense-site'), document.getElementById('defense-site'));
    if (!hasValidDefenseZoom()) add('Нажми Zoom и выдели область сетапа на карте.', validationCard('mode-defense-zoom'));
    if (!defenseAbilities.length) add('Расставь хотя бы одну способность на карте.', validationCard('defense-ability-row'));
  }
  return errors;
}

function renderFormValidation(errors, { focusFirst = false } = {}) {
  document.querySelectorAll('.form-validation-error').forEach(element => element.classList.remove('form-validation-error'));
  document.querySelectorAll('.field-validation-message').forEach(element => element.remove());
  document.querySelectorAll('[aria-invalid="true"]').forEach(element => element.removeAttribute('aria-invalid'));

  const grouped = new Map();
  errors.forEach(error => {
    if (!error.target) return;
    if (!grouped.has(error.target)) grouped.set(error.target, []);
    grouped.get(error.target).push(error.message);
    error.input?.setAttribute('aria-invalid', 'true');
  });
  grouped.forEach((messages, target) => {
    target.classList.add('form-validation-error');
    const message = document.createElement('div');
    message.className = 'field-validation-message';
    message.textContent = messages.join(' ');
    target.appendChild(message);
  });

  const summary = document.getElementById('form-validation-summary');
  if (summary) {
    summary.hidden = errors.length === 0;
    summary.innerHTML = errors.length
      ? `<strong>Нужно заполнить ещё ${errors.length}</strong><ul>${errors.map(error => `<li>${esc(error.message)}</li>`).join('')}</ul>`
      : '';
  }
  if (focusFirst && errors[0]?.target) {
    errors[0].target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    errors[0].input?.focus({ preventScroll: true });
  }
}

function validateForm(options = {}) {
  const errors = collectFormValidationErrors();
  const ok = !categoryTrainingGateActive && errors.length === 0;
  const button = document.getElementById('btn-submit');
  // Keep the action clickable so it can explain what is missing. Training is
  // the only state that intentionally locks the whole category.
  button.disabled = categoryTrainingGateActive;
  button.dataset.ready = ok ? 'true' : 'false';
  if (formValidationAttempted) renderFormValidation(errors, options);
  return ok;
}

function selectedAbilityAliases() {
  const agent = agentsList.find(a => a.displayName === selectedAgent);
  if (!agent) return [selectedAbility];
  const ability = (agent.abilities || []).find(ab =>
    ab.displayName === selectedAbility ||
    ab.slot === selectedAbility ||
    normalizeAbilityName(agent.displayName, ab.displayName, ab.slot) === selectedAbility
  );
  return [
    ability?.displayName,
    ability?.slot,
    selectedAbility,
    ability ? normalizeAbilityName(agent.displayName, ability.displayName, ability.slot) : null,
  ];
}

function abilityAliasesFor(abilityName) {
  const agent = agentsList.find(a => a.displayName === selectedAgent);
  if (!agent) return [abilityName];
  const ability = (agent.abilities || []).find(ab =>
    ab.displayName === abilityName ||
    ab.slot === abilityName ||
    normalizeAbilityName(agent.displayName, ab.displayName, ab.slot) === abilityName
  );
  return [
    ability?.displayName,
    ability?.slot,
    abilityName,
    ability ? normalizeAbilityName(agent.displayName, ability.displayName, ability.slot) : null,
  ];
}

async function buildExtraAbilitiesPayload(map, agentName) {
  if (!extraTrajectoriesEnabled()) return [];
  const cleanItems = extraAbilityTrajectories
    .map((item, idx) => normalizeExtraAbilityItem(item, idx))
    .filter(item => item && normalizeTrajectoryPoints(item.trajectory).length >= 2)
    .slice(0, 2);
  const payload = [];
  for (let idx = 0; idx < cleanItems.length; idx += 1) {
    const item = cleanItems[idx];
    const normalizedAbility = normalizeAbilityName(agentName, item.ability);
    const aliases = abilityAliasesFor(item.ability);
    const effect = abilityEffectShape(agentName, normalizedAbility, item.slot || '');
    const range = effect.effect_shape === 'none'
      ? 0
      : await getConfiguredRangeRadius(map, agentName, normalizedAbility, aliases);
    payload.push({
      order: idx + 1,
      ability: normalizedAbility,
      slot: item.slot || '',
      icon: item.icon || '',
      trajectory: trajectoryForSave(item),
      ...(isSovaArrowSelection(agentName, normalizedAbility) ? { sova_charge:item.sova_charge, sova_bounces:item.sova_bounces } : {}),
      range_radius: range || 0,
      effect_shape: effect.effect_shape || item.effect_shape || 'circle',
      effect_width: Number(effect.effect_width ?? item.effect_width ?? 0),
      note: item.note || '',
    });
  }
  return payload;
}

function buildSovaShotsPayload(mainAbility, extras = extraAbilityTrajectories) {
  const shots = [];
  if (isSovaArrowSelection(selectedAgent, mainAbility)) {
    shots.push({ order:1, ability:mainAbility, charge:sovaCharge, bounces:sovaBounces });
  }
  extras.forEach((item, index) => {
    if (!isSovaArrowSelection(selectedAgent, item.ability)) return;
    shots.push({
      order:index + 2,
      ability:item.ability,
      charge:Math.max(0, Math.min(3, Number(item.sova_charge ?? 3))),
      bounces:Math.max(0, Math.min(2, Number(item.sova_bounces ?? 0))),
    });
  });
  return shots;
}

// ── Submit ────────────────────────────────────────────────────────────────────
document.getElementById('btn-submit').addEventListener('click', async () => {
  formValidationAttempted = true;
  if (!validateForm({ focusFirst: true })) {
    toast('Исправь пункты, выделенные красным', 'e');
    return;
  }
  if (!currentUser) { toast('Войди в аккаунт', 'e'); return; }
  if (videoUrl && videoEditConfirmationState() !== 'confirmed') {
    openVideoEditConfirmation();
    toast('Подтверди монтаж перед отправкой', 'w');
    return;
  }
  await loadCurrentUserProfile(currentUser);
  updateUploadGate();
  if (!canCurrentUserUpload()) {
    updateUploadGate();
    toast(uploadGateMessage(), 'w');
    return;
  }

  const title = document.getElementById('inp-title').value.trim();
  const desc  = document.getElementById('inp-desc').value.trim();
  const map   = document.getElementById('sel-map').value;
  const requestedContentType = normalizeContentCategory(selectedCategory);

  if (!map || !selectedCategory || !selectedDifficulty || !selectedRoundSide ||
      (categoryNeedsAgent(requestedContentType) && !selectedAgent) ||
      (categoryNeedsAbility(requestedContentType) && !selectedAbility)) {
    toast('Заполни все обязательные поля', 'e'); return;
  }
  if (!canSubmitContentCategory(selectedCategory)) {
    toast('Эта категория пока закрыта для отправки.', 'e'); return;
  }
  if (!categoryExtrasValid(requestedContentType)) {
    toast('Заполни данные выбранной категории', 'e'); return;
  }
  if (!title) { toast('Введи название', 'e'); return; }
  if (hasCyrillic(title)) { toast('Название должно быть на английском: только позиции, например A Screens from A Lobby', 'e'); return; }
  if (title.length > 100) { toast('Название слишком длинное', 'e'); return; }
  if (desc.length > 1000) { toast('Описание слишком длинное', 'e'); return; }
  if (requestedContentType !== 'defense' && markerX === null) { toast('Поставь метку на карте', 'e'); return; }

  const uid = currentUser.uid;
  // Refresh both legacy badges and paid capabilities before applying a local
  // cooldown. If either read is unavailable, Firestore Rules decide instead.
  const cooldownAccessKnown = await _refreshCooldownAccess(uid);
  let rateLimitDiagnostics = { read: false };
  try {
    const rateDoc = await getDoc(doc(db, 'rate_limits', uid));
    rateLimitDiagnostics = {
      read: true,
      exists: rateDoc.exists(),
      last_lineup_at: diagnosticTimestamp(rateDoc.data()?.last_lineup_at),
      last_lineup_id: rateDoc.data()?.last_lineup_id || '',
      cooldown_minutes: cooldownMinutesFor(_approvedLineups),
      approved_for_cooldown: _approvedLineups,
    };
    if (rateDoc.exists()) {
      const lastAt = rateDoc.data()?.last_lineup_at?.toDate?.();
      if (lastAt) {
        const diffMin = (Date.now() - lastAt.getTime()) / 60000;
        const cooldownMin = cooldownMinutesFor(_approvedLineups);
        rateLimitDiagnostics.minutes_since_last_lineup = Math.floor(diffMin * 10) / 10;
        rateLimitDiagnostics.remaining_minutes = Math.max(0, Math.ceil(cooldownMin - diffMin));
        if (!moderatorDraftSourceId && cooldownAccessKnown && diffMin < cooldownMin) {
          toast(`Подожди ещё ${Math.ceil(cooldownMin - diffMin)} мин.`, 'w');
          return;
        }
      }
    }
  } catch (rateError) {
    rateLimitDiagnostics = {
      read: false,
      error_code: String(rateError?.code || ''),
      error_message: String(rateError?.message || rateError || '').slice(0, 500),
    };
  }

  if (screenshots.some(s => s.uploading)) {
    toast('Подожди — фото ещё загружаются…', 'i'); return;
  }
  if (!screenshots.some(item => item.cloudUrl)) {
    document.getElementById('shots-row')?.scrollIntoView({ behavior:'smooth', block:'center' });
    toast('Добавь хотя бы один кадр из видео перед отправкой', 'e');
    return;
  }

  const btn = document.getElementById('btn-submit');
  btn.disabled = true; btn.textContent = 'Отправка…';

  let normalizedAbility = '';
  let contentType = '';
  let rangeRadius = null;
  let extraAbilitiesPayload = [];
  let lineupId = '';
  // Keep the moderation target separate from the id generated for a brand-new
  // lineup. The latter intentionally stays empty while an existing draft is
  // being reviewed and previously made diagnostics report lineup_id="".
  const moderationLineupId = String(moderatorDraftSourceId || '').trim();
  let submitStage = 'prepare';
  let submittedPayloadDiagnostics = {};
  try {
    submitStage = 'normalize_ability';
    normalizedAbility = requestedContentType === 'defense'
      ? 'Defense setup'
      : categoryNeedsAbility(contentType || requestedContentType)
      ? normalizeAbilityName(selectedAgent, selectedAbility)
      : '';
    if (categoryNeedsAbility(requestedContentType) && !normalizedAbility) {
      toast('Выбери способность агента', 'e');
      btn.disabled = false; btn.textContent = moderatorDraftSourceId ? '✅ Завершить проверку' : '⬆ Отправить лайнап';
      return;
    }
    submitStage = 'load_range_radius';
    rangeRadius = requestedContentType === 'wallbang' || requestedContentType === 'defense'
      ? 0
      : await getConfiguredRangeRadius(map, selectedAgent, normalizedAbility, selectedAbilityAliases());
    submitStage = 'load_extra_abilities';
    extraAbilitiesPayload = requestedContentType === 'lineup'
      ? await buildExtraAbilitiesPayload(map, selectedAgent)
      : [];
    const submittedBy = moderatorDraftSourceId ? (moderatorSelectedAuthor?.name || '') : authorDisplayName();
    const submittedUid = moderatorDraftSourceId ? (moderatorSelectedAuthor?.uid || '') : uid;
    if (moderatorDraftSourceId && (!submittedBy || !submittedUid)) {
      toast('Выбери автора лайнапа', 'e');
      btn.disabled = false; btn.textContent = moderatorDraftSourceId ? '✅ Завершить проверку' : '⬆ Отправить лайнап';
      return;
    }
    contentType = normalizeContentCategory(selectedCategory);
    if (!canSubmitContentCategory(contentType)) {
      toast('Эта категория пока закрыта для отправки.', 'e');
      btn.disabled = false; btn.textContent = moderatorDraftSourceId ? '✅ Завершить проверку' : '⬆ Отправить лайнап';
      return;
    }
    if (contentType === 'defense') {
      submitStage = 'sync_defense_shapes';
      await syncConfiguredDefenseAbilityShapes();
    }
    if (moderationLineupId) {
      submitStage = 'moderator_draft_save';
      clearTimeout(moderatorAutosaveTimer);
      moderatorAutosaveTimer = null;
      if (moderatorAutosaveRequest) await moderatorAutosaveRequest.catch(() => {});
      moderatorAutosaveDirty = false;
      if (moderatorRewardOptIn) {
        submitStage = 'moderator_reward_review';
        const currentLineup = await getDoc(doc(db, 'lineups', moderationLineupId));
        if (!currentLineup.exists()) {
          moderationController?.clearClaim?.();
          await moderationController?.load?.();
          throw new Error('Этот лайнап уже удалён или обработан. Очередь обновлена — выбери актуальный лайнап.');
        }
        const rewardDecision = await requestModeratorRewardDecision(moderationLineupId);
        if (!rewardDecision) throw new Error('Оценка награды не сохранена. Проверка остаётся открытой.');
        const reviewResult = (await staffReviewRewardLineup({ lineup_id:moderationLineupId, ...rewardDecision })).data;
        if (rewardDecision.eligible && reviewResult?.eligible !== true) {
          toast('Сервер обнаружил дубликат: лайнап можно обработать, но награда будет 0 VP.', 'w');
        }
      }
      const token = await currentUser.getIdToken();
      const response = await fetch('/api/moderation', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lineupId: moderationLineupId,
          action: 'save_draft',
          data: {
            map, agent: selectedAgent, ability: normalizedAbility, title, description: desc,
            difficulty: selectedDifficulty, round_side: selectedRoundSide,
            ...spikeSubmissionPayload(contentType, selectedRoundSide),
            position_x: contentType === 'defense' ? 0 : markerX,
            position_y: contentType === 'defense' ? 0 : markerY,
            trajectory: contentType === 'defense' ? [] : trajectoryFromMarker(),
            extra_abilities: contentType === 'lineup' ? extraAbilitiesPayload : [], range_radius: rangeRadius,
            sova_shots: contentType === 'lineup' ? buildSovaShotsPayload(normalizedAbility, extraAbilitiesPayload) : [],
            ...(isSovaArrowSelection(selectedAgent, normalizedAbility) ? { sova_charge: sovaCharge, sova_bounces: sovaBounces } : {}),
            category: contentType, content_type: contentType,
            ...(contentType === 'defense' ? defenseSubmissionPayload() : {}),
            screenshots: screenshots.filter(s => s.cloudUrl).map(s => s.cloudUrl), video_url: videoUrl || '',
            video_edit: videoUrl ? normalizedVideoEdit() : null,
            video_remove_requested: moderatorVideoRemovalRequested,
            user_id: submittedUid, submitted_by: submittedBy,
          },
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `Ошибка ${response.status}`);
      clearModeratorVideoEditBackup(moderationLineupId);
      moderationController?.clearClaim?.();
      moderatorDraftSourceId = '';
      moderatorRewardOptIn = false;
      try { sessionStorage.removeItem(MODERATOR_EDIT_SESSION_KEY); } catch (_) {}
      moderatorSelectedAuthor = null;
      showModeratorAuthorPicker();
      resetUploadForm();
      switchWorkspaceTab('moderation');
      await moderationController?.load?.();
      toast('Изменения сохранены. Лайнап возвращён в очередь проверки.', 's');
      return;
    }
    const lineupRef = doc(collection(db, 'lineups'));
    lineupId = lineupRef.id;
    submittedPayloadDiagnostics = {
      lineup_id: lineupId,
      map,
      agent: contentType === 'wallbang' ? '' : selectedAgent,
      selected_ability: selectedAbility,
      normalized_ability: normalizedAbility,
      ability_aliases: contentType === 'lineup' ? selectedAbilityAliases() : [],
      extra_abilities_count: extraAbilitiesPayload.length,
      category: selectedCategory,
      content_type: contentType,
      difficulty: selectedDifficulty,
      round_side: selectedRoundSide,
      ...spikeSubmissionPayload(contentType, selectedRoundSide),
      range_radius: rangeRadius,
      category_extras_valid: categoryExtrasValid(contentType),
      user_id: uid,
      submitted_by: submittedBy,
      submitted_at: 'serverTimestamp()',
      rate_limit_last_lineup_at: 'serverTimestamp()',
      resubmitted_from: resubmissionSourceId || '',
      source: 'web',
      schema_version: 2,
      has_video_edit: !!videoUrl,
      ...submitFormDiagnostics({ title, desc, map, ability: normalizedAbility, contentType }),
    };
    submitStage = 'lineup_create_batch';
    const batch = writeBatch(db);
    const lineupPayload = {
      map,
      agent:         contentType === 'wallbang' ? '' : selectedAgent,
      ability:       normalizedAbility,
      title,
      description:   desc,
      video_url:     videoUrl || null,
      video_edit:    videoUrl ? normalizedVideoEdit() : null,
      ...(isSovaArrowSelection() ? { sova_charge: sovaCharge, sova_bounces: sovaBounces } : {}),
      screenshots:   screenshots.filter(s => s.cloudUrl).map(s => s.cloudUrl),
      position_x: contentType === 'defense' ? 0 : markerX,
      position_y: contentType === 'defense' ? 0 : markerY,
      trajectory: contentType === 'defense' ? [] : trajectoryFromMarker(),
      extra_abilities: contentType === 'lineup' ? extraAbilitiesPayload : [],
      sova_shots: contentType === 'lineup' ? buildSovaShotsPayload(normalizedAbility, extraAbilitiesPayload) : [],
      range_radius:  rangeRadius,
      category:      contentType,
      content_type:  contentType,
      ...(contentType === 'wallbang' ? {
        weapons: selectedWallbangWeapons(),
        target_x: wallbangTargetX,
        target_y: wallbangTargetY,
      } : {}),
      ...(contentType === 'defense' ? defenseSubmissionPayload() : {}),
      schema_version: 2,
      difficulty:    selectedDifficulty,
      round_side:    selectedRoundSide,
      ...spikeSubmissionPayload(contentType, selectedRoundSide),
      status:        'pending',
      submitted_at:  serverTimestamp(),
      user_id:       uid,
      submitted_by:  submittedBy,
      patch_version: null,
      reputation_up: 0, reputation_down: 0,
      is_outdated:   false,
      likes_count:   0,
      source:        'web',
      reward_program_opt_in: document.getElementById('reward-submit-checkbox')?.checked === true,
      ...(document.getElementById('reward-submit-checkbox')?.checked === true ? {
        reward_terms_version: rewardDashboard?.settings?.terms_version || '',
      } : {}),
      ...(resubmissionSourceId ? { resubmitted_from: resubmissionSourceId } : {}),
    };
    batch.set(doc(db, 'rate_limits', uid), {
      last_lineup_at: serverTimestamp(),
      last_lineup_id: lineupRef.id,
    }, { merge: true });
    batch.set(doc(db, 'analytics_events', `lineup_submit_${lineupRef.id}`), {
      type: 'lineup_submitted',
      lineup_id: lineupRef.id,
      uid,
      platform: 'web',
      ts: serverTimestamp(),
    });
    const invalidPayloadPaths = undefinedPaths(lineupPayload);
    if (invalidPayloadPaths.length) {
      submittedPayloadDiagnostics.removed_undefined_paths = invalidPayloadPaths.slice(0, 25);
    }
    batch.set(lineupRef, withoutUndefined(lineupPayload));
    await batch.commit();

    showSuccess();
  } catch (e) {
    await logUploadError(e, {
      action: moderationLineupId ? 'moderation.complete lineup review' : 'submit_lineup',
      stage: submitStage,
      map,
      agent: selectedAgent,
      ability: selectedAbility,
      normalized_ability: normalizedAbility,
      category: selectedCategory,
      content_type: contentType,
      lineup_id: moderationLineupId || lineupId,
      user: userDiagnostics(),
      rate_limit: rateLimitDiagnostics,
      payload: submittedPayloadDiagnostics,
      rules_expectation: {
        isValidLineupData_expected: !!submittedPayloadDiagnostics.client_ok,
        userCanCreateLineup_expected: !!userDiagnostics().can_upload,
        lineupNotOnCooldown_expected: !rateLimitDiagnostics.remaining_minutes,
      },
    });
    toast('Ошибка отправки: ' + toSafeErrorMessage(e), 'e');
    btn.disabled = false; btn.textContent = moderatorDraftSourceId ? '✅ Завершить проверку' : '⬆ Отправить лайнап';
  }
});

function showSuccess() {
  deleteActiveSavedDraft();
  _clearDraft();
  document.getElementById('success-screen').style.display = 'flex';
  if (currentUser) _updateCooldown(currentUser.uid);
}

function resetUploadForm({ keepDraft = false, keepVideo = false } = {}) {
  const retainedVideoUrl = keepVideo ? videoUrl : null;
  const retainedVideoEdit = keepVideo ? normalizedVideoEdit() : null;
  if (!keepDraft) _clearDraft();
  if (!keepDraft) moderatorRewardOptIn = false;
  selectedAgent = null; selectedAbility = null;
  const rewardCheckbox = document.getElementById('reward-submit-checkbox');
  if (rewardCheckbox) rewardCheckbox.checked = canSubmitForRewards(rewardDashboard) && !moderatorDraftSourceId;
  sovaCharge = 3; sovaBounces = 0;
  selectedCategory = null; selectedDifficulty = null; selectedRoundSide = null;
  spikeUsage = null; spikeX = spikeY = null;
  markerX = null; markerY = null;
  trajectoryPoints = [];
  extraAbilityTrajectories = [];
  selectedExtraAbilityIndex = null;
  wallbangTargetX = null; wallbangTargetY = null;
  defenseZoomStart = null;
  defenseZoomArea = null;
  selectedDefenseAbility = null;
  defenseAbilities = [];
  defenseLineDraft = null;
  defenseLineJustCreated = false;
  sageWallHandlesHidden = false;
  mapMode = 'position';
  videoUrl = retainedVideoUrl; videoEdit = retainedVideoEdit || createDefaultVideoEdit(); screenshots = [];
  if (!keepVideo) moderatorVideoRemovalRequested = false;
  rememberCommittedVideoEdit();
  videoEditUndoStack = [];
  videoEditRedoStack = [];
  writeVideoEditHistory();
  stopOutputPlayback({ keepPreview: false });
  clearFreezeHold();
  releaseFootagePreviewResources({ releaseCanvas: !keepVideo });
  setFreezeOverlay('');
  if (vidPlayer && !keepVideo) {
    releaseLocalVideoPreview();
    knownVideoDuration = 0;
    vidPlayer.pause();
    vidPlayer.removeAttribute('src');
    vidPlayer.load();
  }
  if (vidInput) vidInput.value = '';

  document.getElementById('sel-map').value = '';
  window.syncProductionMapGallery?.({ reveal: false });
  document.querySelectorAll('.agent-card').forEach(c => c.classList.remove('selected'));
  document.getElementById('abilities-row').innerHTML = '<span style="color:var(--text2);font-size:13px;">Сначала выбери агента</span>';
  document.getElementById('cat-row').querySelectorAll('.pill-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('diff-row').querySelectorAll('.pill-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('side-row').querySelectorAll('.pill-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('inp-title').value = '';
  document.getElementById('inp-desc').value = '';
  document.getElementById('defense-site').value = '';
  renderDefenseSiteOptions();
  document.querySelectorAll('#wallbang-weapons input[type="checkbox"]').forEach(input => { input.checked = false; });
  document.getElementById('title-count').textContent = '0';
  document.getElementById('desc-count').textContent = '0';
  document.getElementById('drop-zone').style.display = keepVideo && videoUrl ? 'none' : '';
  document.getElementById('vid-player-wrap').style.display = keepVideo && videoUrl ? '' : 'none';
  document.getElementById('vid-upload-progress').style.display = 'none';
  renderSovaShotPanel();
  if (keepVideo && videoUrl) renderVideoEditor();
  document.getElementById('map-img').style.display = 'none';
  document.getElementById('map-placeholder').style.display = '';
  document.getElementById('map-marker').style.display = 'none';
  document.getElementById('traj-container').innerHTML = '';
  document.getElementById('defense-ability-markers').innerHTML = '';
  document.getElementById('map-hint').textContent = 'Выбери режим и кликни на карту';
  setMapMode('position');
  updateCategoryUi();
  renderExtraAbilityPanel();
  renderScreenshots();
  document.getElementById('success-screen').style.display = 'none';
  formValidationAttempted = false;
  renderFormValidation([]);
  document.getElementById('btn-submit').disabled = false;
  document.getElementById('btn-submit').textContent = '⬆ Отправить лайнап';
  renderResubmissionBanner();
  window.scrollTo(0, 0);
}

window.addEventListener('beforeunload', () => {
  pauseAllSiteMedia();
  moderationController?.destroy?.();
  if (_statsUnsub) { _statsUnsub(); _statsUnsub = null; }
  _unsubscribeUserProfile();
  _clearCooldownTimer();
});

document.getElementById('btn-another').addEventListener('click', () => resetUploadForm());

// ── Moderator application ─────────────────────────────────────────────────────
// Firestore: moderator_applications/{uid} { username, reason, status, created_at }
// Заявки проверяются в admin_panel.html (вкладка "Заявки").
const modScreen = document.getElementById('mod-screen');

document.getElementById('mod-close').addEventListener('click', () => { modScreen.style.display = 'none'; });
modScreen.addEventListener('click', e => { if (e.target === modScreen) modScreen.style.display = 'none'; });

async function openModApplication() {
  if (!currentUser) { toast('Войди в аккаунт', 'e'); return; }
  modScreen.style.display = 'flex';
  const body = document.getElementById('mod-body');
  body.innerHTML = '<div style="color:var(--text2);padding:20px 0;text-align:center;">Загрузка…</div>';

  // Уже модератор?
  let role = 'user';
  try {
    const uDoc = await getDoc(doc(db, 'users', currentUser.uid));
    role = uDoc.data()?.role || 'user';
  } catch (_) {}
  if (role === 'moderator' || role === 'admin') {
    body.innerHTML = `<div style="padding:14px 0;color:var(--green);font-size:14px;">✅ У тебя уже есть роль <b>${esc(role)}</b>.</div>`;
    return;
  }

  // Существующая заявка?
  let app = null;
  try {
    const aDoc = await getDoc(doc(db, 'moderator_applications', currentUser.uid));
    if (aDoc.exists()) app = aDoc.data();
  } catch (_) {}

  if (app && app.status === 'pending') {
    body.innerHTML = `<div style="padding:14px 0;">
      <div style="color:var(--primary);font-size:15px;font-weight:700;margin-bottom:8px;">⏳ Заявка на рассмотрении</div>
      <div style="color:var(--text2);font-size:13px;">Ожидай решения администратора. Мы пришлём уведомление.</div>
    </div>`;
    return;
  }

  const rejected = app && app.status === 'rejected';
  body.innerHTML = `
    ${rejected ? '<div style="color:var(--red);font-size:13px;margin-bottom:10px;">Прошлая заявка отклонена. Можешь подать повторно.</div>' : ''}
    <div style="color:var(--text2);font-size:13px;margin-bottom:12px;">Расскажи, почему хочешь стать модератором и чем поможешь сообществу.</div>
    <textarea id="mod-reason" rows="5" maxlength="500" placeholder="Минимум 50 символов…"
      style="width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--r);padding:11px 13px;font-size:14px;resize:vertical;box-sizing:border-box;"></textarea>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;">
      <span id="mod-count" style="font-size:11px;color:var(--text2);">0 / мин. 50</span>
    </div>
    <button class="btn-primary" id="mod-submit" style="margin-top:14px;" disabled>Отправить заявку</button>`;

  const ta = document.getElementById('mod-reason');
  const cnt = document.getElementById('mod-count');
  const sub = document.getElementById('mod-submit');
  ta.addEventListener('input', () => {
    const len = ta.value.trim().length;
    cnt.textContent = `${len} / мин. 50`;
    cnt.style.color = len >= 50 ? 'var(--green)' : 'var(--text2)';
    sub.disabled = len < 50;
  });
  sub.addEventListener('click', submitModApplication);
}

async function submitModApplication() {
  const reason = document.getElementById('mod-reason').value.trim();
  if (reason.length < 50) { toast('Минимум 50 символов', 'e'); return; }
  const sub = document.getElementById('mod-submit');
  sub.disabled = true; sub.textContent = 'Отправка…';
  try {
    const username = currentUser.displayName || currentUser.email || 'Аноним';
    await setDoc(doc(db, 'moderator_applications', currentUser.uid), {
      username, reason, status: 'pending',
      user_email: currentUser.email || '',
      created_at: serverTimestamp(),
    });
    document.getElementById('mod-body').innerHTML =
      `<div style="padding:18px 0;text-align:center;">
        <div style="font-size:34px;">✅</div>
        <div style="color:var(--green);font-size:16px;font-weight:700;margin-top:8px;">Заявка отправлена!</div>
        <div style="color:var(--text2);font-size:13px;margin-top:6px;">Ожидай решения администратора.</div>
      </div>`;
    toast('Заявка на модератора отправлена', 's');
  } catch (e) {
    toast('Ошибка: ' + e.message, 'e');
    sub.disabled = false; sub.textContent = 'Отправить заявку';
  }
}
// ── Twitch live partner player ───────────────────────────────────────────────
let twitchLiveGeneration = 0;
let twitchLivePollTimer = null;

function loadTwitchPlayerSdk() {
  if (window.Twitch?.Player) return Promise.resolve(window.Twitch);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-twitch-player-sdk]');
    if (existing) { existing.addEventListener('load', () => resolve(window.Twitch), { once:true }); existing.addEventListener('error', reject, { once:true }); return; }
    const script = document.createElement('script');
    script.src = 'https://player.twitch.tv/js/embed/v1.js';
    script.dataset.twitchPlayerSdk = 'true';
    script.onload = () => resolve(window.Twitch);
    script.onerror = () => reject(new Error('Twitch Player SDK failed to load'));
    document.head.append(script);
  });
}

function twitchLiveClosed(config) {
  return config.remember_close !== false && sessionStorage.getItem('vlineups:twitch-live-closed') === '1';
}

function hideTwitchLivePlayer() {
  const shell = document.getElementById('twitch-live-player');
  if (shell) shell.hidden = true;
}

async function scanTwitchLiveChannels() {
  const generation = ++twitchLiveGeneration;
  clearTimeout(twitchLivePollTimer);
  try {
    const configSnap = await getDoc(doc(db, 'settings', 'twitch_streamers'));
    const config = configSnap.exists() ? configSnap.data() : null;
    const channels = Array.isArray(config?.channels)
      ? config.channels.filter(item => item?.enabled !== false && /^[a-z0-9_]{1,25}$/i.test(item?.channel || '')).sort((a,b) => Number(a.priority||0)-Number(b.priority||0))
      : [];
    if (!config?.enabled || !channels.length || twitchLiveClosed(config)) { hideTwitchLivePlayer(); return; }
    const Twitch = await loadTwitchPlayerSdk();
    const shell = document.getElementById('twitch-live-player');
    const mount = document.getElementById('twitch-live-embed');
    if (!shell || !mount || generation !== twitchLiveGeneration) return;
    shell.className = `twitch-live-player ${config.position || 'bottom-right'} is-checking`;
    shell.hidden = false;

    const tryChannel = index => {
      if (generation !== twitchLiveGeneration) return;
      if (index >= channels.length) { hideTwitchLivePlayer(); twitchLivePollTimer = setTimeout(scanTwitchLiveChannels, 180000); return; }
      const streamer = channels[index];
      mount.replaceChildren();
      let resolved = false;
      const player = new Twitch.Player('twitch-live-embed', { width:400, height:300, channel:streamer.channel, parent:[location.hostname], autoplay:config.autoplay !== false, muted:true });
      const fallback = setTimeout(() => { if (!resolved) { resolved = true; tryChannel(index + 1); } }, 12000);
      player.addEventListener(Twitch.Player.ONLINE, () => {
        if (resolved || generation !== twitchLiveGeneration) return;
        resolved = true; clearTimeout(fallback);
        document.getElementById('twitch-live-name').textContent = streamer.display_name || streamer.channel;
        shell.classList.remove('is-checking');
        player.setVolume(Math.max(0, Math.min(1, Number(config.initial_volume ?? 1) / 100)));
        player.setMuted(false);
        if (config.autoplay !== false) player.play();
        twitchLivePollTimer = setTimeout(scanTwitchLiveChannels, 180000);
      });
      player.addEventListener(Twitch.Player.OFFLINE, () => {
        if (generation !== twitchLiveGeneration) return;
        if (!resolved) { resolved = true; clearTimeout(fallback); tryChannel(index + 1); return; }
        hideTwitchLivePlayer();
        twitchLivePollTimer = setTimeout(scanTwitchLiveChannels, 60000);
      });
      player.addEventListener(Twitch.Player.PLAYBACK_BLOCKED, () => player.setMuted(true));
    };
    tryChannel(0);
  } catch (error) {
    console.warn('Twitch live scan unavailable', error);
    hideTwitchLivePlayer();
    twitchLivePollTimer = setTimeout(scanTwitchLiveChannels, 300000);
  }
}

document.getElementById('twitch-live-close')?.addEventListener('click', () => {
  sessionStorage.setItem('vlineups:twitch-live-closed', '1');
  twitchLiveGeneration += 1;
  hideTwitchLivePlayer();
});
document.getElementById('twitch-live-minimize')?.addEventListener('click', () => document.getElementById('twitch-live-player')?.classList.add('minimized'));
document.getElementById('twitch-live-restore')?.addEventListener('click', () => document.getElementById('twitch-live-player')?.classList.remove('minimized'));
queueMicrotask(scanTwitchLiveChannels);
