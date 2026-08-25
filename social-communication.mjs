import {
  collection, doc, getDoc, onSnapshot, orderBy, query, limit,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
}[char]));
const timestampMs = value => value?.toMillis?.() || 0;
const clientId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
const guildRank = key => ({
  novice:'Новичок', scout:'Разведчик', pathfinder:'Следопыт', veteran:'Ветеран', master:'Мастер',
})[String(key || '').toLowerCase()] || 'Новичок';

export function createSocialWebsite({ db, functions, toast }) {
  const calls = Object.fromEntries([
    'createMessageRequest', 'acceptMessageRequest', 'declineMessageRequest',
    'sendDirectMessage', 'markConversationRead', 'getCommunicationAvailability',
  ].map(name => [name, httpsCallable(functions, name)]));
  let user = null;
  let memberUnsubscribe = null;
  let messageUnsubscribe = null;
  let members = [];
  let activeConversation = null;
  let activeMessageDocs = [];
  const messageOutbox = new Map();
  const profileNames = new Map();

  const profileRoot = () => document.getElementById('social-profile-root');
  const dialogList = () => document.getElementById('social-dialog-list');
  const thread = () => document.getElementById('social-message-thread');

  async function resolveMemberNames(items) {
    return Promise.all(items.map(async item => {
      const known = String(item.other_username || '').trim();
      if (known && known !== item.other_uid) return item;
      const uid = String(item.other_uid || '').trim();
      if (!uid) return item;
      let name = profileNames.get(uid);
      if (name === undefined) {
        try {
          const profile = await getDoc(doc(db, 'public_profiles', uid));
          const data = profile.data() || {};
          name = String(data.username || data.display_name || data.displayName || 'Пользователь').trim() || 'Пользователь';
        } catch (_) {
          name = 'Пользователь';
        }
        profileNames.set(uid, name);
      }
      return { ...item, other_username: name };
    }));
  }

  async function showProfile(uid) {
    const root = profileRoot();
    if (!root) return;
    const normalized = String(uid || '').trim();
    if (!normalized) {
      root.innerHTML = '<div class="social-empty">Введите UID пользователя или откройте ссылку на профиль.</div>';
      return;
    }
    root.innerHTML = '<div class="social-empty">Загружаем профиль…</div>';
    const own = user?.uid === normalized;
    const [publicSnapshot, userSnapshot, statsSnapshot] = await Promise.all([
      getDoc(doc(db, 'public_profiles', normalized)),
      own ? getDoc(doc(db, 'users', normalized)) : Promise.resolve(null),
      own ? getDoc(doc(db, 'user_stats', normalized)) : Promise.resolve(null),
    ]);
    if (!publicSnapshot.exists() && !userSnapshot?.exists()) {
      root.innerHTML = '<div class="social-empty">Профиль не найден или закрыт настройками приватности.</div>';
      return;
    }
    const publicProfile = publicSnapshot.data() || {};
    const accountProfile = userSnapshot?.data?.() || {};
    const profileStats = statsSnapshot?.data?.() || {};
    const profile = own
      ? { ...publicProfile, ...profileStats, ...accountProfile }
      : publicProfile;
    const displayName = String(
      profile.display_name || profile.name || profile.username || profile.displayName || user?.displayName || user?.email || 'Игрок'
    ).trim();
    const approvedLineups = Math.max(
      Number(publicProfile.approved_lineups_count || publicProfile.approved_lineups || 0),
      Number(profileStats.approved_lineups_count || profileStats.approved_lineups || 0),
      Number(accountProfile.approved_lineups_count || accountProfile.approved_lineups || 0),
    );
    const rating = Number(profile.rating_average || 0).toFixed(1);
    const guildAchievement = publicProfile.guild_member === true
      ? `<b>🛡 ${escapeHtml(guildRank(publicProfile.guild_rank_key))} · уровень ${Math.max(1, Number(publicProfile.guild_level || 1))} · ${Math.max(0, Number(publicProfile.guild_completed_quests || 0))} заданий</b>`
      : '';
    root.innerHTML = `<article class="social-profile-card">
      <div class="social-avatar" aria-hidden="true">${escapeHtml((displayName || '?').slice(0, 1).toUpperCase())}</div>
      <div class="social-profile-copy"><span>${own ? 'Мой публичный профиль' : 'Публичный профиль'}</span><h2>${escapeHtml(displayName)}</h2>
      <p>${escapeHtml(profile.bio || 'Пользователь пока ничего о себе не написал.')}</p>
      <div class="social-profile-stats"><b>★ ${rating}</b><b>${Number(profile.reviews_count || 0)} отзывов</b><b>${approvedLineups} лайнапов</b>${guildAchievement}</div></div>
      <div class="social-profile-actions">
        <button type="button" data-profile-copy="${escapeHtml(normalized)}">Скопировать ссылку</button>
        ${own ? '' : `<button class="primary" type="button" data-profile-message="${escapeHtml(normalized)}">Написать</button>`}
      </div></article>`;
  }

  function renderMembers() {
    const root = dialogList();
    if (!root) return;
    if (!members.length) {
      root.innerHTML = '<div class="social-empty">Диалогов пока нет. Первое сообщение незнакомому человеку станет запросом.</div>';
      return;
    }
    root.innerHTML = members.map(item => `<button class="social-dialog ${activeConversation?.conversation_id === item.conversation_id ? 'active' : ''}" type="button" data-conversation="${escapeHtml(item.conversation_id)}">
      <b>${escapeHtml(item.other_username || item.other_uid || 'Пользователь')}</b><span>${escapeHtml(item.last_message_preview || 'Новый диалог')}</span>
      ${Number(item.unread_count || 0) ? `<i>${Number(item.unread_count)}</i>` : ''}</button>`).join('');
  }

  function openConversation(conversationId) {
    const member = members.find(item => item.conversation_id === conversationId);
    if (!member || !user) return;
    activeConversation = member;
    const requestActions = document.getElementById('social-request-actions');
    if (requestActions) requestActions.hidden = !(member.folder === 'requests' && member.request_state === 'pending');
    renderMembers();
    messageUnsubscribe?.();
    activeMessageDocs = [];
    renderConversationMessages();
    const messagesQuery = query(collection(db, 'conversations', conversationId, 'messages'), orderBy('created_at', 'asc'), limit(200));
    messageUnsubscribe = onSnapshot(messagesQuery, snapshot => {
      activeMessageDocs = snapshot.docs;
      renderConversationMessages();
      const lastMessage = snapshot.docs.at(-1);
      if (lastMessage) calls.markConversationRead({
        conversation_id: conversationId,
        last_message_id: lastMessage.id,
      }).catch(() => {});
    }, error => {
      if (thread()) thread().innerHTML = `<div class="social-empty">Не удалось загрузить сообщения: ${escapeHtml(error.message)}</div>`;
    });
  }

  function renderConversationMessages() {
    const root = thread();
    if (!root || !activeConversation) return;
    const delivered = activeMessageDocs.map(message => {
      const data = message.data();
      return `<div class="social-message ${data.sender_id === user.uid ? 'mine' : ''}"><span>${escapeHtml(data.text || (data.type === 'image' ? 'Фотография' : 'Сообщение'))}</span></div>`;
    }).join('');
    const pending = [...messageOutbox.values()]
      .filter(item => item.conversationId === activeConversation.conversation_id)
      .map(item => `<div class="social-message mine local-message ${item.status}" data-social-outbox-id="${escapeHtml(item.id)}"><span>${escapeHtml(item.text)}</span><small>${item.status === 'failed' ? '<b>!</b> Не отправлено' : 'Отправляется…'}</small>${item.status === 'failed' ? `<div class="local-message-actions" data-social-message-menu="${escapeHtml(item.id)}"><button type="button" data-social-message-action="retry">Отправить заново</button><button type="button" class="danger" data-social-message-action="delete">Удалить</button></div>` : ''}</div>`).join('');
    root.innerHTML = delivered || pending ? delivered + pending : '<div class="social-empty">Сообщений пока нет.</div>';
    root.scrollTop = root.scrollHeight;
  }

  async function sendToProfile(targetUid, text) {
    await calls.createMessageRequest({ target_uid: targetUid, text, client_message_id: clientId() });
    toast?.('Запрос на переписку отправлен', 's');
  }

  async function sendOutboxMessage(item) {
    item.status = 'sending';
    renderConversationMessages();
    try {
      await calls.sendDirectMessage({ conversation_id:item.conversationId, text:item.text, client_message_id:item.clientMessageId });
      messageOutbox.delete(item.id);
    } catch (error) {
      item.status = 'failed';
      item.error = error.message;
    }
    renderConversationMessages();
  }

  function subscribeMembers() {
    memberUnsubscribe?.();
    members = [];
    renderMembers();
    if (!user) return;
    memberUnsubscribe = onSnapshot(collection(db, 'conversation_members', user.uid, 'items'), async snapshot => {
      const rawMembers = snapshot.docs.map(item => ({ id: item.id, ...item.data() }))
        .sort((a, b) => timestampMs(b.last_message_at) - timestampMs(a.last_message_at));
      members = await resolveMemberNames(rawMembers);
      renderMembers();
      if (activeConversation && members.some(item => item.conversation_id === activeConversation.conversation_id)) openConversation(activeConversation.conversation_id);
    }, error => { if (dialogList()) dialogList().innerHTML = `<div class="social-empty">${escapeHtml(error.message)}</div>`; });
  }

  document.getElementById('social-profile-search-form')?.addEventListener('submit', event => {
    event.preventDefault();
    const uid = document.getElementById('social-profile-search')?.value;
    showProfile(uid).catch(error => toast?.(error.message, 'e'));
  });
  profileRoot()?.addEventListener('click', async event => {
    const copy = event.target.closest('[data-profile-copy]');
    const message = event.target.closest('[data-profile-message]');
    if (copy) {
      const url = new URL(location.href); url.searchParams.set('profile', copy.dataset.profileCopy);
      await navigator.clipboard.writeText(url.href); toast?.('Ссылка на профиль скопирована', 's');
    }
    if (message) {
      const text = prompt('Первое сообщение — это запрос. До принятия можно отправить только одно сообщение:');
      if (text?.trim()) await sendToProfile(message.dataset.profileMessage, text.trim()).catch(error => toast?.(error.message, 'e'));
    }
  });
  dialogList()?.addEventListener('click', event => {
    const button = event.target.closest('[data-conversation]');
    if (button) openConversation(button.dataset.conversation);
  });
  document.getElementById('social-message-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const input = document.getElementById('social-message-input');
    const submittedValue = input?.value || '';
    const text = submittedValue.trim();
    if (!text) return;
    if (!activeConversation) { toast?.('Сначала выберите диалог', 'e'); return; }
    input.value = '';
    const item = { id:`social-${Date.now()}-${Math.random().toString(36).slice(2)}`, clientMessageId:clientId(), conversationId:activeConversation.conversation_id, text, status:'sending' };
    messageOutbox.set(item.id, item);
    sendOutboxMessage(item);
  });

  let messageContextMenu = null;
  function closeMessageContextMenu() { messageContextMenu?.remove(); messageContextMenu = null; }
  thread()?.addEventListener('contextmenu', event => {
    const bubble = event.target.closest('[data-social-outbox-id].failed');
    if (!bubble) return;
    event.preventDefault();
    closeMessageContextMenu();
    const menu = document.createElement('div');
    menu.className = 'message-context-menu';
    menu.dataset.socialMessageMenu = bubble.dataset.socialOutboxId;
    menu.innerHTML = '<button type="button" data-social-message-action="retry">↻ Отправить заново</button><button type="button" class="danger" data-social-message-action="delete">Удалить</button>';
    document.body.append(menu);
    menu.style.left = `${Math.max(10, Math.min(event.clientX, innerWidth - menu.offsetWidth - 10))}px`;
    menu.style.top = `${Math.max(10, Math.min(event.clientY, innerHeight - menu.offsetHeight - 10))}px`;
    messageContextMenu = menu;
  });
  document.addEventListener('pointerdown', event => {
    if (messageContextMenu && !event.target.closest('.message-context-menu')) closeMessageContextMenu();
  });
  document.addEventListener('click', event => {
    const action = event.target.closest('[data-social-message-action]');
    const messageId = action?.closest('[data-social-message-menu]')?.dataset.socialMessageMenu;
    if (!action || !messageId) return;
    const item = messageOutbox.get(messageId);
    closeMessageContextMenu();
    if (!item) return;
    if (action.dataset.socialMessageAction === 'delete') {
      messageOutbox.delete(messageId);
      renderConversationMessages();
    } else {
      sendOutboxMessage(item);
    }
  });
  document.getElementById('social-request-actions')?.addEventListener('click', async event => {
    const decision = event.target.closest('[data-request-decision]')?.dataset.requestDecision;
    if (!decision || !activeConversation) return;
    try {
      const callable = decision === 'accept' ? calls.acceptMessageRequest : calls.declineMessageRequest;
      await callable({ conversation_id:activeConversation.conversation_id });
      document.getElementById('social-request-actions').hidden = true;
      toast?.(decision === 'accept' ? 'Запрос принят' : 'Запрос отклонён. Автор больше не сможет писать, пока вы сами не начнёте диалог.', 's');
    } catch (error) { toast?.(error.message, 'e'); }
  });
  document.addEventListener('workspace:activate', event => {
    if (event.detail?.tab === 'profile') showProfile(new URL(location.href).searchParams.get('profile') || user?.uid).catch(() => {});
  });

  return {
    async setUser(nextUser) {
      user = nextUser || null;
      activeConversation = null;
      activeMessageDocs = [];
      messageOutbox.clear();
      messageUnsubscribe?.(); messageUnsubscribe = null;
      const messagesTab = document.getElementById('social-messages-tab');
      if (messagesTab) messagesTab.hidden = true;
      if (!user) { subscribeMembers(); return; }
      try {
        const availability = await calls.getCommunicationAvailability({});
        if (messagesTab) messagesTab.hidden = availability.data?.messaging !== true;
        if (availability.data?.messaging === true) subscribeMembers();
        else { memberUnsubscribe?.(); members = []; renderMembers(); }
      } catch (_) { memberUnsubscribe?.(); members = []; renderMembers(); }
      showProfile(new URL(location.href).searchParams.get('profile') || user.uid).catch(() => {});
    },
  };
}
