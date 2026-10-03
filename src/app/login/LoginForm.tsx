"use client";

import { useActionState } from "react";
import { fieldInputClass, fieldLabelClass } from "@/components/ui/Modal";
import { login, type LoginState } from "./actions";

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <label>
        <span className={fieldLabelClass}>Email</span>
        <input name="email" type="email" autoComplete="username" required className={fieldInputClass} autoCapitalize="none" />
      </label>
      <label>
        <span className={fieldLabelClass}>Password</span>
        <input name="password" type="password" autoComplete="current-password" required className={fieldInputClass} />
      </label>
      {state.error && <p className="text-[13px] text-negative">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="mt-1 min-h-11 w-full rounded-md bg-ink text-[13px] font-medium text-white transition-quiet hover:bg-ink-hover disabled:bg-disabled md:min-h-9"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
