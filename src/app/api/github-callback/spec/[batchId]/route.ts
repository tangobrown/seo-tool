import { NextResponse, type NextRequest } from "next/server";
import { buildSpec, verifySignature } from "@/server/github-exec";

/**
 * Batch spec for the client repo's workflow. Authenticated by HMAC (shared org secret), not by
 * session: the caller is GitHub Actions. Each fetch issues a fresh one-time callback token.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(batchId)) return NextResponse.json({ error: "Bad batch id" }, { status: 400 });
  if (!verifySignature(req.headers.get("x-seo-autopilot-timestamp"), req.headers.get("x-seo-autopilot-signature"), batchId)) {
    return NextResponse.json({ error: "Bad signature" }, { status: 401 });
  }
  const spec = await buildSpec(batchId);
  if (!spec) return NextResponse.json({ error: "No active job for this batch" }, { status: 404 });
  return NextResponse.json(spec, { headers: { "Cache-Control": "no-store" } });
}
