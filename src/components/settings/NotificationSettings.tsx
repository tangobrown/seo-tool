"use client";

import { useState, useTransition } from "react";
import type { NotificationPrefs } from "@/db/schema";
import { Button } from "@/components/ui/Button";
import { fieldInputClass } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { ToggleRow } from "@/components/ui/Toggle";
import { sendTestSlack, setSlackWebhook, updateWorkspaceField } from "@/server/actions/settings";

const TOGGLES: [keyof NotificationPrefs, string, string][] = [
  ["newRecs", "New recommendations", "When a scan finds new recommendations"],
  ["reports", "Monthly reports ready", "On the 1st when reports are generated"],
  ["weeklyDigest", "Weekly digest", "A Monday summary of pending work across all clients"],
  ["failures", "Failures and things that need action", "Failed jobs, PRs to review, manual actions and integration errors"],
];

export function NotificationSettings({ prefs, hasWebhook }: { prefs: NotificationPrefs; hasWebhook: boolean }) {
  const toast = useToast();
  const [p, setP] = useState(prefs);
  const [url, setUrl] = useState("");
  const [saved, setSaved] = useState(hasWebhook);
  const [pending, start] = useTransition();

  return (
    <div>
      <p className="mb-2 text-[13px] text-muted">Sent to Slack. You’re only notified about things that need you.</p>
      {TOGGLES.map(([k, label, desc]) => (
        <ToggleRow
          key={k}
          label={label}
          description={desc}
          on={p[k]}
          onChange={async (v) => {
            const next = { ...p, [k]: v };
            setP(next);
            const r = await updateWorkspaceField("notifications", next);
            if (!r.ok) toast({ message: r.error });
          }}
        />
      ))}
      <div className="mt-6">
        <div className="mb-1 font-medium">Slack webhook URL</div>
        <p className="mb-2 text-[13px] text-muted">{saved ? "A webhook is saved (stored encrypted). Paste a new one to replace it." : "Paste an incoming webhook URL from Slack."}</p>
        <form
          className="flex flex-col gap-2 md:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await setSlackWebhook(url);
              toast({ message: r.ok ? (url ? "Webhook saved" : "Webhook removed") : r.error });
              if (r.ok) {
                setSaved(!!url);
                setUrl("");
              }
            });
          }}
        >
          <input className={fieldInputClass} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.slack.com/services/…" autoCapitalize="none" />
          <Button type="submit" disabled={pending} className="min-h-11 md:min-h-0">
            Save
          </Button>
        </form>
        {saved && (
          <button
            type="button"
            disabled={pending}
            className="mt-2 min-h-11 text-[13px] font-medium underline decoration-faint underline-offset-2 hover:decoration-ink md:min-h-0"
            onClick={() =>
              start(async () => {
                const r = await sendTestSlack();
                toast({ message: r.ok ? "Test message sent" : r.error });
              })
            }
          >
            Send test
          </button>
        )}
      </div>
    </div>
  );
}
