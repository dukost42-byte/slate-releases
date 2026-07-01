# Slate backend — сервер лицензий (Node.js, для VPS в РФ)

Хранит аккаунты, лицензии и привязки устройств, подписывает лицензионные токены
приватным ключом. Клиент проверяет подпись публичным ключом. База — файловая SQLite.

## Что уже умеет
- **Вход только по аккаунту** email + пароль (`/auth/signup`, `/auth/login`), пароли — PBKDF2-SHA256.
- Лицензионный ключ `SLATE-XXXX-XXXX-XXXX-XXXX` привязывается к аккаунту (`/license/redeem` или при регистрации).
- Активация устройства через сессию, правило **1 лицензия = 1 устройство** (`/license/activate`).
- Подписанный RSA-токен лицензии (офлайн-грейс 3 дня), переподтверждение (`/license/verify`).
- Деактивация (`/license/deactivate`), список устройств (`/license/devices`).
- Манифест релизов без кеша (`/releases/latest`), гейт скачивания (`/releases/asset`).
- Админ: выпуск ключа (`/admin/license`), отзыв (`/admin/revoke`), публикация манифеста (`/admin/releases`).

## Требуется
- VPS с Ubuntu 22/24 у российского провайдера (Beget, Timeweb, VDSina, Selectel, AdminVPS…). Оплата из РФ.
- Домен с A-записью на IP сервера (нужен для HTTPS). Дешёвый .ru подойдёт.

---

## Развёртывание по шагам

### 1. Подготовить сервер (по SSH под root)
```bash
# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs git build-essential
node -v        # должно показать v20.x
```

### 2. Загрузить проект и установить зависимости
```bash
mkdir -p /opt/slate && cd /opt/slate
# загрузи сюда содержимое папки slate-backend (git clone или scp), затем:
npm install
```

### 3. Ключи подписи
```bash
npm run keys        # создаст private_key.pem и public_key.pem
```
`private_key.pem` — секретный, останется на сервере. `public_key.pem` — вставим в приложение позже.

### 4. Секреты
```bash
cp .env.example .env
openssl rand -base64 32      # скопируй → вставь в .env как SESSION_SECRET
openssl rand -base64 32      # ещё раз → вставь как ADMIN_TOKEN
nano .env                    # вписать оба значения, сохранить
```

### 5. Запуск под PM2 (не падает, поднимается после ребута)
```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup          # выполни команду, которую он подскажет
pm2 logs slate-backend --lines 20   # проверить, что слушает порт 8787
```

### 6. HTTPS через Caddy (сам получает и продлевает сертификат)
```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy

nano /etc/caddy/Caddyfile     # вписать (замени домен):
#   api.ТВОЙ-ДОМЕН.ru {
#       reverse_proxy localhost:8787
#   }
systemctl restart caddy
```
Через минуту `https://api.твой-домен.ru/` вернёт `{"ok":true,"service":"slate-backend"}`.

### 7. Проверить всю цепочку
На своём компьютере открой `tools/smoke.sh`, впиши `URL=https://api.твой-домен.ru` и свой `ADMIN_TOKEN`, запусти:
```bash
bash tools/smoke.sh
```
Правильно: на шаге 4 приходит `token`, на шаге 5 — отказ `device_limit`.

---

## Выпустить лицензию
```bash
curl -X POST https://api.твой-домен.ru/admin/license \
  -H "authorization: Bearer <ADMIN_TOKEN>" -H "content-type: application/json" \
  -d '{"plan":"beta","max_devices":1}'
```

## Подключить релизы к приложению
1. В приложении задать `SLATE_MANIFEST_URL = https://api.твой-домен.ru/releases/latest`.
2. Публиковать манифест:
```bash
curl -X POST https://api.твой-домен.ru/admin/releases \
  -H "authorization: Bearer <ADMIN_TOKEN>" -H "content-type: application/json" \
  --data-binary @manifest.json
```

## Обновление кода на сервере
```bash
cd /opt/slate    # залить новые файлы
npm install      # если менялись зависимости
pm2 restart slate-backend
```

## Как это закрывает три поверхности защиты
- **Вход в приложение** — пользователь входит в аккаунт, приложение активирует устройство и получает подписанный токен; нет токена → нет доступа.
- **Применение эффектов в плагине** — приложение кладёт свежий токен в общий файл; панель плагина проверяет подпись и срок перед применением (следующий этап).
- **Скачивание ассетов** — `/releases/asset` проверяет лицензию и устройство; настоящий гейт — с переносом файлов в приватное хранилище (например, S3 российского провайдера).

## Дальше
- Клиент в Electron: вход/регистрация, поле ключа (одноразовое), отпечаток устройства (Mac hardware UUID, хэш), проверка токена публичным ключом, гейт установки.
- Плагин (CEP): проверка токена перед применением эффектов, офлайн-грейс по сроку.
- Ассеты в приватное хранилище + короткоживущие подписанные ссылки.
