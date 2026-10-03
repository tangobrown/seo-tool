import { notFound } from "next/navigation";
import { ActionedList, type ActionedItem } from "@/components/client/ActionedList";
import { getActioned, getClient } from "@/server/queries";

export default async function ActionedPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await getClient(id))) notFound();
  const data = await getActioned(id);
  const batchById = new Map(data.batches.map((b) => [b.id, b]));
  const jobByBatch = new Map(data.jobs.map((j) => [j.batchId, j]));
  const items: ActionedItem[] = data.opportunities.map((o) => {
    const exec = data.executionByOpportunity[o.id];
    const batch = o.batchId ? batchById.get(o.batchId) : undefined;
    const job = o.batchId ? jobByBatch.get(o.batchId) : undefined;
    const decision = o.status === "deferred" ? "deferred" : o.status === "declined" ? "declined" : "approved";
    return {
      id: o.id,
      category: o.category,
      impact: o.impactLabel,
      title: o.title,
      description: o.description,
      targetUrl: o.targetUrl,
      decision,
      decidedAt: o.decidedAt?.toISOString() ?? null,
      decidedBy: o.decidedBy,
      deferredUntil: o.deferredUntil?.toISOString() ?? null,
      statusNote: o.statusNote,
      execution: exec
        ? { id: exec.id, status: exec.status, error: exec.error, prUrl: job?.prUrl ?? (exec.result?.prUrl as string | undefined) ?? null }
        : null,
      batch: batch
        ? {
            id: batch.id,
            status: batch.status,
            startsAt: batch.startsAt.toISOString(),
            createdAt: batch.createdAt.toISOString(),
            createdBy: batch.createdBy,
            prNumber: job?.prNumber ?? null,
          }
        : null,
    };
  });
  return <ActionedList clientId={id} items={items} />;
}
