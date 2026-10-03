import { NextResponse } from "next/server";

// Phase 5: Claude Code workflow callbacks (started / item_done / qa_result / pr_opened / failed).
// The contract is documented in templates/client-repo/.seo-autopilot/README.md. Until Phase 5 the
// app uses the FakeExecutor and never dispatches the workflow, so nothing should call this.
export async function POST() {
  return NextResponse.json({ error: "Not implemented until Phase 5" }, { status: 501 });
}
