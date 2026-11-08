'use strict';
// Chatly — Discord-подобный мессенджер для веба.
// Без внешних зависимостей. Требуется Node.js 18+.
// Запуск: node server.js  →  http://localhost:3000

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const MAX_CONTENT = 2000;
const MAX_STORED_MESSAGES = 1000;
const PAGE_SIZE = 50;
const MAX_UPLOAD = 8 * 1024 * 1024;
const MAX_ATTACHMENTS = 4;
const COLORS = ['#5865f2', '#57f287', '#fee75c', '#eb459e', '#ed4245', '#f47b67', '#3ba55c', '#faa61a'];
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const UPLOAD_RE = /^\/uploads\/([a-f0-9]{32}\.(?:png|jpg|gif|webp))$/;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- хранилище ----------
const db = fs.existsSync(DATA_FILE)
  ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
  : { users: {}, guilds: {}, channels: {}, messages: {}, sessions: {} };

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(db), (err) => err && console.error('Ошибка сохранения:', err));
  }, 250);
}

// Голосовые комнаты живут только в памяти: channelId -> Map(userId -> { muted, deafened })
const voice = new Map();

// ---------- утилиты ----------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const uid = (prefix) => prefix + crypto.randomBytes(8).toString('hex');
const clean = (value, max) => String(value ?? '').replace(/\r/g, '').trim().slice(0, max);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function checkPassword(password, user) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}

const publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName, color: u.color });
const guildOut = (g) => ({
  id: g.id,
  name: g.name,
  ownerId: g.ownerId,
  inviteCode: g.inviteCode,
  memberIds: g.members,
  channelIds: g.channelIds,
});
const isMember = (userId, guild) => guild.members.includes(userId);

function canAccess(userId, channel) {
  if (channel.type === 'dm') return channel.participants.includes(userId);
  const guild = db.guilds[channel.guildId];
  return Boolean(guild && isMember(userId, guild));
}
function audienceOf(channel) {
  if (channel.type === 'dm') return channel.participants;
  return db.guilds[channel.guildId]?.members || [];
}
function getChannel(user, id) {
  const channel = db.channels[id];
  if (!channel || !canAccess(user.id, channel)) throw new HttpError(404, 'Канал не найден');
  return channel;
}
function getGuildForMember(user, guildId) {
  const guild = db.guilds[guildId];
  if (!guild || !isMember(user.id, guild)) throw new HttpError(404, 'Сервер не найден');
  return guild;
}
function findMessage(channel, id) {
  const list = db.messages[channel.id] || [];
  const index = list.findIndex((m) => m.id === id);
  if (index < 0) throw new HttpError(404, 'Сообщение не найдено');
  return { list, index, message: list[index] };
}

// ---------- сессии и realtime (SSE) ----------
const clients = new Map(); // userId -> Set<http.ServerResponse>

function emit(userIds, event, data) {
  const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const id of new Set(userIds)) {
    for (const res of clients.get(id) || []) res.write(chunk);
  }
}
const emitAll = (event, data) => emit([...clients.keys()], event, data);

// ---------- голосовые каналы ----------
const voiceOut = (channelId) => [...(voice.get(channelId)?.entries() || [])]
  .map(([userId, s]) => ({ userId, muted: s.muted, deafened: s.deafened }));

function emitVoice(channelId) {
  const channel = db.channels[channelId];
  if (!channel) return;
  emit(audienceOf(channel), 'voice:state', { channelId, participants: voiceOut(channelId) });
}

function leaveVoice(userId, channelId) {
  const members = voice.get(channelId);
  if (!members || !members.delete(userId)) return;
  if (members.size === 0) voice.delete(channelId);
  emitVoice(channelId);
}
function leaveAllVoice(userId) {
  for (const cid of [...voice.keys()]) leaveVoice(userId, cid);
}

function authOrThrow(req, url) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token');
  const session = token && db.sessions[token];
  const user = session && db.users[session.userId];
  if (!user) throw new HttpError(401, 'Нужен вход в аккаунт');
  return { user, token };
}

function issueSession(res, user, status) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = { userId: user.id, createdAt: Date.now() };
  save();
  send(res, status, { token, user: publicUser(user) });
}

