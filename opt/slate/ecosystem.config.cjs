// Конфиг PM2: держит сервер запущенным и перезапускает при сбое/перезагрузке.
//   npm install -g pm2
//   pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup     (автозапуск после ребута VPS)
module.exports = {
  apps: [{
    name: 'slate-backend',
    script: 'server.js',
    node_args: '--env-file=.env',
    instances: 1,
    autorestart: true,
    max_restarts: 10,
    env: { NODE_ENV: 'production' }
  }]
};
