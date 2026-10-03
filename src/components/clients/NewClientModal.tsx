"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { cx } from "@/components/ui/cx";
import { fieldInputClass, fieldLabelClass, Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { createClient } from "@/server/actions/clients";
import { listGithubRepos } from "@/server/actions/github";

export type NewClientModalProps = {
  open: boolean;
  onClose: () => void;
  tiers: { id: string; name: string }[];
};

export function NewClientModal({ open, onClose, tiers }: NewClientModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="New client" subtitle="We’ll check the site, connect its data and find its services as soon as the client is added.">
      {/* Mounted only while open, so the form starts empty each time. */}
      {open && <NewClientForm onClose={onClose} tiers={tiers} />}
    </Modal>
  );
}

function NewClientForm({ onClose, tiers }: Omit<NewClientModalProps, "open">) {
  const router = useRouter();
  const toast = useToast();
  const defaultTier = tiers.find((t) => t.name === "Growth")?.id ?? tiers[0]?.id ?? "";
  const [form, setForm] = useState({ name: "", website: "", contactName: "", contactEmail: "", tierId: defaultTier, githubRepo: "" });
  const [repos, setRepos] = useState<string[] | null | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listGithubRepos()
      .then((r) => setRepos(r.ok ? r.repos : null))
      .catch(() => setRepos(null));
  }, []);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const canCreate = form.name.trim() && form.website.trim() && form.githubRepo.trim() && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    const res = await createClient(form);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    onClose();
    router.push(`/clients/${res.clientId}/recommendations`);
    toast({ message: `${res.name} added — setting up` });
  }

  return (
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label>
          <span className={fieldLabelClass}>Client name</span>
          <input className={fieldInputClass} value={form.name} onChange={set("name")} autoFocus autoComplete="organization" />
        </label>
        <label>
          <span className={fieldLabelClass}>Website</span>
          <input
            className={fieldInputClass}
            value={form.website}
            onChange={(e) => setForm((f) => ({ ...f, website: e.target.value.replace(/^https?:\/\//i, "") }))}
            placeholder="example.co.uk"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
          />
        </label>
        <div className="grid gap-3 md:grid-cols-2">
          <label>
            <span className={fieldLabelClass}>Contact name</span>
            <input className={fieldInputClass} value={form.contactName} onChange={set("contactName")} autoComplete="off" />
          </label>
          <label>
            <span className={fieldLabelClass}>Contact email</span>
            <input className={fieldInputClass} value={form.contactEmail} onChange={set("contactEmail")} type="email" autoComplete="off" />
          </label>
        </div>
        <div>
          <span className={fieldLabelClass}>Tier</span>
          <div className="flex rounded-md border border-control p-0.5" role="radiogroup" aria-label="Tier">
            {tiers.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={form.tierId === t.id}
                onClick={() => setForm((f) => ({ ...f, tierId: t.id }))}
                className={cx(
                  "min-h-10 flex-1 rounded-[5px] py-1 text-[13px] font-medium transition-quiet md:min-h-0",
                  form.tierId === t.id ? "bg-ink text-white" : "text-ink-3 hover:bg-hover",
                )}
              >
                {t.name}
              </button>
            ))}
          </div>
        </div>
        <label>
          <span className={fieldLabelClass}>GitHub repository</span>
          {Array.isArray(repos) && repos.length > 0 ? (
            <select className={fieldInputClass} value={form.githubRepo} onChange={set("githubRepo")}>
              <option value="">Choose a repository…</option>
              {repos.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          ) : (
            <input
              className={fieldInputClass}
              value={form.githubRepo}
              onChange={set("githubRepo")}
              placeholder={repos === "loading" ? "Loading repositories…" : "owner/name"}
              autoCapitalize="none"
              autoCorrect="off"
            />
          )}
          {repos === null && <span className="mt-1 block text-[12px] text-subtle-2">The GitHub App isn’t installed yet, so type the repository.</span>}
        </label>
        {error && <p className="text-[13px] text-negative">{error}</p>}
        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} className="min-h-11 md:min-h-0">
            Cancel
          </Button>
          <Button type="submit" disabled={!canCreate} className="min-h-11 md:min-h-0">
            {busy ? "Adding…" : "Add client"}
          </Button>
        </div>
      </form>
  );
}
