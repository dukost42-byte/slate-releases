'use strict';
// Slate backend — сервер лицензий (Cloudflare Workers + D1 + Hono).
//
// Модель доступа:
//   • Вход ТОЛЬКО по аккаунту (email + пароль). Логина по ключу нет.
//   • Лицензионный ключ пользователь ПРИВЯЗЫВАЕТ к своему аккаунту (redeem, один раз).
//   • Активация устройства и все проверки идут ЧЕРЕЗ СЕССИЮ аккаунта.
//   • Ключ используется только в момент привязки (или при регистрации, опционально).
//
// Принцип: клиент НИКОГДА сам не решает "лицензия валидна". Он спрашивает сервер,
// сервер отвечает подписанным токеном. Клиент проверяет подпись публичным ключом.
//
// Секреты (задаются через `wrangler secret put <ИМЯ>`), в коде их нет:
//   LICENSE_PRIVATE_KEY — приватный ключ RSA (PKCS8 PEM) для подписи лицензий
//   SESSION_SECRET      — секрет HMAC для сессий аккаунтов
//   ADMIN_TOKEN         — токен для админ-эндпоинтов (выпуск лицензий, публикация манифеста)

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import * as C from './crypto.js';

const app = new Hono();
app.use('*', cors());

const now = () => Date.now();
const DAY = 24 * 3600 * 1000;
const LICENSE_TTL = 3 * DAY;   // офлайн-грейс: сколько токен лицензии живёт без переподтверждения
const SESSION_TTL = 30 * DAY;

const isAdmin = (c) => (c.req.header('authorization') || '') === 'Bearer ' + c.env.ADMIN_TOKEN;

async function newSession(env, uid) {
  return C.issueSession(env.SESSION_SECRET, { uid, iat: now(), exp: now() + SESSION_TTL });
}
async function licenseToken(env, lic, fp) {
  return C.issueLicenseToken(env.LICENSE_PRIVATE_KEY, {
    t: 'lic',
    lic: lic.id,
    dev: fp,                        // привязка токена к устройству
    plan: lic.plan,
    lexp: lic.expires_at || null,   // когда истекает сама лицензия
    iat: now(),
    exp: now() + LICENSE_TTL        // когда истекает этот токен (нужно переподтвердить)
  });
}
function licenseUsable(lic) {
  if (!lic || lic.status !== 'active') return false;
  if (lic.expires_at && lic.expires_at < now()) return false;
  return true;
}

// Достаём лицензию текущего аккаунта по сессии.
// Возвращает { lic } либо { error, status }.
async function sessionLicense(c, body) {
  const s = await C.verifySession(c.env.SESSION_SECRET, body.session);
  if (!s) return { error: 'нужен вход в аккаунт', status: 401 };
  const lic = await c.env.DB.prepare(
    "SELECT * FROM licenses WHERE user_id=? AND status='active' ORDER BY created_at DESC").bind(s.uid).first();
  if (!lic) return { error: 'к аккаунту не привязана лицензия', status: 403, code: 'no_license' };
  return { lic, uid: s.uid };
}

/* ---------------- health ---------------- */
app.get('/', (c) => c.json({ ok: true, service: 'slate-backend' }));

/* ---------------- аккаунты (единственный способ входа) ---------------- */
// Регистрация. Ключ можно передать сразу (тогда он привяжется), а можно позже через /license/redeem.
app.post('/auth/signup', async (c) => {
  const { email, password, key } = await c.req.json().catch(() => ({}));
  const mail = String(email || '').trim().toLowerCase();
  if (!mail || !password || String(password).length < 8)
    return c.json({ error: 'нужен email и пароль не короче 8 символов' }, 400);
  const exists = await c.env.DB.prepare('SELECT id FROM users WHERE email=?').bind(mail).first();
  if (exists) return c.json({ error: 'аккаунт с таким email уже есть' }, 409);

  // если ключ передан — проверим его ДО создания аккаунта
  let lic = null;
  if (key) {
    lic = await c.env.DB.prepare('SELECT * FROM licenses WHERE key=?').bind(key).first();
    if (!lic) return c.json({ error: 'ключ не найден' }, 404);
    if (lic.user_id) return c.json({ error: 'ключ уже привязан к другому аккаунту' }, 409);
  }

  const { hash, salt } = await C.hashPassword(password);
  const id = C.randomId();
  await c.env.DB.prepare(
    'INSERT INTO users (id,email,pass_hash,pass_salt,created_at) VALUES (?,?,?,?,?)')
    .bind(id, mail, hash, salt, now()).run();
  if (lic) await c.env.DB.prepare('UPDATE licenses SET user_id=? WHERE id=?').bind(id, lic.id).run();

  return c.json({
    ok: true, userId: id, session: await newSession(c.env, id),
    license: lic ? { plan: lic.plan, expires_at: lic.expires_at } : null
  });
});

