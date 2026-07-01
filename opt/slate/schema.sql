-- Схема базы Slate (Cloudflare D1 / SQLite).
-- Применить: wrangler d1 execute slate --file=./schema.sql

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  email      TEXT UNIQUE NOT NULL,
  pass_hash  TEXT NOT NULL,
  pass_salt  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS licenses (
  id          TEXT PRIMARY KEY,
  key         TEXT UNIQUE NOT NULL,        -- SLATE-XXXX-XXXX-XXXX-XXXX
  user_id     TEXT,                        -- привязка к аккаунту (может быть NULL — режим "только ключ")
  plan        TEXT NOT NULL DEFAULT 'beta',
  status      TEXT NOT NULL DEFAULT 'active', -- active | revoked | expired
  max_devices INTEGER NOT NULL DEFAULT 1,  -- 1 лицензия = 1 устройство
  expires_at  INTEGER,                     -- unix ms, NULL = бессрочная
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  license_id   TEXT NOT NULL,
  fingerprint  TEXT NOT NULL,              -- SHA-256 отпечатка устройства
  name         TEXT,
  platform     TEXT,
  activated_at INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL,
  UNIQUE(license_id, fingerprint)          -- одно устройство не занимает два слота
);
CREATE INDEX IF NOT EXISTS idx_devices_license ON devices(license_id);

-- ключ-значение (храним актуальный манифест релизов, отдаём без кеша)
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
