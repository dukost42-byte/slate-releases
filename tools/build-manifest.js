#!/usr/bin/env node
'use strict';
// Пересобирает manifest.json из содержимого папки plugins/.
// Для каждого .zip читает CSXS/manifest.xml ВНУТРИ архива (версия, имя, хост, папка),
// считает sha256 и размер. Версии одного расширения группируются по папке,
// старшая становится latest. То есть достаточно положить новый zip в plugins/ —
// манифест сам это подхватит (а если убрать zip — latest откатится на предыдущую).
//
// Запуск:
//   node tools/build-manifest.js plugins "https://raw.githubusercontent.com/<owner>/<repo>/main/plugins" [manifest.json]
//
// Требуется пакет adm-zip:  npm i adm-zip
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const pluginsDir = process.argv[2] || 'plugins';
const baseUrl = (process.argv[3] || '').replace(/\/+$/, '');
const outFile = process.argv[4] || 'manifest.json';

if (!baseUrl) {
  console.error('Укажи базовый URL: node tools/build-manifest.js plugins <baseUrl> [out]');
  process.exit(1);
}

function hostCode(name) {
  return ({ AEFT: 'ae', PPRO: 'pr' })[name] || (name || '').toLowerCase();
}

function semverCmp(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

const groups = {}; // ключ — папка расширения (extensionFolder)

for (const f of fs.readdirSync(pluginsDir)) {
  if (!f.toLowerCase().endsWith('.zip')) continue;
  const full = path.join(pluginsDir, f);
  let zip;
  try { zip = new AdmZip(full); } catch (e) { console.warn('пропуск (не читается zip):', f); continue; }

  const manifestEntry = zip.getEntries()
    .map((e) => e.entryName)
    .find((n) => /^[^/]+\/CSXS\/manifest\.xml$/.test(n));
  if (!manifestEntry) { console.warn('пропуск (не CEP-расширение):', f); continue; }

  const folder = manifestEntry.split('/')[0];
  const xml = zip.readAsText(manifestEntry);
  const version = (xml.match(/ExtensionBundleVersion="([^"]+)"/) || [])[1];
  const name = (xml.match(/ExtensionBundleName="([^"]+)"/) || [])[1] || folder;
  const bundleId = (xml.match(/ExtensionBundleId="([^"]+)"/) || [])[1] || folder;
  const host = hostCode((xml.match(/<Host\s+Name="([^"]+)"/) || [])[1] || '');
  if (!version) { console.warn('пропуск (нет ExtensionBundleVersion):', f); continue; }

  const buf = fs.readFileSync(full);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const rec = { version: version, file: f, url: baseUrl + '/' + encodeURIComponent(f), sha256: sha256, size: buf.length };

  const g = groups[folder] || (groups[folder] = { name: name, host: host, kind: 'cep', extensionFolder: folder, bundleId: bundleId, versions: [] });
  g.versions.push(rec);
  console.log('+', f, '->', folder, version);
}

const plugins = {};
Object.keys(groups).sort().forEach((folder) => {
  const g = groups[folder];
  g.versions.sort((a, b) => semverCmp(a.version, b.version));
  const latest = g.versions[g.versions.length - 1];
  plugins[folder] = {
    name: g.name, host: g.host, kind: g.kind, extensionFolder: g.extensionFolder, bundleId: g.bundleId,
    latest: latest, versions: g.versions
  };
});

const manifest = { generatedAt: new Date().toISOString(), plugins: plugins };
fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2) + '\n');
console.log('записан', outFile, '— расширений:', Object.keys(plugins).length);