// ---------- HTTP-утилиты ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 200_000) {
        reject(new HttpError(413, 'Слишком большой запрос'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new HttpError(400, 'Некорректный JSON'));
      }
    });
    req.on('error', reject);
  });
}

function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(new HttpError(413, 'Файл больше 8 МБ'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  let r; // результат регулярных выражений

  // --- аутентификация ---
  if (m === 'POST' && p === '/api/register') {
    const body = await readBody(req);
    const username = clean(body.username, 32).toLowerCase();
    const password = String(body.password || '');
    const displayName = clean(body.displayName, 32) || username;
    if (!/^[a-z0-9_.]{2,32}$/.test(username)) {
      throw new HttpError(400, 'Имя: 2–32 символа, латиница, цифры, _ и .');
    }
    if (password.length < 6) throw new HttpError(400, 'Пароль — минимум 6 символов');
    if (Object.values(db.users).some((u) => u.username === username)) {
      throw new HttpError(409, 'Это имя уже занято');
    }
    const id = uid('u_');
    const { salt, hash } = hashPassword(password);
    db.users[id] = { id, username, displayName, salt, hash, color: pick(COLORS) };
    save();
    return issueSession(res, db.users[id], 201);
  }

  if (m === 'POST' && p === '/api/login') {
    const body = await readBody(req);
    const username = clean(body.username, 32).toLowerCase();
    const user = Object.values(db.users).find((u) => u.username === username);
    if (!user || !checkPassword(String(body.password || ''), user)) {
      throw new HttpError(401, 'Неверное имя или пароль');
    }
    return issueSession(res, user, 200);
  }

  if (m === 'POST' && p === '/api/logout') {
    const { token } = authOrThrow(req, url);
    delete db.sessions[token];
    save();
    return send(res, 200, { ok: true });
  }

  // --- состояние (всё, что нужно клиенту при старте) ---
  if (m === 'GET' && p === '/api/state') {
    const { user } = authOrThrow(req, url);
    const guilds = Object.values(db.guilds).filter((g) => isMember(user.id, g));
    const channels = Object.values(db.channels).filter((c) => canAccess(user.id, c));
    const userIds = new Set([user.id]);
    guilds.forEach((g) => g.members.forEach((id) => userIds.add(id)));
    channels.filter((c) => c.type === 'dm').forEach((c) => c.participants.forEach((id) => userIds.add(id)));
    const voiceStates = [...voice.keys()]
      .filter((cid) => db.channels[cid] && canAccess(user.id, db.channels[cid]))
      .map((cid) => ({ channelId: cid, participants: voiceOut(cid) }));
    return send(res, 200, {
      me: publicUser(user),
      guilds: guilds.map(guildOut),
      channels,
      users: [...userIds].map((id) => db.users[id]).filter(Boolean).map(publicUser),
      online: [...clients.keys()],
      voice: voiceStates,
    });
  }

  // --- загрузка картинок ---
  if (m === 'POST' && p === '/api/uploads') {
    authOrThrow(req, url);
    const type = String(req.headers['content-type'] || '').split(';')[0].trim();
    const ext = IMAGE_TYPES[type];
    if (!ext) throw new HttpError(415, 'Можно загружать только PNG, JPG, GIF или WebP');
    const data = await readRaw(req, MAX_UPLOAD);
    if (!data.length) throw new HttpError(400, 'Пустой файл');
    const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
    await fs.promises.writeFile(path.join(UPLOAD_DIR, name), data);
    return send(res, 201, { url: `/uploads/${name}` });
  }

  // --- серверы ---
  if (m === 'POST' && p === '/api/guilds') {
    const { user } = authOrThrow(req, url);
    const body = await readBody(req);
    const name = clean(body.name, 50);
    if (!name) throw new HttpError(400, 'Укажите название сервера');
    const guildId = uid('g_');
    const channelId = uid('c_');
    db.channels[channelId] = { id: channelId, guildId, type: 'text', name: 'general' };
    db.messages[channelId] = [];
    db.guilds[guildId] = {
      id: guildId,
      name,
      ownerId: user.id,
      inviteCode: crypto.randomBytes(4).toString('hex'),
      members: [user.id],
      channelIds: [channelId],
    };
    save();
    emit([user.id], 'refresh', {});
    return send(res, 201, guildOut(db.guilds[guildId]));
  }

  if (m === 'POST' && p === '/api/guilds/join') {
    const { user } = authOrThrow(req, url);
    const body = await readBody(req);
    const code = clean(body.code, 32).toLowerCase();
    const guild = Object.values(db.guilds).find((g) => g.inviteCode === code);
    if (!guild) throw new HttpError(404, 'Приглашение недействительно');
    if (!isMember(user.id, guild)) {
      guild.members.push(user.id);
      save();
      emit(guild.members, 'refresh', {});
    }
    return send(res, 200, guildOut(guild));
  }

  if (m === 'DELETE' && (r = p.match(/^\/api\/guilds\/([^/]+)\/members\/me$/))) {
    const { user } = authOrThrow(req, url);
    const guild = getGuildForMember(user, r[1]);
    const notify = [...guild.members];
    for (const cid of guild.channelIds) leaveVoice(user.id, cid);
    guild.members = guild.members.filter((id) => id !== user.id);
    if (guild.members.length === 0) {
      for (const cid of guild.channelIds) {
        delete db.channels[cid];
        delete db.messages[cid];
        voice.delete(cid);
      }
      delete db.guilds[guild.id];
    } else if (guild.ownerId === user.id) {
      guild.ownerId = guild.members[0]; // передаём владение первому участнику
    }
    save();
    emit(notify, 'refresh', {});
    return send(res, 200, { ok: true });
  }

  if (m === 'POST' && (r = p.match(/^\/api\/guilds\/([^/]+)\/channels$/))) {
    const { user } = authOrThrow(req, url);
    const guild = getGuildForMember(user, r[1]);
    const body = await readBody(req);
    const name = clean(body.name, 30)
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^\p{L}\p{N}_-]/gu, '');
    if (!name) throw new HttpError(400, 'Укажите название канала');
    const type = body.type === 'voice' ? 'voice' : 'text';
    const id = uid('c_');
    db.channels[id] = { id, guildId: guild.id, type, name };
    db.messages[id] = [];
    guild.channelIds.push(id);
    save();
    emit(guild.members, 'refresh', {});
    return send(res, 201, db.channels[id]);
  }

  if (m === 'DELETE' && (r = p.match(/^\/api\/channels\/([^/]+)$/))) {
    const { user } = authOrThrow(req, url);
    const channel = getChannel(user, r[1]);
    if (channel.type === 'dm') throw new HttpError(400, 'Этот чат нельзя удалить');
    const guild = db.guilds[channel.guildId];
    if (guild.ownerId !== user.id) throw new HttpError(403, 'Удалять каналы может только владелец');
    if (guild.channelIds.length <= 1) throw new HttpError(400, 'На сервере должен остаться хотя бы один канал');
    guild.channelIds = guild.channelIds.filter((id) => id !== channel.id);
    delete db.channels[channel.id];
    delete db.messages[channel.id];
    voice.delete(channel.id);
    save();
    emit(guild.members, 'refresh', {});
    return send(res, 200, { ok: true });
  }

  // --- личные сообщения ---
  if (m === 'POST' && p === '/api/dms') {
    const { user } = authOrThrow(req, url);
    const body = await readBody(req);
    const username = clean(body.username, 32).toLowerCase();
    const other = Object.values(db.users).find((u) => u.username === username);
    if (!other) throw new HttpError(404, 'Пользователь не найден');
    if (other.id === user.id) throw new HttpError(400, 'Нельзя написать самому себе');
    let channel = Object.values(db.channels).find(
      (c) => c.type === 'dm' && c.participants.includes(user.id) && c.participants.includes(other.id),
    );
    if (!channel) {
      const id = uid('c_');
      channel = { id, guildId: null, type: 'dm', participants: [user.id, other.id] };
      db.channels[id] = channel;
      db.messages[id] = [];
      save();
      emit([user.id, other.id], 'refresh', {});
    }
    return send(res, 200, channel);
  }

  // --- голосовые каналы ---
  if (m === 'POST' && (r = p.match(/^\/api\/channels\/([^/]+)\/voice\/join$/))) {
    const { user } = authOrThrow(req, url);
    const channel = getChannel(user, r[1]);
    if (channel.type !== 'voice') throw new HttpError(400, 'Это не голосовой канал');
    leaveAllVoice(user.id);
    if (!voice.has(channel.id)) voice.set(channel.id, new Map());
    voice.get(channel.id).set(user.id, { muted: false, deafened: false });
    emitVoice(channel.id);
    return send(res, 200, { participants: voiceOut(channel.id) });
  }

  if (m === 'POST' && (r = p.match(/^\/api\/channels\/([^/]+)\/voice\/leave$/))) {
    const { user } = authOrThrow(req, url);
    const channel = getChannel(user, r[1]);
    leaveVoice(user.id, channel.id);
    return send(res, 200, { ok: true });
  }

  if (m === 'PATCH' && (r = p.match(/^\/api\/channels\/([^/]+)\/voice\/state$/))) {
    const { user } = authOrThrow(req, url);
    const channel = getChannel(user, r[1]);
    const members = voice.get(channel.id);
    if (!members?.has(user.id)) throw new HttpError(400, 'Вы не в этом голосовом канале');
    const body = await readBody(req);
    members.set(user.id, { muted: Boolean(body.muted), deafened: Boolean(body.deafened) });
    emitVoice(channel.id);
    return send(res, 200, { ok: true });
  }

  // сигналинг WebRTC: передаём SDP и ICE-кандидаты между участниками
  if (m === 'POST' && (r = p.match(/^\/api\/channels\/([^/]+)\/voice\/signal$/))) {
    const { user } = authOrThrow(req, url);
    const channel = getChannel(user, r[1]);
    const members = voice.get(channel.id);
    const body = await readBody(req);
    if (!members?.has(user.id) || !members.has(body.to)) {
      throw new HttpError(403, 'Оба участника должны быть в голосовом канале');
    }
    if (!body.data || JSON.stringify(body.data).length > 50_000) throw new HttpError(400, 'Некорректные данные');
    emit([body.to], 'voice:signal', { channelId: channel.id, from: user.id, data: body.data });
    return send(res, 200, { ok: true });
  }

  // --- сообщения ---
  if (m === 'GET' && (r = p.match(/^\/api\/channels\/([^/]+)\/messages$/))) {
    const { user } = authOrThrow(req, url);
    const channel = getChannel(user, r[1]);
    const list = db.messages[channel.id] || [];
    const before = url.searchParams.get('before');
    let end = list.length;
    if (before) {
      const i = list.findIndex((x) => x.id === before);
      if (i >= 0) end = i;
    }
    const start = Math.max(0, end - PAGE_SIZE);
    return send(res, 200, { messages: list.slice(start, end), hasMore: start > 0 });
  }

  if (m === 'POST' && (r = p.match(/^\/api\/channels\/([^/]+)\/messages$/))) {
    const { user } = authOrThrow(req, url);
    const channel = getChannel(user, r[1]);
    const body = await readBody(req);
    const content = clean(body.content, MAX_CONTENT);
    const attachments = Array.isArray(body.attachments)
      ? body.attachments.filter((u) => typeof u === 'string' && UPLOAD_RE.test(u)).slice(0, MAX_ATTACHMENTS)
      : [];
    if (!content && !attachments.length) throw new HttpError(400, 'Сообщение пустое');
    const list = (db.messages[channel.id] ||= []);
    const replyTo = list.some((x) => x.id === body.replyTo) ? body.replyTo : null;
    const message = {
      id: uid('m_'),
      channelId: channel.id,
      authorId: user.id,
      content,
      attachments,
      replyTo,
      createdAt: Date.now(),
      editedAt: null,
      reactions: {},
    };
    list.push(message);
    if (list.length > MAX_STORED_MESSAGES) list.splice(0, list.length - MAX_STORED_MESSAGES);
    save();
    emit(audienceOf(channel), 'message:create', message);
    return send(res, 201, message);
  }

  if (m === 'PATCH' && (r = p.match(/^\/api\/channels\/([^/]+)\/messages\/([^/]+)$/))) {
    const { user } = authOrThrow(req, url);
    const channel = getChannel(user, r[1]);
    const { message } = findMessage(channel, r[2]);
    if (message.authorId !== user.id) throw new HttpError(403, 'Редактировать можно только свои сообщения');
    const body = await readBody(req);
    const content = clean(body.content, MAX_CONTENT);
    if (!content) throw new HttpError(400, 'Сообщение пустое');
    message.content = content;
    message.editedAt = Date.now();
    save();
    emit(audienceOf(channel), 'message:update', message);
    return send(res, 200, message);
  }

  if (m === 'DELETE' && (r = p.match(/^\/api\/channels\/([^/]+)\/messages\/([^/]+)$/))) {
    const { user } = authOrThrow(req, url);
    const channel = getChannel(user, r[1]);
    const { list, index, message } = findMessage(channel, r[2]);
    const isOwner = channel.type === 'text' && db.guilds[channel.guildId].ownerId === user.id;
    if (message.authorId !== user.id && !isOwner) throw new HttpError(403, 'Нельзя удалить чужое сообщение');
    list.splice(index, 1);
    save();
    emit(audienceOf(channel), 'message:delete', { id: message.id, channelId: channel.id });
    return send(res, 200, { ok: true });
  }

  if (m === 'POST' && (r = p.match(/^\/api\/channels\/([^/]+)\/messages\/([^/]+)\/reactions$/))) {
    const { user } = authOrThrow(req, url);
    const channel = getChannel(user, r[1]);
    const { message } = findMessage(channel, r[2]);
    const body = await readBody(req);
    const emoji = clean(body.emoji, 16);
    if (!emoji) throw new HttpError(400, 'Не указан эмодзи');
    const users = (message.reactions[emoji] ||= []);
    const i = users.indexOf(user.id);
    if (i >= 0) users.splice(i, 1);
    else users.push(user.id);
    if (!users.length) delete message.reactions[emoji];
    save();
    emit(audienceOf(channel), 'message:update', message);
    return send(res, 200, message);
  }

  if (m === 'POST' && (r = p.match(/^\/api\/channels\/([^/]+)\/typing$/))) {
    const { user } = authOrThrow(req, url);
    const channel = getChannel(user, r[1]);
    emit(audienceOf(channel).filter((id) => id !== user.id), 'typing', {
      channelId: channel.id,
      userId: user.id,
      name: user.displayName,
    });
    return send(res, 200, { ok: true });
  }

  throw new HttpError(404, 'Не найдено');
}

