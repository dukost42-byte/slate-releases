'use strict';
// Крипто-слой на WebCrypto — работает и в Cloudflare Workers, и в Node 20+.
//
// Два вида токенов:
//  • SESSION (аккаунт)  — HMAC-SHA256, проверяет ТОЛЬКО сервер (симметричный секрет).
//  • LICENSE (лицензия) — RSA-SHA256 (RS256), проверяет КЛИЕНТ публичным ключом
//    (Electron через Node, CEP-панель через WebCrypto — RSA поддерживают оба).
//
// Приватный ключ RSA и секрет сессий живут только на сервере (секреты Cloudflare).

const te = new TextEncoder();
const td = new TextDecoder();
const enc = (s) => te.encode(s);
const dec = (b) => td.decode(b);

export function b64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromB64url(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function derFromPem(pem) {
  const b64 = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export function randomId(bytes = 16) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
export async function sha256hex(str) {
  const d = await crypto.subtle.digest('SHA-256', enc(str));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/* ---------------- пароли: PBKDF2-SHA256 ---------------- */
export async function hashPassword(password, saltB64) {
  const salt = saltB64 ? fromB64url(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const km = await crypto.subtle.importKey('raw', enc(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' }, km, 256);
  return { hash: b64url(bits), salt: b64url(salt) };
}
export async function verifyPassword(password, hashB64, saltB64) {
  const { hash } = await hashPassword(password, saltB64);
  if (hash.length !== hashB64.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ hashB64.charCodeAt(i);
  return diff === 0;
}

/* ---------------- SESSION-токены: HMAC (только сервер) ---------------- */
async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function issueSession(secret, payload) {
  const p = b64url(enc(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc(p));
  return p + '.' + b64url(sig);
}
export async function verifySession(secret, token) {
  try {
    const [p, sig] = String(token).split('.');
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(sig), enc(p));
    if (!ok) return null;
    const payload = JSON.parse(dec(fromB64url(p)));
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch (e) { return null; }
}

/* ---------------- LICENSE-токены: RSA (проверяет клиент) ---------------- */
async function importPrivateKey(pkcs8Pem) {
  return crypto.subtle.importKey('pkcs8', derFromPem(pkcs8Pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}
export async function issueLicenseToken(privatePem, payload) {
  const key = await importPrivateKey(privatePem);
  const header = b64url(enc(JSON.stringify({ alg: 'RS256', typ: 'SLT' })));
  const body = b64url(enc(JSON.stringify(payload)));
  const data = header + '.' + body;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc(data));
  return data + '.' + b64url(sig);
}

/* Генерация ключа лицензии: SLATE-XXXX-XXXX-XXXX-XXXX (без похожих символов). */
export function genLicenseKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const rnd = crypto.getRandomValues(new Uint8Array(16));
  const grp = (o) => Array.from({ length: 4 }, (_, i) => chars[rnd[o + i] % chars.length]).join('');
  return 'SLATE-' + grp(0) + '-' + grp(4) + '-' + grp(8) + '-' + grp(12);
}