app.post('/auth/login', async (c) => {
  const { email, password } = await c.req.json().catch(() => ({}));
  const mail = String(email || '').trim().toLowerCase();
  const u = await c.env.DB.prepare('SELECT * FROM users WHERE email=?').bind(mail).first();
  if (!u || !(await C.verifyPassword(password || '', u.pass_hash, u.pass_salt)))
    return c.json({ error: 'неверный email или пароль' }, 401);
  return c.json({ ok: true, userId: u.id, session: await newSession(c.env, u.id) });
});

// Привязать ключ лицензии к текущему аккаунту (нужен вход).
app.post('/license/redeem', async (c) => {
  const { session, key } = await c.req.json().catch(() => ({}));
  const s = await C.verifySession(c.env.SESSION_SECRET, session);
  if (!s) return c.json({ error: 'нужен вход в аккаунт' }, 401);
  const lic = await c.env.DB.prepare('SELECT * FROM licenses WHERE key=?').bind(key || '').first();
  if (!lic) return c.json({ error: 'ключ не найден' }, 404);
  if (lic.user_id && lic.user_id !== s.uid)
    return c.json({ error: 'ключ уже привязан к другому аккаунту' }, 409);
  await c.env.DB.prepare('UPDATE licenses SET user_id=? WHERE id=?').bind(s.uid, lic.id).run();
  return c.json({ ok: true, plan: lic.plan, expires_at: lic.expires_at });
});

/* ---------------- лицензия + устройство (всё через сессию) ----------------
   activate  — привязать это устройство к лицензии аккаунта (правило 1 устройство), выдать токен
   verify    — переподтвердить и получить свежий токен (периодически, приложением)
   deactivate— освободить слот устройства
   devices   — список устройств (для экрана "Аккаунт")                          */

app.post('/license/activate', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { fingerprint, name, platform } = body;
  if (!fingerprint) return c.json({ error: 'нужен fingerprint устройства' }, 400);
  const r = await sessionLicense(c, body);
  if (r.error) return c.json({ error: r.error, code: r.code }, r.status);
  const lic = r.lic;
  if (!licenseUsable(lic)) return c.json({ error: 'лицензия неактивна или истекла' }, 403);

  const fp = await C.sha256hex(fingerprint);
  const existing = await c.env.DB.prepare(
    'SELECT * FROM devices WHERE license_id=? AND fingerprint=?').bind(lic.id, fp).first();

  if (!existing) {
    const cnt = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE license_id=?').bind(lic.id).first();
    if (cnt.n >= lic.max_devices)
      return c.json({ error: 'лимит устройств исчерпан — деактивируйте другое устройство', code: 'device_limit' }, 409);
    await c.env.DB.prepare(
      'INSERT INTO devices (id,license_id,fingerprint,name,platform,activated_at,last_seen) VALUES (?,?,?,?,?,?,?)')
      .bind(C.randomId(), lic.id, fp, name || null, platform || null, now(), now()).run();
  } else {
    await c.env.DB.prepare('UPDATE devices SET last_seen=? WHERE id=?').bind(now(), existing.id).run();
  }
  return c.json({ ok: true, token: await licenseToken(c.env, lic, fp), plan: lic.plan, expires_at: lic.expires_at });
});

app.post('/license/verify', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const r = await sessionLicense(c, body);
  if (r.error) return c.json({ ok: false, error: r.error, code: r.code }, r.status);
  const lic = r.lic;
  if (!licenseUsable(lic)) return c.json({ ok: false, error: 'лицензия недействительна' }, 403);
  const fp = await C.sha256hex(body.fingerprint || '');
  const dev = await c.env.DB.prepare(
    'SELECT id FROM devices WHERE license_id=? AND fingerprint=?').bind(lic.id, fp).first();
  if (!dev) return c.json({ ok: false, error: 'устройство не активировано', code: 'not_activated' }, 403);
  await c.env.DB.prepare('UPDATE devices SET last_seen=? WHERE id=?').bind(now(), dev.id).run();
  return c.json({ ok: true, token: await licenseToken(c.env, lic, fp), plan: lic.plan, expires_at: lic.expires_at });
});

