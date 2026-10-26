// Discord's interactions endpoint: Discord calls it when someone presses a
// button on the weekly message or sends the booking form. It checks the
// request really comes from Discord, answers Discord's PING, and lets the
// database (app.discord_interaction) write every other answer. Nothing here
// depends on the runtime, so tests/discord-function.test.ts runs it as is.

export interface Deps {
  /** Ed25519: is `signature` the signature of `message` by `key`? */
  verify(message: Uint8Array, signature: Uint8Array, key: Uint8Array): boolean | Promise<boolean>;
  /** The bot's public key (hex), or null before the bot is set up. */
  publicKey(): Promise<string | null>;
  /** The answer to a button press or form, from the database. */
  answer(interaction: unknown): Promise<unknown>;
  now?(): number;
}

const hex = (s: string | null, bytes: number) =>
  s && s.length === bytes * 2 && /^[0-9a-f]+$/i.test(s) ? Uint8Array.from(s.match(/../g)!, (b) => parseInt(b, 16)) : null;

const text = (body: string, status: number) => new Response(body, { status, headers: { 'content-type': 'text/plain' } });

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return text('method not allowed', 405);
  const body = await req.text();
  const signature = hex(req.headers.get('x-signature-ed25519'), 64);
  const stamp = req.headers.get('x-signature-timestamp') ?? '';
  const key = hex(await deps.publicKey(), 32);
  // a signed request is good for five minutes, so an old one cannot be replayed
  const fresh = /^\d{1,12}$/.test(stamp) && Math.abs((deps.now?.() ?? Date.now()) / 1000 - Number(stamp)) < 300;
  if (!signature || !key || !fresh || !(await deps.verify(new TextEncoder().encode(stamp + body), signature, key))) {
    return text('invalid request signature', 401);
  }
  let interaction: { type?: number };
  try {
    interaction = JSON.parse(body);
  } catch {
    return text('bad request', 400);
  }
  if (interaction.type === 1) return Response.json({ type: 1 });
  return Response.json(await deps.answer(interaction));
}
