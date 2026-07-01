'use strict';
// Слой базы для Node: SQLite (better-sqlite3).
// Отдаёт тот же интерфейс, что был у Cloudflare D1
//   db.prepare(sql).bind(...args).first() | .run() | .all()
// поэтому весь код в src/index.js остаётся без изменений.

import Database from 'better-sqlite3';

export function openDb(path) {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');   // надёжнее при параллельных запросах
  sqlite.pragma('foreign_keys = ON');

  return {
    _sqlite: sqlite,
    exec(sql) { sqlite.exec(sql); },
    prepare(sql) {
      const stmt = sqlite.prepare(sql);
      let params = [];
      return {
        bind(...args) { params = args; return this; },
        first() { return stmt.get(...params) ?? null; },
        run() { const info = stmt.run(...params); return { meta: { changes: info.changes } }; },
        all() { return { results: stmt.all(...params) }; }
      };
    }
  };
}
