import { NextResponse, type NextRequest } from "next/server";
import { handleCallback } from "@/server/github-exec";

/** Progress callbacks from the client repo's workflow: HMAC-signed, token-checked, deduped. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(batchId)) return NextResponse.json({ error: "Bad batch id" }, { status: 400 });
  const raw = await req.text();
  if (raw.length > 100_000) return NextResponse.json({ error: "Too large" }, { status: 413 });
  const out = await handleCallback(batchId, raw, {
    ts: req.headers.get("x-seo-autopilot-timestamp"),
    sig: req.headers.get("x-seo-autopilot-signature"),
    token: req.headers.get("x-seo-autopilot-token"),
  });
  return NextResponse.json(out.body, { status: out.status });
}
