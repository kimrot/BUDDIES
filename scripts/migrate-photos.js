#!/usr/bin/env node
// Move photos still stored in Postgres (photos.data) to object storage.
//   npm run photos:migrate
// Safe to run while the app is up, and safe to re-run: each photo is uploaded, then its row is
// switched over only if it still exists and hasn't been migrated by someone else.

const D = require('../lib/db');
const storage = require('../lib/storage');

(async () => {
  await D.migrate();
  await storage.check();
  let moved = 0, gone = 0;
  for (;;) {
    const rows = await D.many('SELECT id, mime, data FROM photos WHERE storage_key IS NULL AND data IS NOT NULL ORDER BY created_at LIMIT 25');
    if (!rows.length) break;
    for (const r of rows) {
      const key = storage.newKey(r.id, r.mime);
      await storage.put(key, r.data, r.mime);
      const upd = await D.q('UPDATE photos SET storage_key = $2, size = $3, data = NULL WHERE id = $1 AND storage_key IS NULL', [r.id, key, r.data.length]);
      if (upd.rowCount) moved++;
      else { await storage.del(key); gone++; } // deleted or migrated meanwhile
    }
    process.stdout.write(`\r  moved ${moved} photo(s) to ${storage.driver}…`);
  }
  console.log(`\nDone: ${moved} moved${gone ? `, ${gone} skipped (changed while migrating)` : ''}. Database rows now only hold metadata.`);
  await D.pool.end();
})().catch(async (e) => { console.error('\nPhoto migration stopped:', e.message, '(already-moved photos are fine; re-run to continue)'); await D.pool.end(); process.exit(1); });
