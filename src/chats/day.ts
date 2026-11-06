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
