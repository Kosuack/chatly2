'use strict';

// ---------- утилиты ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const timeOf = (t) => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dateOf = (t) => {
  const d = new Date(t);
  const day = d.toDateString() === new Date().toDateString() ? 'Сегодня' : d.toLocaleDateString('ru-RU');
  return `${day} в ${timeOf(t)}`;
};
const initials = (name) => esc(String(name || '?').trim().slice(0, 2).toUpperCase());
const QUICK_EMOJI = ['👍', '❤️', '😂', '🎉', '😮'];
const COMPACT_MS = 7 * 60 * 1000;
const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_FILE = 8 * 1024 * 1024;
const MAX_PENDING = 4;
// Несколько STUN-серверов на случай, если один недоступен в сети друга.
// TURN — запасной ретранслятор: звук пойдёт через него, если прямое соединение не проходит.
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
};

const input = $('#input');

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// Безопасное форматирование: сначала экранируем всё, потом добавляем разметку.
function formatContent(text) {
  let s = esc(text);
  const blocks = [];
  s = s.replace(/```([\s\S]+?)```/g, (_, code) => {
    blocks.push(code);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  s = s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*\n]+)\*/g, '<i>$1</i>')
    .replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`)
    .replace(/\n/g, '<br>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<pre>${blocks[i]}</pre>`);
}

// ---------- состояние ----------
let token = localStorage.getItem('chatly_token');
const S = {
  me: null,
  guilds: new Map(),
  channels: new Map(),
  users: new Map(),
  online: new Set(),
  view: 'home',         // 'home' или id сервера
  channelId: null,      // только текстовые каналы и личные диалоги
  messages: new Map(),  // channelId -> [message]
  hasMore: new Map(),
  unread: new Set(),
  typing: new Map(),    // ключ -> { channelId, name, timer }
  replyTo: null,
  editing: null,
  pending: [],          // прикреплённые картинки: [{ file, preview }]
  es: null,
  // голос
  voice: new Map(),         // channelId -> [{ userId, muted, deafened }]
  voiceChannelId: null,     // где я сейчас
  voiceJoined: false,       // сервер подтвердил вход
  localStream: null,
  muted: false,
  deafened: false,
  peers: new Map(),         // userId -> { pc, ctx, gain, pending }
  volumes: JSON.parse(localStorage.getItem('chatly_volumes') || '{}'), // userId -> %
};

// ---------- сеть ----------
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token) logout(true);
    throw new Error(data.error || 'Ошибка сети');
  }
  return data;
}

