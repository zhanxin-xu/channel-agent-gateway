/**
 * Days for usage and quotas are UTC days: they end at 00:00 UTC, 08:00 in
 * Beijing, when OpenRouter's daily key limits reset too.
 */

/** "YYYY-MM-DD" of the UTC day `ms` falls in. */
export const utcDay = (ms = Date.now()): string => new Date(ms).toISOString().slice(0, 10);

/** The UTC day `days` before `day`. */
export const daysBefore = (day: string, days: number): string => utcDay(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000);

/** When the current UTC day ends (epoch ms). */
export const nextDayStart = (ms = Date.now()): number => Date.parse(`${utcDay(ms)}T00:00:00Z`) + 86_400_000;

/** "北京时间 11月6日 08:00" (Beijing has no DST: UTC+8 all year). */
export function beijingTime(ms: number): string {
  const t = new Date(ms + 8 * 3600_000);
  const hm = `${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}`;
  return `北京时间 ${t.getUTCMonth() + 1}月${t.getUTCDate()}日 ${hm}`;
}
