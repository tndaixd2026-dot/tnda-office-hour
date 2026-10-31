import { describe, expect, it } from 'vitest';
import yml from '../.github/workflows/mail.yml?raw';
import { MAIL_PREVIEW, MAIL_SEND } from '../src/config';

// The admin page names the times the weekly email goes out; they come from
// the workflow's cron (UTC, started early) and SEND_AT (Taipei).
describe('weekly email schedule', () => {
  const crons = [...yml.matchAll(/- cron: '(\d+) (\d+) \* \* (\d)'/g)].map((m) => ({ cron: m[0].slice(9, -1), min: +m[1], hour: +m[2], dow: +m[3] }));
  const sendAt = /SEND_AT: .*?== '([^']+)' && '(\d\d:\d\d)' \|\| '(\d\d:\d\d)'/.exec(yml)!;
  const kindOf = /KIND: .*?== '([^']+)' && 'preview' \|\| 'weekly'/.exec(yml)!;
  const DAYS = '日一二三四五六';

  /** Taipei weekday and time of a cron, and the time the script waits for. */
  const when = (c: (typeof crons)[number]) => {
    const start = (c.dow * 24 + c.hour + 8) * 60 + c.min;
    const at = c.cron === sendAt[1] ? sendAt[2] : sendAt[3];
    const [h, m] = at.split(':').map(Number);
    const wait = (h * 60 + m - (start % (24 * 60)) + 24 * 60) % (24 * 60);
    return { day: DAYS[Math.floor(start / (24 * 60)) % 7], at, wait };
  };

  it('starts each run shortly before the time the admin page names', () => {
    expect(crons).toHaveLength(2);
    expect(kindOf[1]).toBe(sendAt[1]);
    const preview = crons.find((c) => c.cron === kindOf[1])!;
    const weekly = crons.find((c) => c.cron !== kindOf[1])!;
    for (const [c, label] of [
      [preview, MAIL_PREVIEW],
      [weekly, MAIL_SEND],
    ] as const) {
      const w = when(c);
      expect(`週${w.day} ${w.at}`).toBe(label);
      // the script waits at most an hour; it starts early for GitHub's delays
      expect(w.wait).toBeGreaterThan(0);
      expect(w.wait).toBeLessThanOrEqual(60);
    }
  });
});
