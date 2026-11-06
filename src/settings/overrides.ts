/**
 * Values set in the admin console, by environment variable name. config.ts
 * reads these before process.env; the settings service (service.ts) fills
 * them from the database. No imports, so config.ts can depend on it without a cycle.
 */
let current: ReadonlyMap<string, string> = new Map();

export const overrideOf = (name: string): string | undefined => current.get(name);

export function setOverrides(values: ReadonlyMap<string, string>): void {
  current = values;
}
