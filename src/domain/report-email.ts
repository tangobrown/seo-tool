import type { ReportSection } from "@/db/schema";

export type ReportEmailInput = {
  contactName: string;
  periodLabel: string; // "September 2026"
  summary: string;
  sections: ReportSection[];
  signoff: string;
};

export function firstName(contact: string): string {
  const cleaned = contact.replace(/^(dr|mr|mrs|ms|miss|prof)\.?\s+/i, "").trim();
  return cleaned.split(/\s+/)[0] || "there";
}

export function reportEmailText(r: ReportEmailInput): string {
  return [
    `Hi ${firstName(r.contactName)},`,
    "",
    `Here’s your SEO summary for ${r.periodLabel}.`,
    "",
    r.summary,
    "",
    ...r.sections.flatMap((s) => [s.title, ...s.items.map((i) => `• ${i}`), ""]),
    r.signoff,
  ].join("\n");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function reportEmailHtml(r: ReportEmailInput): string {
  const p = (s: string) => `<p style="margin:0 0 14px">${esc(s)}</p>`;
  return [
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#2f2e2b">`,
    p(`Hi ${firstName(r.contactName)},`),
    p(`Here’s your SEO summary for ${r.periodLabel}.`),
    p(r.summary),
    ...r.sections.map(
      (s) =>
        `<p style="margin:18px 0 6px;font-weight:bold">${esc(s.title)}</p><ul style="margin:0 0 14px;padding-left:20px">${s.items
          .map((i) => `<li>${esc(i)}</li>`)
          .join("")}</ul>`,
    ),
    `<p style="margin:18px 0 0">${esc(r.signoff).replace(/\n/g, "<br>")}</p>`,
    `</div>`,
  ].join("");
}

export function reportSubject(periodLabel: string, clientName: string): string {
  const month = periodLabel.split(" ")[0];
  return `${month} SEO update — ${clientName}`;
}
