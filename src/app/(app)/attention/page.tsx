import { AttentionList } from "@/components/attention/AttentionList";
import { getAttentionItems } from "@/server/queries";

export default async function AttentionPage() {
  const rows = await getAttentionItems();
  return (
    <AttentionList
      items={rows.map(({ item, clientName }) => ({
        id: item.id,
        kind: item.kind,
        clientName,
        clientId: item.clientId,
        title: item.title,
        detail: item.detail,
        link: item.link,
        checklist: Array.isArray(item.meta?.checklist) ? (item.meta.checklist as string[]) : null,
      }))}
    />
  );
}
