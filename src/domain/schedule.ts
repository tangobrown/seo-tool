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
