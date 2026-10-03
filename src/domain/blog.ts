/** §10.6: behind schedule = within the final 7 days of the month and fewer than N posts approved. */
export function isBlogBehind(input: { committed: number; approved: number; now: Date; daysInMonth: number; dayOfMonth: number }): boolean {
  if (input.committed <= 0) return false;
  const inFinalWeek = input.daysInMonth - input.dayOfMonth < 7;
  return inFinalWeek && input.approved < input.committed;
}

export function londonDayInfo(now: Date): { dayOfMonth: number; daysInMonth: number } {
  const parts = new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "numeric", day: "numeric", timeZone: "Europe/London" }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  const d = Number(parts.find((p) => p.type === "day")?.value);
  return { dayOfMonth: d, daysInMonth: new Date(Date.UTC(y, m, 0)).getUTCDate() };
}
