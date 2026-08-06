import { runBusQuery } from '../agents/bus.js';

/**
 * /bus — commute ETAs from HA sensors (same data as the Lovelace cards).
 */
export async function busCommand(ctx) {
  const question = (ctx.message?.text || '').replace(/^\/bus(@\w+)?\s*/i, '').trim();
  await ctx.reply('Checking the buses, Sir...');
  const res = await runBusQuery(question || 'next bus');
  await ctx.reply(res.ok ? res.output : `Couldn't check the buses: ${res.output}`, {
    parse_mode: 'HTML',
  });
}
