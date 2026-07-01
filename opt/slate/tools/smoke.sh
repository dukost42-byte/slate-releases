#!/usr/bin/env bash
# End-to-end проверка развёрнутого сервера Slate.
# 1) впиши URL и ADMIN_TOKEN ниже  2) запусти:  bash tools/smoke.sh
#
# Правильный результат: на шаге 4 приходит "token", на шаге 5 — ошибка device_limit.

URL="https://api.ТВОЙ-ДОМЕН.ru"                     # <-- твой адрес после деплоя
ADMIN="ВСТАВЬ_ADMIN_TOKEN"                          # <-- твой ADMIN_TOKEN

echo "1) health:"
curl -s "$URL/"; echo; echo

echo "2) выпуск лицензии (admin):"
LIC=$(curl -s -X POST "$URL/admin/license" \
  -H "authorization: Bearer $ADMIN" -H "content-type: application/json" \
  -d '{"plan":"beta","max_devices":1}')
echo "$LIC"
KEY=$(echo "$LIC" | grep -oE '"key":"[^"]+"' | sed 's/"key":"//; s/"//g')
echo "   ключ: $KEY"; echo

echo "3) регистрация аккаунта с ключом:"
SIGN=$(curl -s -X POST "$URL/auth/signup" -H "content-type: application/json" \
  -d "{\"email\":\"test+$RANDOM@example.com\",\"password\":\"supersecret1\",\"key\":\"$KEY\"}")
echo "$SIGN"
SESSION=$(echo "$SIGN" | grep -oE '"session":"[^"]+"' | sed 's/"session":"//; s/"//g')
echo "   сессия: ${SESSION:0:28}..."; echo

echo "4) активация устройства #1 (ждём token):"
curl -s -X POST "$URL/license/activate" -H "content-type: application/json" \
  -d "{\"session\":\"$SESSION\",\"fingerprint\":\"device-A\",\"name\":\"Mac\",\"platform\":\"darwin\"}"
echo; echo

echo "5) активация устройства #2 (ждём ОТКАЗ device_limit — это правильно):"
curl -s -X POST "$URL/license/activate" -H "content-type: application/json" \
  -d "{\"session\":\"$SESSION\",\"fingerprint\":\"device-B\"}"
echo; echo

echo "Готово. token на шаге 4 + device_limit на шаге 5 = сервер работает верно."
