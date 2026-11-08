// The Discord bot's interactions endpoint (see handler.ts). Deployed by the
// migrate job in .github/workflows/deploy.yml with JWT checks off, since
// Discord signs its requests instead; scripts/discord-ask.mjs then points
// the bot at it.
import nacl from 'tweetnacl';
import postgres from 'postgres';
import { handle } from './handler.ts';

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 2, idle_timeout: 30 });
let key: { value: string | null; at: number } | null = null;

Deno.serve((req) =>
  handle(req, {
    verify: (message, signature, publicKey) => nacl.sign.detached.verify(message, signature, publicKey),
    // read again after a minute, so a new bot is picked up without a redeploy
    async publicKey() {
      if (!key || Date.now() - key.at > 60_000) {
        const [row] = await sql`select public_key from app.discord_bot where id = 1`;
        key = { value: row?.public_key ?? null, at: Date.now() };
      }
      return key.value;
    },
    async answer(interaction) {
      // as JSON, not text: a ::jsonb cast on a string would encode it twice
      const [row] = await sql`select app.discord_interaction(${sql.json(interaction as Parameters<typeof sql.json>[0])}) as r`;
      return row.r;
    },
  }).catch((e) => {
    console.error('discord interaction failed', e instanceof Error ? e.message : e);
    return new Response('error', { status: 500 });
  }),
);
