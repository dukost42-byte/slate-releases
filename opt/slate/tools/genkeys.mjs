// Генерация пары ключей RSA-2048 для подписи лицензионных токенов.
// Запуск локально:  node tools/genkeys.mjs
//
//  private_key.pem — приватный ключ. НИКОМУ не отдавать. Кладётся в секрет сервера:
//                    wrangler secret put LICENSE_PRIVATE_KEY   (вставить содержимое файла)
//  public_key.pem  — публичный ключ. Встраивается в приложение и в плагин,
//                    чтобы они проверяли подпись токена (сам ключ секретным не является).

import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pub = publicKey.export({ type: 'spki', format: 'pem' });

writeFileSync('private_key.pem', priv);
writeFileSync('public_key.pem', pub);

console.log('✓ private_key.pem и public_key.pem созданы.\n');
console.log('Дальше:');
console.log('  1) wrangler secret put LICENSE_PRIVATE_KEY   — вставь СОДЕРЖИМОЕ private_key.pem');
console.log('  2) public_key.pem вставим в приложение/плагин на этапе клиента');
console.log('  3) private_key.pem НЕ коммить в git (он уже в .gitignore)');
