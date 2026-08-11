import {
  collection, doc, getDoc, onSnapshot, orderBy, query, limit,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
}[char]));
const timestampMs = value => value?.toMillis?.() || 0;
const clientId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;

export function createSocialWebsite({ db, functions, toast }) {
  const calls = Object.fromEntries([
    'createMessageRequest', 'acceptMessageRequest', 'declineMessageRequest',
    'sendDirectMessage', 'markConversationRead',
  ].map(name => [name, httpsCallable(functions, name)]));
  let user = null;
  let memberUnsubscribe = null;
  let messageUnsubscribe = null;
  let members = [];
  let activeConversation = null;

  const profileRoot = () => document.getElementById('social-profile-root');
  const dialogList = () => document.getElementById('social-dialog-list');
  const thread = () => document.getElementById('social-message-thread');

  async function showProfile(uid) {
    const root = profileRoot();
    if (!root) return;
    const normalized = String(uid || '').trim();
    if (!normalized) {
      root.innerHTML = '<div class="social-empty">Введите UID пользователя или откройте ссылку на профиль.</div>';
      return;
    }
    root.innerHTML = '<div class="social-empty">Загружаем профиль…</div>';
    const snapshot = await getDoc(doc(db, 'public_profiles', normalized));
    if (!snapshot.exists()) {
      root.innerHTML = '<div class="social-empty">Профиль не найден или закрыт настройками приватности.</div>';
      return;
    }
    const profile = snapshot.data();
    const own = user?.uid === normalized;
    const rating = Number(profile.rating_average || 0).toFixed(1);
    root.innerHTML = `<article class="social-profile-card">
      <div class="social-avatar" aria-hidden="true">${escapeHtml((profile.display_name || '?').slice(0, 1).toUpperCase())}</div>
      <div class="social-profile-copy"><span>Публичный профиль</span><h2>${escapeHtml(profile.display_name || 'Игрок')}</h2>
      <p>${escapeHtml(profile.bio || 'Пользователь пока ничего о себе не написал.')}</p>
      <div class="social-profile-stats"><b>★ ${rating}</b><b>${Number(profile.reviews_count || 0)} отзывов</b><b>${Number(profile.approved_lineups_count || 0)} лайнапов</b></div></div>
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
    const messagesQuery = query(collection(db, 'conversations', conversationId, 'messages'), orderBy('created_at', 'asc'), limit(200));
    messageUnsubscribe = onSnapshot(messagesQuery, snapshot => {
      const root = thread();
      if (!root) return;
      root.innerHTML = snapshot.docs.map(message => {
        const data = message.data();
        return `<div class="social-message ${data.sender_id === user.uid ? 'mine' : ''}"><span>${escapeHtml(data.text || (data.type === 'image' ? 'Фотография' : 'Сообщение'))}</span></div>`;
      }).join('') || '<div class="social-empty">Сообщений пока нет.</div>';
      root.scrollTop = root.scrollHeight;
      const lastMessage = snapshot.docs.at(-1);
      if (lastMessage) calls.markConversationRead({
        conversation_id: conversationId,
        last_message_id: lastMessage.id,
      }).catch(() => {});
    }, error => {
      if (thread()) thread().innerHTML = `<div class="social-empty">Не удалось загрузить сообщения: ${escapeHtml(error.message)}</div>`;
    });
  }

  async function sendToProfile(targetUid, text) {
    await calls.createMessageRequest({ target_uid: targetUid, text, client_message_id: clientId() });
    toast?.('Запрос на переписку отправлен', 's');
  }

  async function sendCurrent(text) {
    if (!activeConversation) throw new Error('Сначала выберите диалог');
    await calls.sendDirectMessage({ conversation_id: activeConversation.conversation_id, text, client_message_id: clientId() });
  }

  function subscribeMembers() {
    memberUnsubscribe?.();
    members = [];
    renderMembers();
    if (!user) return;
    memberUnsubscribe = onSnapshot(collection(db, 'conversation_members', user.uid, 'items'), snapshot => {
      members = snapshot.docs.map(item => ({ id: item.id, ...item.data() }))
        .sort((a, b) => timestampMs(b.last_message_at) - timestampMs(a.last_message_at));
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
    const text = input?.value.trim();
    if (!text) return;
    try { await sendCurrent(text); input.value = ''; } catch (error) { toast?.(error.message, 'e'); }
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
    setUser(nextUser) {
      user = nextUser || null;
      activeConversation = null;
      messageUnsubscribe?.(); messageUnsubscribe = null;
      subscribeMembers();
      if (user) showProfile(new URL(location.href).searchParams.get('profile') || user.uid).catch(() => {});
    },
  };
}