async function uploadFile(file) {
  const res = await fetch('/api/uploads', {
    method: 'POST',
    headers: { 'Content-Type': file.type, Authorization: 'Bearer ' + token },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Не удалось загрузить картинку');
  return data.url;
}

// ---------- вход / выход ----------
let authMode = 'login';
function renderAuth() {
  const reg = authMode === 'register';
  $('#auth-title').textContent = reg ? 'Создать аккаунт' : 'Вход в Chatly';
  $('#auth-sub').textContent = reg ? 'Придумайте имя и пароль' : 'Рады видеть вас снова!';
  $('#auth-submit').textContent = reg ? 'Зарегистрироваться' : 'Войти';
  $('#auth-toggle').textContent = reg ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Зарегистрироваться';
  $('.reg-only').classList.toggle('hidden', !reg);
  $('#auth-error').textContent = '';
}
function showAuth() {
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  renderAuth();
}
$('#auth-toggle').onclick = () => {
  authMode = authMode === 'login' ? 'register' : 'login';
  renderAuth();
};
$('#auth-form').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { username: f.username.value, password: f.password.value };
  if (authMode === 'register') body.displayName = f.displayName.value;
  try {
    const data = await api('POST', authMode === 'register' ? '/api/register' : '/api/login', body);
    token = data.token;
    localStorage.setItem('chatly_token', token);
    f.password.value = '';
    await start();
  } catch (err) {
    $('#auth-error').textContent = err.message;
  }
};

function logout(silent) {
  if (token && !silent) api('POST', '/api/logout').catch(() => {});
  cleanupVoice();
  token = null;
  localStorage.removeItem('chatly_token');
  if (S.es) S.es.close();
  Object.assign(S, { me: null, es: null, view: 'home', channelId: null, replyTo: null, editing: null });
  S.guilds.clear(); S.channels.clear(); S.users.clear(); S.online.clear();
  S.messages.clear(); S.hasMore.clear(); S.unread.clear(); S.typing.clear(); S.voice.clear();
  S.pending.forEach((p) => URL.revokeObjectURL(p.preview));
  S.pending = [];
  showAuth();
}
$('#logout').onclick = () => logout(false);

async function start() {
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  await loadState();
  connectEvents();
}

async function boot() {
  if (!token) return showAuth();
  try {
    await start();
  } catch {
    showAuth();
  }
}

// ---------- данные ----------
async function loadState() {
  const st = await api('GET', '/api/state');
  S.me = st.me;
  S.guilds = new Map(st.guilds.map((g) => [g.id, g]));
  S.channels = new Map(st.channels.map((c) => [c.id, c]));
  S.users = new Map(st.users.map((u) => [u.id, u]));
  S.online = new Set(st.online);
  S.voice = new Map(st.voice.map((v) => [v.channelId, v.participants]));

  if (S.view !== 'home' && !S.guilds.has(S.view)) S.view = 'home';
  const cur = S.channels.get(S.channelId);
  if (!cur || cur.type === 'voice') S.channelId = firstChannelId();

  // голосовой канал исчез или сервер нас отключил — выходим
  if (S.voiceChannelId) {
    const gone = !S.channels.has(S.voiceChannelId);
    const dropped = S.voiceJoined && !(S.voice.get(S.voiceChannelId) || []).some((p) => p.userId === S.me.id);
    if (gone || dropped) {
      cleanupVoice();
      toast('Вы вышли из голосового канала');
    }
  }
  renderAll();
  ensureChannelLoaded();
}

function listChannelsForView() {
  if (S.view === 'home') return [...S.channels.values()].filter((c) => c.type === 'dm');
  const g = S.guilds.get(S.view);
  return g ? g.channelIds.map((id) => S.channels.get(id)).filter(Boolean) : [];
}
function firstChannelId() {
  return listChannelsForView().find((c) => c.type !== 'voice')?.id ?? null;
}

async function loadMessages(cid, before) {
  const q = before ? `?before=${encodeURIComponent(before)}` : '';
  const data = await api('GET', `/api/channels/${cid}/messages${q}`);
  const current = before ? (S.messages.get(cid) || []) : [];
  S.messages.set(cid, [...data.messages, ...current]);
  S.hasMore.set(cid, data.hasMore);
}

async function ensureChannelLoaded() {
  const id = S.channelId;
  if (!id || S.messages.has(id)) return;
  try {
    await loadMessages(id);
  } catch (err) {
    toast(err.message);
    return;
  }
  if (S.channelId === id) {
    renderMessages();
    scrollBottom(true);
  }
}

// ---------- навигация ----------
function setView(id) {
  S.view = id;
  S.replyTo = null;
  S.editing = null;
  S.channelId = firstChannelId();
  renderAll();
  ensureChannelLoaded();
}

function openChannel(id) {
  const c = S.channels.get(id);
  if (!c) return;
  if (c.type === 'voice') return joinVoice(id);
  S.channelId = id;
  S.unread.delete(id);
  S.replyTo = null;
  S.editing = null;
  input.value = '';
  autosize();
  renderAll();
  ensureChannelLoaded();
  input.focus();
}

// ---------- рендер ----------
function renderAll() {
  renderUser();
  renderGuilds();
  renderSidebar();
  renderChatHeader();
  renderMessages();
  renderMembers();
  renderBars();
  renderTyping();
  renderPending();
  renderVoicePanel();
}

function renderUser() {
  if (!S.me) return;
  const av = $('#me-avatar');
  av.style.background = S.me.color;
  av.innerHTML = initials(S.me.displayName);
  $('#me-name').textContent = S.me.displayName;
  $('#me-handle').textContent = '@' + S.me.username;
}

function renderGuilds() {
  const home = `<button class="guild home ${S.view === 'home' ? 'active' : ''}" data-view="home" title="Личные сообщения">C</button><div class="sep"></div>`;
  const list = [...S.guilds.values()].map((g) => `
    <button class="guild ${S.view === g.id ? 'active' : ''}" data-view="${g.id}" title="${esc(g.name)}">${initials(g.name)}</button>`).join('');
  $('#guilds').innerHTML = home + list +
    `<div class="sep"></div><button class="guild add" id="add-guild" title="Создать сервер">+</button>` +
    `<button class="guild join" id="join-guild" title="Вступить по приглашению">⤵</button>`;
}

function renderSidebar() {
  const header = $('#sidebar-header');
  const body = $('#sidebar-body');

  if (S.view === 'home') {
    header.innerHTML = `<span>Личные сообщения</span><button class="icon-btn" id="new-dm" title="Новый диалог">+</button>`;
    const dms = listChannelsForView();
    body.innerHTML = dms.length
      ? dms.map((c) => {
          const other = S.users.get(c.participants.find((id) => id !== S.me.id));
          const name = other?.displayName || 'Неизвестный';
          return `<div class="chan ${S.channelId === c.id ? 'active' : ''} ${S.unread.has(c.id) ? 'unread' : ''}" data-channel="${c.id}">
            <span class="avatar xs" style="background:${other?.color || '#777'}">${initials(name)}</span>
            <span class="name">${esc(name)}</span></div>`;
        }).join('')
      : `<p class="muted pad">Пока нет диалогов. Нажмите «+», чтобы написать кому-нибудь.</p>`;
    return;
  }

  const g = S.guilds.get(S.view);
  if (!g) return;
  const isOwner = g.ownerId === S.me.id;
  const chans = listChannelsForView();
  header.innerHTML = `<span class="truncate"><strong>${esc(g.name)}</strong></span>
    <span class="hdr-actions">
      <button class="icon-btn" id="invite" title="Пригласить">🔗</button>
      <button class="icon-btn" id="leave" title="Покинуть сервер">🚪</button>
    </span>`;
  body.innerHTML = `<div class="section"><span>Каналы</span>
      <button class="icon-btn" id="new-channel" title="Создать канал">+</button></div>` +
    chans.map((c) => {
      const del = isOwner && chans.length > 1
        ? `<button class="icon-btn del" data-del="${c.id}" title="Удалить канал">✕</button>` : '';
      if (c.type === 'voice') {
        return `<div class="chan voice ${S.voiceChannelId === c.id ? 'active' : ''}" data-voice="${c.id}">
            <span class="hash">🔊</span><span class="name">${esc(c.name)}</span>${del}</div>
          <div class="vusers">${voiceUsersHTML(c.id)}</div>`;
      }
      return `<div class="chan ${S.channelId === c.id ? 'active' : ''} ${S.unread.has(c.id) ? 'unread' : ''}" data-channel="${c.id}">
          <span class="hash">#</span><span class="name">${esc(c.name)}</span>${del}</div>`;
    }).join('');
}

function voiceUsersHTML(cid) {
  return (S.voice.get(cid) || []).map((p) => {
    const u = S.users.get(p.userId) || { displayName: '?', color: '#777' };
    const isMe = p.userId === S.me.id;
    const vol = S.volumes[p.userId] ?? 100;
    return `<div class="vuser">
      <span class="avatar xs" style="background:${u.color}">${initials(u.displayName)}</span>
      <span class="name">${esc(u.displayName)}</span>
      <span class="vicons">${p.muted ? '🔇' : ''}${p.deafened ? '🔕' : ''}</span>
      ${isMe ? '' : `<input type="range" class="vol" min="0" max="200" value="${vol}" data-vol="${p.userId}" title="Громкость: ${vol}%">`}
    </div>`;
  }).join('');
}

function renderChatHeader() {
  const c = S.channels.get(S.channelId);
  if (!c) {
    $('#chat-icon').textContent = '';
    $('#chat-title').textContent = '';
    $('#chat-topic').textContent = '';
    return;
  }
  if (c.type === 'dm') {
    const other = S.users.get(c.participants.find((id) => id !== S.me.id));
    $('#chat-icon').textContent = '@';
    $('#chat-title').textContent = other?.displayName || 'Неизвестный';
    $('#chat-topic').textContent = other ? '@' + other.username : '';
  } else {
    $('#chat-icon').textContent = '#';
    $('#chat-title').textContent = c.name;
    $('#chat-topic').textContent = '';
  }
}

function renderMessages() {
  const box = $('#messages');
  const cid = S.channelId;
  if (!cid) {
    box.innerHTML = `<div class="empty"><div class="big-hash">💬</div><h3>Выберите диалог или канал</h3>
      <p class="muted">Слева — список. Или создайте новый сервер.</p></div>`;
    return;
  }
  const list = S.messages.get(cid);
  if (!list) {
    box.innerHTML = `<div class="empty muted">Загрузка…</div>`;
    return;
  }
  const channel = S.channels.get(cid);
  const isOwner = channel.type === 'text' && S.guilds.get(channel.guildId)?.ownerId === S.me.id;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;

  let html = list.length ? '' : `<div class="empty">
      <div class="big-hash">${channel.type === 'dm' ? '@' : '#'}</div>
      <h3>${channel.type === 'dm' ? 'Начало диалога' : 'Добро пожаловать в #' + esc(channel.name)}</h3>
      <p class="muted">Напишите первое сообщение!</p></div>`;

  let prev = null;
  let lastDay = '';
  for (const m of list) {
    const day = new Date(m.createdAt).toDateString();
    if (day !== lastDay) {
      const label = new Date(m.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
      html += `<div class="divider"><span>${label}</span></div>`;
      lastDay = day;
      prev = null;
    }
    html += messageHTML(m, prev, list, isOwner);
    prev = m;
  }
  box.innerHTML = html;
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

function messageHTML(m, prev, list, isOwner) {
  const author = S.users.get(m.authorId) || { displayName: 'Неизвестный', color: '#80848e' };
  const mine = m.authorId === S.me.id;
  const compact = prev && prev.authorId === m.authorId && m.createdAt - prev.createdAt < COMPACT_MS && !m.replyTo;

  let replyHtml = '';
  if (m.replyTo) {
    const r = list.find((x) => x.id === m.replyTo);
    const ra = r && S.users.get(r.authorId);
    replyHtml = `<div class="reply-ref">↪ ${r
      ? `<b style="color:${ra?.color || '#aaa'}">${esc(ra?.displayName || '')}</b> ${esc(r.content.slice(0, 80))}`
      : '<i>Сообщение удалено</i>'}</div>`;
  }

  const reactions = Object.entries(m.reactions || {}).map(([emo, ids]) => `
    <button class="reaction ${ids.includes(S.me.id) ? 'mine' : ''}" data-react="${m.id}" data-emoji="${esc(emo)}">
      ${esc(emo)} <span>${ids.length}</span></button>`).join('');

  const attachments = (m.attachments || []).map((u) => `
    <a href="${esc(u)}" target="_blank" rel="noopener"><img class="att" src="${esc(u)}" alt="картинка" loading="lazy"></a>`).join('');

  const tools = `<div class="toolbar">
      ${QUICK_EMOJI.map((e) => `<button data-react="${m.id}" data-emoji="${e}" title="Реакция">${e}</button>`).join('')}
      <button data-reply="${m.id}" title="Ответить">↩</button>
      ${mine ? `<button data-edit="${m.id}" title="Редактировать">✎</button>` : ''}
      ${mine || isOwner ? `<button data-delete="${m.id}" title="Удалить">🗑</button>` : ''}
    </div>`;

  const avatar = compact
    ? `<span class="time-mini">${timeOf(m.createdAt)}</span>`
    : `<div class="avatar" style="background:${author.color}">${initials(author.displayName)}</div>`;
  const head = compact ? '' : `<div class="msg-head">
      <strong style="color:${author.color}">${esc(author.displayName)}</strong>
      <time>${dateOf(m.createdAt)}</time></div>`;

  return `<div class="msg ${compact ? 'compact' : ''}" data-mid="${m.id}">
    ${avatar}
    <div class="msg-body">
      ${head}${replyHtml}
      ${m.content ? `<div class="content">${formatContent(m.content)}${m.editedAt ? '<span class="edited">(изменено)</span>' : ''}</div>` : ''}
      ${attachments ? `<div class="attachments">${attachments}</div>` : ''}
      ${reactions ? `<div class="reactions">${reactions}</div>` : ''}
    </div>
    ${tools}
  </div>`;
}

function renderMembers() {
  const el = $('#members');
  const g = S.view !== 'home' ? S.guilds.get(S.view) : null;
  if (!g) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  const users = g.memberIds.map((id) => S.users.get(id)).filter(Boolean);
  const on = users.filter((u) => S.online.has(u.id));
  const off = users.filter((u) => !S.online.has(u.id));
  const row = (u) => `<div class="member ${S.online.has(u.id) ? '' : 'offline'}">
      <span class="avatar sm" style="background:${u.color}">${initials(u.displayName)}<i class="dot"></i></span>
      <span class="name">${esc(u.displayName)}${g.ownerId === u.id ? ' 👑' : ''}</span></div>`;
  el.innerHTML = `<div class="section">В сети — ${on.length}</div>${on.map(row).join('')}
    <div class="section">Не в сети — ${off.length}</div>${off.map(row).join('')}`;
}

function renderBars() {
  const bar = $('#reply-bar');
  const channel = S.channels.get(S.channelId);
  if (S.replyTo) {
    const m = findLocal(S.replyTo);
    const name = S.users.get(m?.authorId)?.displayName || '';
    bar.innerHTML = `Ответ для <b>${esc(name)}</b> <button class="icon-btn" data-cancel-bar title="Отменить">✕</button>`;
    bar.classList.remove('hidden');
  } else if (S.editing) {
    bar.innerHTML = `Редактирование сообщения <button class="icon-btn" data-cancel-bar title="Отменить">✕</button>`;
    bar.classList.remove('hidden');
  } else {
    bar.classList.add('hidden');
  }
  input.placeholder = !channel ? 'Нет открытого чата'
    : channel.type === 'dm'
      ? `Написать @${S.users.get(channel.participants.find((id) => id !== S.me.id))?.username || ''}`
      : `Написать в #${channel.name}`;
}

function renderTyping() {
  const names = [...S.typing.values()]
    .filter((t) => t.channelId === S.channelId)
    .map((t) => esc(t.name));
  $('#typing').innerHTML = names.length
    ? `<b>${names.join(', ')}</b> ${names.length > 1 ? 'печатают' : 'печатает'}…`
    : '';
}

function renderPending() {
  const el = $('#pending');
  el.classList.toggle('hidden', !S.pending.length);
  el.innerHTML = S.pending.map((p, i) => `
    <div class="pend"><img src="${p.preview}" alt=""><button class="pend-x" data-rm="${i}" title="Убрать">✕</button></div>`).join('');
}

// ---------- голос ----------
function renderVoicePanel() {
  const el = $('#voice-panel');
  const cid = S.voiceChannelId;
  if (!cid) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  const c = S.channels.get(cid);
  const others = (S.voice.get(cid) || []).filter((p) => p.userId !== S.me.id).length;
  const linked = [...S.peers.values()].filter((p) => p.pc.connectionState === 'connected').length;
  const status = !S.voiceJoined
    ? 'Подключение к серверу…'
    : others === 0
      ? 'Вы один в канале'
      : `Соединено: ${linked} из ${others}`;
  el.classList.remove('hidden');
  el.innerHTML = `
    <div class="vp-status">
      <span class="vp-dot ${S.voiceJoined && (others === 0 || linked === others) ? 'ok' : ''}"></span>
      <div class="vp-text">
        <strong>${status}</strong>
        <span class="muted truncate">🔊 ${esc(c?.name || '')}</span>
      </div>
    </div>
    <div class="vp-buttons">
      <button class="vp-btn ${S.muted ? 'off' : ''}" data-vmute title="${S.muted ? 'Включить микрофон' : 'Выключить микрофон'}">${S.muted ? '🔇' : '🎤'}</button>
      <button class="vp-btn ${S.deafened ? 'off' : ''}" data-vdeaf title="${S.deafened ? 'Включить звук' : 'Заглушить всех'}">${S.deafened ? '🔕' : '🎧'}</button>
      <button class="vp-btn leave" data-vleave title="Отключиться">📞</button>
    </div>`;
}

async function joinVoice(cid) {
  if (S.voiceChannelId === cid) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    return toast('Голос работает только по https или на localhost');
  }
  await leaveVoice();
  try {
    S.localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
  } catch {
    return toast('Нет доступа к микрофону. Разрешите его в настройках браузера.');
  }
  S.voiceChannelId = cid;
  S.muted = false;
  S.deafened = false;
  applyLocalAudio();
  renderAll();
  try {
    await api('POST', `/api/channels/${cid}/voice/join`);
    S.voiceJoined = true;
  } catch (err) {
    cleanupVoice();
    toast(err.message);
  }
  renderAll();
}

async function leaveVoice() {
  if (!S.voiceChannelId) return;
  const cid = S.voiceChannelId;
  const wasJoined = S.voiceJoined;
  cleanupVoice();
  if (wasJoined) api('POST', `/api/channels/${cid}/voice/leave`).catch(() => {});
  renderAll();
}

function cleanupVoice() {
  for (const id of [...S.peers.keys()]) closePeer(id);
  S.localStream?.getTracks().forEach((t) => t.stop());
  S.localStream = null;
  S.voiceChannelId = null;
  S.voiceJoined = false;
}

function applyVoiceState(cid, participants) {
  if (participants.length) S.voice.set(cid, participants);
  else S.voice.delete(cid);

  if (cid === S.voiceChannelId && S.localStream) {
    if (S.voiceJoined && !participants.some((p) => p.userId === S.me.id)) {
      cleanupVoice();
      toast('Вы вышли из голосового канала');
      renderAll();
      return;
    }
    syncPeers(participants);
  }
  renderSidebar();
  renderVoicePanel();
}

function syncPeers(participants) {
  const wanted = new Set(participants.map((p) => p.userId).filter((id) => id !== S.me.id));
  for (const id of wanted) {
    if (!S.peers.has(id)) {
      getPeer(id);
      // чтобы не было двух встречных предложений, offer отправляет тот, чей id меньше
      if (S.me.id < id) makeOffer(id);
    }
  }
  for (const id of [...S.peers.keys()]) {
    if (!wanted.has(id)) closePeer(id);
  }
  applyAllVolumes();
}

function getPeer(id) {
  let peer = S.peers.get(id);
  if (peer) return peer;
  const pc = new RTCPeerConnection(RTC_CONFIG);
  peer = { pc, ctx: null, gain: null, pending: [] };
  S.localStream.getTracks().forEach((t) => pc.addTrack(t, S.localStream));
  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal(id, { candidate: e.candidate });
  };
  pc.ontrack = (e) => attachRemote(id, e.streams[0] || new MediaStream([e.track]));
  pc.onconnectionstatechange = () => {
    renderVoicePanel();
    if (pc.connectionState === 'failed') toast('Не удалось соединиться с участником голосового канала');
  };
  S.peers.set(id, peer);
  return peer;
}

async function makeOffer(id) {
  const { pc } = getPeer(id);
  try {
    await pc.setLocalDescription(await pc.createOffer());
    sendSignal(id, { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
  } catch (err) {
    console.warn('offer failed', err);
  }
}

async function onVoiceSignal({ channelId, from, data }) {
  if (channelId !== S.voiceChannelId || !S.localStream) return;
  const peer = getPeer(from);
  const pc = peer.pc;
  try {
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      const queued = peer.pending.splice(0);
      for (const c of queued) await pc.addIceCandidate(c).catch(() => {});
      if (data.sdp.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        sendSignal(from, { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
      }
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
      else peer.pending.push(data.candidate);
    }
  } catch (err) {
    console.warn('signal error', err);
  }
}

function sendSignal(to, data) {
  if (!S.voiceChannelId) return;
  api('POST', `/api/channels/${S.voiceChannelId}/voice/signal`, { to, data }).catch(() => {});
}

function attachRemote(id, stream) {
  const peer = S.peers.get(id);
  if (!peer) return;
  if (peer.ctx) peer.ctx.close();
  // Web Audio позволяет громкость выше 100% и мгновенно заглушать участника
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const gain = ctx.createGain();
  ctx.createMediaStreamSource(stream).connect(gain);
  gain.connect(ctx.destination);
  ctx.resume?.().catch(() => {});
  peer.ctx = ctx;
  peer.gain = gain;
  applyVolume(id);
}

function applyVolume(id) {
  const peer = S.peers.get(id);
  if (!peer?.gain) return;
  const pct = S.volumes[id] ?? 100;
  peer.gain.gain.value = S.deafened ? 0 : pct / 100;
}

function applyAllVolumes() {
  for (const id of S.peers.keys()) applyVolume(id);
}

function closePeer(id) {
  const peer = S.peers.get(id);
  if (!peer) return;
  peer.pc.close();
  peer.ctx?.close();
  S.peers.delete(id);
}

function applyLocalAudio() {
  if (S.deafened) S.muted = true; // заглушённый всегда без микрофона
  S.localStream?.getAudioTracks().forEach((t) => { t.enabled = !S.muted; });
  applyAllVolumes();
}

function sendVoiceState() {
  if (!S.voiceJoined) return;
  api('PATCH', `/api/channels/${S.voiceChannelId}/voice/state`, {
    muted: S.muted,
    deafened: S.deafened,
  }).catch(() => {});
}

function toggleMute() {
  if (!S.voiceJoined) return;
  if (S.deafened) return toast('Сначала включите звук');
  S.muted = !S.muted;
  applyLocalAudio();
  sendVoiceState();
  renderVoicePanel();
}

function toggleDeafen() {
  if (!S.voiceJoined) return;
  S.deafened = !S.deafened;
  applyLocalAudio();
  sendVoiceState();
  renderVoicePanel();
}

// ---------- сообщения: локальные операции ----------
function findLocal(mid) {
  return (S.messages.get(S.channelId) || []).find((m) => m.id === mid);
}
function isNearBottom() {
  const box = $('#messages');
  return box.scrollHeight - box.scrollTop - box.clientHeight < 120;
}
function scrollBottom(force) {
  const box = $('#messages');
  if (force || isNearBottom()) box.scrollTop = box.scrollHeight;
}

function addMessage(m) {
  const list = S.messages.get(m.channelId);
  if (!list) {
    if (m.authorId !== S.me.id) S.unread.add(m.channelId);
    renderSidebar();
    return;
  }
  if (list.some((x) => x.id === m.id)) return;
  const wasNear = isNearBottom();
  list.push(m);
  if (m.channelId === S.channelId) {
    renderMessages();
    if (wasNear || m.authorId === S.me.id) scrollBottom(true);
  } else {
    if (m.authorId !== S.me.id) S.unread.add(m.channelId);
    renderSidebar();
  }
}

function updateMessage(m) {
  const list = S.messages.get(m.channelId);
  if (!list) return;
  const i = list.findIndex((x) => x.id === m.id);
  if (i >= 0) list[i] = m;
  if (m.channelId === S.channelId) renderMessages();
}

function removeMessage(id, channelId) {
  const list = S.messages.get(channelId);
  if (!list) return;
  S.messages.set(channelId, list.filter((x) => x.id !== id));
  if (channelId === S.channelId) renderMessages();
}

// ---------- отправка и действия ----------
function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
}

function cancelBar() {
  S.replyTo = null;
  if (S.editing) input.value = '';
  S.editing = null;
  autosize();
  renderBars();
}

function addFiles(fileList) {
  for (const file of fileList) {
    if (!IMAGE_MIME.includes(file.type)) {
      toast('Можно прикреплять только картинки (PNG, JPG, GIF, WebP)');
      continue;
    }
    if (file.size > MAX_FILE) {
      toast(`«${file.name}» больше 8 МБ`);
      continue;
    }
    if (S.pending.length >= MAX_PENDING) {
      toast(`Не больше ${MAX_PENDING} картинок за раз`);
      break;
    }
    S.pending.push({ file, preview: URL.createObjectURL(file) });
  }
  renderPending();
}

async function sendMessage() {
  const text = input.value.trim();
  const cid = S.channelId;
  if (!cid || (!text && !S.pending.length)) return;

  if (S.editing) {
    if (!text) return;
    const editing = S.editing;
    input.value = '';
    S.editing = null;
    autosize();
    renderBars();
    try {
      const m = await api('PATCH', `/api/channels/${cid}/messages/${editing}`, { content: text });
      updateMessage(m);
    } catch (err) {
      input.value = text;
      autosize();
      toast(err.message);
    }
    return;
  }

  const replyTo = S.replyTo;
  const files = S.pending;
  input.value = '';
  S.replyTo = null;
  autosize();
  renderBars();
  try {
    const attachments = [];
    for (const p of files) attachments.push(await uploadFile(p.file));
    const m = await api('POST', `/api/channels/${cid}/messages`, { content: text, replyTo, attachments });
    files.forEach((p) => URL.revokeObjectURL(p.preview));
    S.pending = S.pending.filter((p) => !files.includes(p));
    renderPending();
    addMessage(m);
  } catch (err) {
    input.value = text;
    S.replyTo = replyTo;
    autosize();
    renderBars();
    toast(err.message);
  }
}

let lastTypingSent = 0;
input.addEventListener('input', () => {
  autosize();
  const now = Date.now();
  if (S.channelId && now - lastTypingSent > 3000) {
    lastTypingSent = now;
    api('POST', `/api/channels/${S.channelId}/typing`).catch(() => {});
  }
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  } else if (e.key === 'Escape') {
    cancelBar();
  } else if (e.key === 'ArrowUp' && !input.value && !S.editing) {
    const mine = [...(S.messages.get(S.channelId) || [])].reverse().find((m) => m.authorId === S.me.id && m.content);
    if (mine) {
      e.preventDefault();
      S.editing = mine.id;
      S.replyTo = null;
      input.value = mine.content;
      autosize();
      renderBars();
    }
  }
});

input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    addFiles(files);
  }
});

