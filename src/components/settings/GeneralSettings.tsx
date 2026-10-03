"use client";

import { useState } from "react";
import { PropertyRow, propertyInputClass } from "@/components/ui/PropertyRow";
import { useToast } from "@/components/ui/Toast";
import { useDebouncedSave } from "@/components/ui/useAutosave";
import { updateWorkspaceField, type WorkspaceField } from "@/server/actions/settings";

type Ws = {
  name: string;
  senderName: string;
  replyTo: string;
  signoff: string;
  undoWindowSeconds: number;
  recsPerScan: number;
  minScore: number;
  scanDay: number;
  scanTime: string;
};

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function GeneralSettings({ ws }: { ws: Ws }) {
  const toast = useToast();
  const [v, setV] = useState(ws);
  const saveField = async (field: WorkspaceField, value: unknown) => {
    const r = await updateWorkspaceField(field, value);
    if (!r.ok) toast({ message: r.error });
  };
  const savers = {
    name: useDebouncedSave((x: string) => saveField("name", x)),
    senderName: useDebouncedSave((x: string) => saveField("senderName", x)),
    replyTo: useDebouncedSave((x: string) => saveField("replyTo", x)),
    signoff: useDebouncedSave((x: string) => saveField("signoff", x)),
    undoWindowSeconds: useDebouncedSave((x: string) => saveField("undoWindowSeconds", x)),
    recsPerScan: useDebouncedSave((x: string) => saveField("recsPerScan", x)),
    minScore: useDebouncedSave((x: string) => saveField("minScore", x)),
    scanTime: useDebouncedSave((x: string) => saveField("scanTime", x)),
  };
  const on = (k: keyof typeof savers) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const x = e.target.value;
    setV((s) => ({ ...s, [k]: x }));
    savers[k](x);
  };

  return (
    <div>
      <PropertyRow label="Workspace name" labelWidth={180}>
        <input className={propertyInputClass} value={v.name} onChange={on("name")} />
      </PropertyRow>
      <PropertyRow label="Report sender name" labelWidth={180}>
        <input className={propertyInputClass} value={v.senderName} onChange={on("senderName")} />
      </PropertyRow>
      <PropertyRow label="Reply-to email" labelWidth={180}>
        <input className={propertyInputClass} value={v.replyTo} onChange={on("replyTo")} type="email" />
      </PropertyRow>
      <PropertyRow label="Monthly report" labelWidth={180}>
        <div className="px-0 py-1.5 text-muted md:px-2">Generated on the 1st of each month at 07:00</div>
      </PropertyRow>
      <PropertyRow label="Undo window (seconds)" labelWidth={180}>
        <input className={propertyInputClass} value={v.undoWindowSeconds} onChange={on("undoWindowSeconds")} inputMode="numeric" />
      </PropertyRow>
      <PropertyRow label="Recommendations per scan" labelWidth={180}>
        <input className={propertyInputClass} value={v.recsPerScan} onChange={on("recsPerScan")} inputMode="numeric" />
      </PropertyRow>
      <PropertyRow label="Minimum score" labelWidth={180}>
        <input className={propertyInputClass} value={v.minScore} onChange={on("minScore")} inputMode="numeric" />
      </PropertyRow>
      <PropertyRow label="Scan day and time" labelWidth={180}>
        <div className="flex gap-2">
          <select
            className={propertyInputClass}
            value={v.scanDay}
            onChange={(e) => {
              const d = Number(e.target.value);
              setV((s) => ({ ...s, scanDay: d }));
              void saveField("scanDay", d);
            }}
          >
            {DAYS.map((d, i) => (
              <option key={d} value={i + 1}>
                {d}
              </option>
            ))}
          </select>
          <input className={propertyInputClass} type="time" value={v.scanTime} onChange={on("scanTime")} />
        </div>
      </PropertyRow>
      <PropertyRow label="Email sign-off" labelWidth={180}>
        <textarea className={propertyInputClass + " resize-y"} rows={3} value={v.signoff} onChange={on("signoff")} />
      </PropertyRow>
    </div>
  );
}