function handleEvents(req, res, url) {
  const { user } = authOrThrow(req, url);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const wasOnline = clients.has(user.id);
  if (!wasOnline) clients.set(user.id, new Set());
  clients.get(user.id).add(res);
  if (!wasOnline) emitAll('presence', { userId: user.id, online: true });

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(heartbeat);
    const set = clients.get(user.id);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) {
      clients.delete(user.id);
      leaveAllVoice(user.id); // без соединения нельзя оставаться в голосовом канале
      emitAll('presence', { userId: user.id, online: false });
    }
  });
}

// ---------- статика и загрузки ----------
function serveFile(res, full, headers = {}) {
  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Не найдено');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    });
    res.end(buf);
  });
}

function serveStatic(res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const full = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  serveFile(res, full);
}

function serveUpload(res, pathname) {
  const match = pathname.match(UPLOAD_RE);
  if (!match) {
    res.writeHead(404);
    return res.end('Не найдено');
  }
  serveFile(res, path.join(UPLOAD_DIR, match[1]), { 'Cache-Control': 'public, max-age=86400' });
}

// ---------- сервер ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/events') return handleEvents(req, res, url);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/uploads/')) return serveUpload(res, url.pathname);
    return serveStatic(res, url.pathname);
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'Внутренняя ошибка' });
  }
});

server.listen(PORT, () => {
  console.log(`Chatly запущен: http://localhost:${PORT}`);
});
