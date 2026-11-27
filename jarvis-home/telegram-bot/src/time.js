// Asia/Jerusalem wall-clock helpers that never depend on the server's TZ.

export const TZ = 'Asia/Jerusalem';

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', weekday: 'short',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Jerusalem wall-clock parts of an instant; weekday is 1=Mon … 7=Sun. */
export function jerusalemParts(date) {
  const p = Object.fromEntries(PARTS.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second),
    weekday: WEEKDAY[p.weekday],
  };
}

function offsetMs(date) {
  const p = jerusalemParts(date);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * The instant at the given Jerusalem wall-clock time. Out-of-range days roll
 * over (day 32 → next month). A time skipped by the spring DST jump resolves
 * to the hour after.
 */
export function jerusalemTime(year, month, day, hour = 0, minute = 0) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetMs(new Date(guess));
  return new Date(guess - offsetMs(new Date(first)));
}

export const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