app.post('/license/deactivate', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const r = await sessionLicense(c, body);
  if (r.error) return c.json({ error: r.error, code: r.code }, r.status);
  const fp = await C.sha256hex(body.fingerprint || '');
  await c.env.DB.prepare('DELETE FROM devices WHERE license_id=? AND fingerprint=?').bind(r.lic.id, fp).run();
  return c.json({ ok: true });
});

app.post('/license/devices', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const r = await sessionLicense(c, body);
  if (r.error) return c.json({ error: r.error, code: r.code }, r.status);
  const rows = await c.env.DB.prepare(
    'SELECT name,platform,activated_at,last_seen FROM devices WHERE license_id=? ORDER BY activated_at').bind(r.lic.id).all();
  return c.json({ ok: true, max_devices: r.lic.max_devices, plan: r.lic.plan, expires_at: r.lic.expires_at, devices: rows.results || [] });
});

/* ---------------- скачивание ассетов (гейт по лицензии, через сессию) ----------------
   Скачивает приложение (у него есть сессия). Проверяем лицензию + устройство.
   ВАЖНО: пока плагины лежат публично на GitHub — гейт номинальный. Настоящая защита
   будет с переносом файлов в приватный R2 и выдачей короткоживущей подписанной ссылки. */
app.post('/releases/asset', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const r = await sessionLicense(c, body);
  if (r.error) return c.json({ error: r.error, code: r.code }, r.status);
  if (!licenseUsable(r.lic)) return c.json({ error: 'лицензия недействительна' }, 403);
  const fp = await C.sha256hex(body.fingerprint || '');
  const dev = await c.env.DB.prepare(
    'SELECT id FROM devices WHERE license_id=? AND fingerprint=?').bind(r.lic.id, fp).first();
  if (!dev) return c.json({ error: 'устройство не активировано' }, 403);
  // TODO(R2): вернуть signed URL из приватного бакета вместо публичной ссылки
  return c.json({ ok: true, note: 'лицензия подтверждена; приватное хранилище R2 — следующий шаг' });
});

/* ---------------- релизы (замена raw.githubusercontent, без кеша) ---------------- */
app.get('/releases/latest', async (c) => {
  const row = await c.env.DB.prepare('SELECT v FROM meta WHERE k=?').bind('manifest').first();
  if (!row) return c.json({ plugins: {} });
  return new Response(row.v, { headers: { 'content-type': 'application/json', 'cache-control': 'no-cache' } });
});

/* ---------------- админ (Bearer ADMIN_TOKEN) ---------------- */
// Выпустить лицензионный ключ. Можно сразу привязать к аккаунту по email.
app.post('/admin/license', async (c) => {
  if (!isAdmin(c)) return c.json({ error: 'forbidden' }, 403);
  const b = await c.req.json().catch(() => ({}));
  const plan = b.plan || 'beta';
  const max_devices = b.max_devices || 1;
  const expires_at = b.expires_at || null;   // unix ms или null
  let user_id = null;
  if (b.email) {
    const u = await c.env.DB.prepare('SELECT id FROM users WHERE email=?').bind(String(b.email).toLowerCase()).first();
    user_id = u ? u.id : null;
  }
  const key = C.genLicenseKey();
  const id = C.randomId();
  await c.env.DB.prepare(
    'INSERT INTO licenses (id,key,user_id,plan,status,max_devices,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind(id, key, user_id, plan, 'active', max_devices, expires_at, now()).run();
  return c.json({ ok: true, key, id, plan, max_devices, expires_at });
});

app.post('/admin/revoke', async (c) => {
  if (!isAdmin(c)) return c.json({ error: 'forbidden' }, 403);
  const { key } = await c.req.json().catch(() => ({}));
  const res = await c.env.DB.prepare("UPDATE licenses SET status='revoked' WHERE key=?").bind(key || '').run();
  return c.json({ ok: true, changed: res.meta ? res.meta.changes : undefined });
});

app.post('/admin/releases', async (c) => {
  if (!isAdmin(c)) return c.json({ error: 'forbidden' }, 403);
  const body = await c.req.text();
  await c.env.DB.prepare('INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v')
    .bind('manifest', body).run();
  return c.json({ ok: true, bytes: body.length });
});

export default app;
