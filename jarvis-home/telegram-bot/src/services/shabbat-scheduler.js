import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  getCandle, getChecklist, stagesFor, dueStage, isChecklistDay, renderChecklist, shouldSend,
} from '../agents/shabbat.js';

const CHECK_INTERVAL = 60_000;

let intervalId = null;
let busy = false;
let lastError = null;

// Sent stages survive restarts so a redeploy on Friday doesn't resend the checklist.
const stateFile = () => join(homedir(), 'jarvis', 'state', 'shabbat-checklist.json');

function loadSent(candleIso) {
  try {
    const s = JSON.parse(readFileSync(stateFile(), 'utf-8'));
    return s.candle === candleIso ? s.sent || [] : [];
  } catch {
    return [];
  }
}

function saveSent(candleIso, sent) {
  try {
    mkdirSync(dirname(stateFile()), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify({ candle: candleIso, sent }));
  } catch (err) {
    console.error('[shabbat] Could not save state:', err.message);
  }
}

async function tick(bot, chatId) {
  if (process.env.SHABBAT_CHECKLIST_ENABLED === 'false' || busy) return;
  busy = true;
  try {
    const now = new Date();
    const candle = await getCandle();
    if (!isChecklistDay(candle, now)) return;

    const iso = candle.toISOString();
    const stages = stagesFor(candle, (process.env.SHABBAT_MORNING_TIME || '09:00').trim());
    const stage = dueStage(stages, now, candle, loadSent(iso));
    if (!stage) return;

    const cl = await getChecklist();
    if (!cl.ok) {
      const key = `${iso}:${stage.id}`;
      if (lastError !== key) console.error(`[shabbat] ${stage.id} skipped: ${cl.output}`);
      lastError = key;
      return;
    }

    saveSent(iso, stages.filter((s) => s.at <= stage.at).map((s) => s.id));
    if (!shouldSend(stage.id, cl)) return;

    const { html, extra } = renderChecklist(cl, { stage: stage.id, now });
    await bot.telegram.sendMessage(chatId, html, { parse_mode: 'HTML', ...extra });
    console.log(`[shabbat] Sent ${stage.id} checklist`);
  } catch (err) {
    console.error('[shabbat] Tick failed:', err.message);
  } finally {
    busy = false;
  }
}

export function startShabbatScheduler(bot, chatId) {
  if (intervalId) return;
  intervalId = setInterval(() => tick(bot, chatId), CHECK_INTERVAL);
  const enabled = process.env.SHABBAT_CHECKLIST_ENABLED !== 'false';
  console.log(`[shabbat] Checklist scheduler started (${enabled ? 'enabled' : 'disabled'})`);
}

export function stopShabbatScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[shabbat] Checklist scheduler stopped');
  }
}
