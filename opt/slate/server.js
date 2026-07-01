'use strict';
// Запуск сервера Slate на обычном Node (для VPS в РФ).
//   node --env-file=.env server.js      (или через PM2, см. ecosystem.config.cjs)
//
// Секреты берутся из окружения (.env или переменные PM2/systemd):
//   SESSION_SECRET            — секрет HMAC для сессий
//   ADMIN_TOKEN               — токен для админ-эндпоинтов
//   LICENSE_PRIVATE_KEY_FILE  — путь к private_key.pem (по умолчанию ./private_key.pem)
//   PORT                      — порт (по умолчанию 8787)
//   DB_PATH                   — файл базы (по умолчанию ./slate.db)

import { serve } from '@hono/node-server';
import { readFileSync } from 'node:fs';
import app from './src/index.js';
import { openDb } from './src/db.js';

const PORT = Number(process.env.PORT || 8787);
const DB_PATH = process.env.DB_PATH || './slate.db';
const KEY_PATH = process.env.LICENSE_PRIVATE_KEY_FILE || './private_key.pem';

const SESSION_SECRET = process.env.SESSION_SECRET;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!SESSION_SECRET || !ADMIN_TOKEN) {
  console.error('Ошибка: задай SESSION_SECRET и ADMIN_TOKEN (см. .env.example)');
  process.exit(1);
}

let LICENSE_PRIVATE_KEY;
try {
  LICENSE_PRIVATE_KEY = readFileSync(KEY_PATH, 'utf8');
} catch (e) {
  console.error(`Ошибка: не найден ключ ${KEY_PATH}. Сгенерируй его: npm run keys`);
  process.exit(1);
}

// база + схема (idempotent — можно запускать сколько угодно раз)
const db = openDb(DB_PATH);
db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));

// окружение, которое получат обработчики как c.env (тот же контракт, что был в Workers)
const ENV = { DB: db, LICENSE_PRIVATE_KEY, SESSION_SECRET, ADMIN_TOKEN };

serve({ fetch: (request) => app.fetch(request, ENV), port: PORT }, (info) => {
  console.log(`Slate backend слушает http://localhost:${info.port}`);
});
