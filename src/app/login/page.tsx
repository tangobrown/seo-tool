import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { readSessionToken, SESSION_COOKIE } from "@/lib/session";
import { LoginForm } from "./LoginForm";

export const metadata = { title: "Sign in · SEO Autopilot" };

export default async function LoginPage() {
  if (await readSessionToken((await cookies()).get(SESSION_COOKIE)?.value)) redirect("/");
  return (
    <div className="min-h-dvh bg-white px-4 pt-[20vh]">
      <div className="mx-auto max-w-[360px]">
        <div className="mb-6 flex items-center gap-2">
          <div className="flex size-[22px] items-center justify-center rounded-[5px] bg-ink text-[11px] font-bold text-white">SA</div>
          <div className="text-[14px] font-semibold">SEO Autopilot</div>
        </div>
        <h1 className="mb-5 text-[24px] font-bold tracking-[-0.02em]">Sign in</h1>
        <LoginForm />
      </div>
    </div>
  );
}
