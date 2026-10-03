// Formatting helpers. UK conventions, Europe/London.
export const TZ = "Europe/London";

export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: TZ }).format(
    new Date(d),
  );
}

export function formatDayMonth(d: Date | string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: TZ }).format(new Date(d));
}

export function formatDateTime(d: Date | string): string {
  const date = new Date(d);
  const day = formatDayMonth(date);
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ }).format(date);
  return `${day}, ${time}`;
}

export function formatMonthYear(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1, 1)),
  );
}

export function formatMonthShort(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1, 1)),
  );
}

export function formatPounds(pence: number): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 }).format(
    pence / 100,
  );
}

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return new Intl.NumberFormat("en-GB").format(n);
}

export function relativeTime(d: Date | string | null | undefined, now = new Date()): string {
  if (!d) return "never";
  const s = Math.round((now.getTime() - new Date(d).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** YYYY-MM for a date in Europe/London. */
export function periodOf(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "2-digit", timeZone: TZ }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  return `${y}-${m}`;
}

export function pctChange(curr: number | null | undefined, prev: number | null | undefined): number | null {
  if (curr == null || prev == null || prev === 0) return null;
  return Math.round(((curr - prev) / prev) * 100);
}

export function normaliseDomain(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}

export const CATEGORY_LABEL = {
  technical: "Technical",
  on_page: "On-page",
  content: "Content",
  links: "Links",
  local: "Local",
} as const;

export const SCAN_LABEL = { weekly: "Weekly", fortnightly: "Fortnightly", monthly: "Monthly" } as const;