$('#attach').onclick = () => $('#file').click();
$('#file').onchange = (e) => {
  addFiles(e.target.files);
  e.target.value = '';
};

$('#pending').onclick = (e) => {
  const b = e.target.closest('[data-rm]');
  if (!b) return;
  const [p] = S.pending.splice(Number(b.dataset.rm), 1);
  if (p) URL.revokeObjectURL(p.preview);
  renderPending();
};

$('#reply-bar').onclick = (e) => {
  if (e.target.closest('[data-cancel-bar]')) cancelBar();
};

$('#messages').onclick = async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const cid = S.channelId;
  try {
    if (btn.dataset.react) {
      await api('POST', `/api/channels/${cid}/messages/${btn.dataset.react}/reactions`, { emoji: btn.dataset.emoji });
    } else if (btn.dataset.reply) {
      S.replyTo = btn.dataset.reply;
      S.editing = null;
      renderBars();
      input.focus();
    } else if (btn.dataset.edit) {
      const m = findLocal(btn.dataset.edit);
      if (!m) return;
      S.editing = m.id;
      S.replyTo = null;
      input.value = m.content;
      autosize();
      renderBars();
      input.focus();
    } else if (btn.dataset.delete) {
      if (!confirm('Удалить сообщение?')) return;
      await api('DELETE', `/api/channels/${cid}/messages/${btn.dataset.delete}`);
    }
  } catch (err) {
    toast(err.message);
  }
};

