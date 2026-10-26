import { beforeAll, describe, expect, it } from 'vitest';
import { handle, type Deps } from '../supabase/functions/discord/handler';
import { makeDb, type TestDb } from './helpers';

// the Discord function, with WebCrypto's Ed25519 in place of tweetnacl and
// the test database in place of Supabase's
const ED = { name: 'Ed25519' };
const keyPair = () => crypto.subtle.generateKey(ED, true, ['sign', 'verify']) as Promise<CryptoKeyPair>;
const toHex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

describe('Discord interactions endpoint', () => {
  let db: TestDb;
  let deps: Deps;
  let pair: CryptoKeyPair;
  let other: CryptoKeyPair;
  const NOW = 1_792_000_000_000;

  const request = async (body: unknown, opts: { stamp?: number; key?: CryptoKey; tamper?: boolean } = {}) => {
    const text = JSON.stringify(body);
    const stamp = String(opts.stamp ?? NOW / 1000);
    const signature = toHex(await crypto.subtle.sign(ED, opts.key ?? pair.privateKey, new TextEncoder().encode(stamp + text)));
    return new Request('https://x.supabase.co/functions/v1/discord', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature-ed25519': signature, 'x-signature-timestamp': stamp },
      body: opts.tamper ? text.replace('}', ',"x":1}') : text,
    });
  };

  beforeAll(async () => {
    pair = await keyPair();
    other = await keyPair();
    const raw = toHex(await crypto.subtle.exportKey('raw', pair.publicKey));
    db = await makeDb();
    await db.setNow('2026-10-16T12:00:00+08:00');
    const g2 = (await db.one('select id from app.groups where no = 2')).id;
    await db.sql(`select app.discord_set_channel($1, '100000000000000002', true)`, [g2]);
    await db.sql(`select app.discord_set_bot($1, 'Office Hour', 'https://x.supabase.co/functions/v1/discord', 'https://example.github.io/oh/')`, [raw]);
    deps = {
      verify: async (message, signature, key) =>
        crypto.subtle.verify(ED, await crypto.subtle.importKey('raw', key as BufferSource, ED, false, ['verify']), signature as BufferSource, message as BufferSource),
      publicKey: async () => (await db.one('select public_key from app.discord_bot')).public_key,
      answer: async (i) => (await db.one('select app.discord_interaction($1::jsonb) as r', [JSON.stringify(i)])).r,
      now: () => NOW,
    };
  });

  it("answers Discord's PING", async () => {
    const r = await handle(await request({ type: 1 }), deps);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ type: 1 });
  });

  it('turns away anything Discord did not sign, or signed long ago', async () => {
    for (const req of [
      await request({ type: 1 }, { key: other.privateKey }),
      await request({ type: 1 }, { tamper: true }),
      await request({ type: 1 }, { stamp: NOW / 1000 - 600 }),
      new Request('https://x', { method: 'POST', body: '{"type":1}' }),
    ]) {
      expect((await handle(req, deps)).status).toBe(401);
    }
    expect((await handle(new Request('https://x'), deps)).status).toBe(405);
    // before the bot is set up there is no key to check against
    expect((await handle(await request({ type: 1 }), { ...deps, publicKey: async () => null })).status).toBe(401);
  });

  it('lets the database answer a button press', async () => {
    const week = (await db.one(`select id from app.weeks where label = 'W7'`)).id;
    const r = await handle(
      await request({ type: 3, channel_id: '100000000000000002', member: { nick: '小晴', user: { username: 'q' } }, data: { custom_id: `oh:book:${week}` } }),
      deps,
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ type: 9, data: { title: '預約 W7 10/21（三）10:00' } });
  });
});
