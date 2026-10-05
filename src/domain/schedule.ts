/** §10.1 cadence. All dates are interpreted in Europe/London by the caller. */

export function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86400_000 + 1) / 7);
}

/**
 * Given that today is the workspace scan day: weekly → always; fortnightly → ISO weeks with the
 * same parity as the client's start week; monthly → the first scan day of the month.
 */
export function isScanDue(frequency: "weekly" | "fortnightly" | "monthly", today: Date, clientCreatedAt: Date): boolean {
  if (frequency === "weekly") return true;
  if (frequency === "fortnightly") return isoWeek(today) % 2 === isoWeek(clientCreatedAt) % 2;
  return today.getUTCDate() <= 7;
}

/** London wall-clock parts for a moment. */
export function londonParts(now: Date): { date: Date; isoDay: number; hhmm: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const date = new Date(Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day"))));
  const isoDay = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday")) + 1;
  return { date, isoDay, hhmm: `${get("hour")}:${get("minute")}` };
}

/** The UTC instant of 00:00 Europe/London on a calendar date (handles GMT/BST). */
export function londonMidnight(y: number, m: number, d: number): Date {
  const guess = Date.UTC(y, m - 1, d);
  const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false }).format(new Date(guess))) % 24;
  return new Date(guess - h * 3600_000);
}

/** "2026-09" → [1 Sep 00:00 London, 1 Oct 00:00 London). */
export function londonMonthBounds(period: string): { start: Date; end: Date } {
  const [y, m] = period.split("-").map(Number) as [number, number];
  return { start: londonMidnight(y, m, 1), end: m === 12 ? londonMidnight(y + 1, 1, 1) : londonMidnight(y, m + 1, 1) };
}

/** "2026-10" → "2026-09" */
export function previousPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}