// подгрузка старых сообщений при прокрутке вверх
$('#messages').addEventListener('scroll', async (e) => {
  const box = e.target;
  const cid = S.channelId;
  if (!cid || box.scrollTop > 60 || !S.hasMore.get(cid) || box.dataset.loading) return;
  const list = S.messages.get(cid);
  if (!list?.length) return;
  box.dataset.loading = '1';
  const prevHeight = box.scrollHeight;
  try {
    await loadMessages(cid, list[0].id);
    renderMessages();
    box.scrollTop = box.scrollHeight - prevHeight;
  } catch (err) {
    toast(err.message);
  } finally {
    delete box.dataset.loading;
  }
});

// ---------- боковая панель (делегирование) ----------
$('.sidebar').onclick = (e) => {
  const t = e.target;
  const del = t.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    return deleteChannel(del.dataset.del);
  }
  if (t.closest('[data-vmute]')) return toggleMute();
  if (t.closest('[data-vdeaf]')) return toggleDeafen();
  if (t.closest('[data-vleave]')) return leaveVoice();
  const voiceRow = t.closest('[data-voice]');
  if (voiceRow) return joinVoice(voiceRow.dataset.voice);
  const ch = t.closest('[data-channel]');
  if (ch) return openChannel(ch.dataset.channel);
  if (t.closest('#new-dm')) return openDmModal();
  if (t.closest('#new-channel')) return openChannelModal();
  if (t.closest('#invite')) return openInviteModal();
  if (t.closest('#leave')) return leaveGuild();
};

