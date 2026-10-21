import { expect, it } from 'vitest';
import { makeDb } from './helpers';

// Supabase loads pg-safeupdate for API requests: a DELETE or UPDATE with
// no WHERE clause fails there ("21000 DELETE requires a WHERE clause"),
// though it runs fine in these tests. So no function may have one; write
// `where true` to mean every row.
it('has no DELETE or UPDATE without a WHERE clause in any function', async () => {
  const db = await makeDb();
  const fns = await db.sql(`
    select n.nspname || '.' || p.proname as fn, p.prosrc as src
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('app', 'public')`);
  const bad: string[] = [];
  for (const { fn, src } of fns) {
    for (const stmt of (src as string).replace(/--[^\n]*/g, '').split(';')) {
      if (/\b(delete\s+from|update)\s+app\.\w+/i.test(stmt) && !/\bwhere\b/i.test(stmt) && !/\bdo\s+update\b/i.test(stmt)) {
        bad.push(`${fn}: ${stmt.trim().replace(/\s+/g, ' ').slice(0, 100)}`);
      }
    }
  }
  expect(bad).toEqual([]);
});
