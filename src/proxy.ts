import { NextResponse, type NextRequest } from "next/server";
import {
  createSessionToken,
  readSessionToken,
  SESSION_COOKIE,
  SESSION_REFRESH_AFTER,
  sessionCookieOptions,
} from "@/lib/session";

// Optimistic check only. Every server action and API route checks the session itself.
export default async function proxy(req: NextRequest) {
  const session = await readSessionToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  const res = NextResponse.next();
  // Rolling 30-day session.
  if (Date.now() / 1000 - session.iat > SESSION_REFRESH_AFTER) {
    res.cookies.set(SESSION_COOKIE, await createSessionToken(session.sub), sessionCookieOptions);
  }
  return res;
}

export const config = {
  matcher: [
    "/((?!login|api/webhooks/|api/inngest|api/github-callback/|_next/static|_next/image|favicon.ico|manifest.webmanifest|icons/|apple-touch-icon.png|favicon.png|robots.txt).*)",
  ],
};