// регулятор громкости участника
$('.sidebar').addEventListener('input', (e) => {
  const id = e.target.dataset?.vol;
  if (!id) return;
  S.volumes[id] = Number(e.target.value);
  localStorage.setItem('chatly_volumes', JSON.stringify(S.volumes));
  applyVolume(id);
  e.target.title = `Громкость: ${e.target.value}%`;
});

$('#guilds').onclick = (e) => {
  const v = e.target.closest('[data-view]');
  if (v) return setView(v.dataset.view);
  if (e.target.closest('#add-guild')) return openCreateGuildModal();
  if (e.target.closest('#join-guild')) return openJoinGuildModal();
};

// ---------- модальные окна ----------
function openModal({ title, body, submitText, onSubmit }) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="overlay">
    <form class="card modal">
      <h2>${title}</h2>
      ${body}
      <div class="error"></div>
      <div class="row end">
        <button type="button" class="link" data-cancel>Отмена</button>
        <button type="submit">${submitText}</button>
      </div>
    </form></div>`;
  const form = root.querySelector('form');
  const err = root.querySelector('.error');
  root.querySelector('.overlay').onclick = (e) => {
    if (e.target.classList.contains('overlay')) closeModal();
  };
  root.querySelector('[data-cancel]').onclick = closeModal;
  form.onsubmit = async (e) => {
    e.preventDefault();
    err.textContent = '';
    try {
      await onSubmit(form);
      closeModal();
    } catch (ex) {
      err.textContent = ex.message;
      toast('Ошибка: ' + ex.message);
    }
  };
  form.querySelector('input')?.focus();
}
const closeModal = () => { $('#modal-root').innerHTML = ''; };

function openCreateGuildModal() {
  openModal({
    title: 'Создайте сервер',
    body: `<label>Название сервера<input name="name" maxlength="50" required></label>`,
    submitText: 'Создать',
    onSubmit: async (f) => {
      const g = await api('POST', '/api/guilds', { name: f.elements.name.value });
      await loadState();
      setView(g.id);
    },
  });
}

function openJoinGuildModal() {
  openModal({
    title: 'Вступить на сервер',
    body: `<label>Код приглашения<input name="code" required placeholder="например, 1a2b3c4d"></label>`,
    submitText: 'Вступить',
    onSubmit: async (f) => {
      const g = await api('POST', '/api/guilds/join', { code: f.elements.code.value });
      await loadState();
      setView(g.id);
    },
  });
}

function openDmModal() {
  openModal({
    title: 'Новое сообщение',
    body: `<label>Имя пользователя<input name="username" required placeholder="например, alex"></label>`,
    submitText: 'Открыть',
    onSubmit: async (f) => {
      const ch = await api('POST', '/api/dms', { username: f.username.value });
      await loadState();
      S.view = 'home';
      openChannel(ch.id);
    },
  });
}

function openChannelModal() {
  openModal({
    title: 'Создать канал',
    body: `<label>Название канала<input name="name" maxlength="30" required placeholder="например, игры"></label>
      <label>Тип<select name="type">
        <option value="text"># Текстовый</option>
        <option value="voice">🔊 Голосовой</option>
      </select></label>`,
    submitText: 'Создать',
    onSubmit: async (f) => {
      const ch = await api('POST', `/api/guilds/${S.view}/channels`, { name: f.elements.name.value, type: f.elements.type.value });
      await loadState();
      if (ch.type === 'voice') joinVoice(ch.id);
      else openChannel(ch.id);
    },
  });
}

function openInviteModal() {
  const g = S.guilds.get(S.view);
  if (!g) return;
  openModal({
    title: 'Пригласить на сервер',
    body: `<p class="muted">Отправьте этот код друзьям — они введут его в «Вступить на сервер».</p>
      <div class="code-box">${esc(g.inviteCode)}</div>`,
    submitText: 'Скопировать код',
    onSubmit: async () => {
      await navigator.clipboard?.writeText(g.inviteCode).catch(() => {});
      toast('Код скопирован');
    },
  });
}

async function leaveGuild() {
  const g = S.guilds.get(S.view);
  if (!g || !confirm(`Покинуть сервер «${g.name}»?`)) return;
  try {
    await api('DELETE', `/api/guilds/${g.id}/members/me`);
    S.view = 'home';
    await loadState();
  } catch (err) {
    toast(err.message);
  }
}

async function deleteChannel(cid) {
  const c = S.channels.get(cid);
  if (!c || !confirm(`Удалить канал ${c.type === 'voice' ? 'голосовой' : '#' + c.name} вместе со всеми сообщениями?`)) return;
  try {
    await api('DELETE', `/api/channels/${cid}`);
    S.messages.delete(cid);
    await loadState();
  } catch (err) {
    toast(err.message);
  }
}

// ---------- realtime ----------
function connectEvents() {
  if (S.es) S.es.close();
  const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  S.es = es;
  let reconnecting = false;

  es.onopen = () => {
    if (!reconnecting) return;
    reconnecting = false;
    // после обрыва перезагружаем состояние и текущую переписку
    loadState().then(() => {
      if (S.channelId) {
        S.messages.delete(S.channelId);
        ensureChannelLoaded();
      }
    }).catch(() => {});
  };
  es.onerror = () => { reconnecting = true; };

  const on = (event, fn) => es.addEventListener(event, (e) => fn(JSON.parse(e.data)));
  on('message:create', addMessage);
  on('message:update', updateMessage);
  on('message:delete', ({ id, channelId }) => removeMessage(id, channelId));
  on('typing', onTyping);
  on('presence', ({ userId, online }) => {
    if (online) S.online.add(userId);
    else S.online.delete(userId);
    renderMembers();
  });
  on('voice:state', ({ channelId, participants }) => applyVoiceState(channelId, participants));
  on('voice:signal', onVoiceSignal);
  on('refresh', () => loadState().catch(() => {}));
}

function onTyping({ channelId, userId, name }) {
  if (userId === S.me.id) return;
  const key = channelId + ':' + userId;
  clearTimeout(S.typing.get(key)?.timer);
  const timer = setTimeout(() => {
    S.typing.delete(key);
    renderTyping();
  }, 4000);
  S.typing.set(key, { channelId, name, timer });
  renderTyping();
}

// ---------- старт ----------
autosize();
renderAuth();
boot();
