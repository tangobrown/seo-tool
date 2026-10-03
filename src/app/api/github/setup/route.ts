import { NextResponse, type NextRequest } from "next/server";
import { saveInstallation } from "@/integrations/github";
import { audit } from "@/lib/audit";
import { requireSession, UnauthorizedError } from "@/lib/auth";

/** GitHub App "Setup URL": GitHub redirects here after the App is installed. */
export async function GET(req: NextRequest) {
  try {
    await requireSession();
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.redirect(new URL("/login", req.url));
    throw e;
  }
  const id = Number(req.nextUrl.searchParams.get("installation_id"));
  if (Number.isInteger(id) && id > 0) {
    await saveInstallation(id, null);
    await audit({ actor: "operator", entityType: "integration", entityId: "github", event: "github.installed", after: { installationId: id } });
  }
  return NextResponse.redirect(new URL("/settings/integrations", req.url));
}
