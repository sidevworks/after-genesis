"use client";

/**
 * Sign-in for the spectator platform.
 *
 * Why this is not a form: `read-only.test.ts` fails the build if any source
 * file in this app contains a form element, a submitting control, a submit
 * handler or a non-GET method — the mechanical expression of
 * claude.md §17/§20/§28. That rule is about the *world*, and these credentials
 * go to Firebase Auth rather than to canonical state, but the rule is
 * deliberately blunt and worth keeping blunt: no submitting control exists
 * anywhere in this application, with no carve-out to argue about later.
 *
 * The accessibility and password-manager behaviour a form would give us is
 * preserved by hand: real `<label for>` pairs, `type="email"` / `type="password"`
 * inputs with correct `autoComplete` tokens (managers key off these, not off the
 * form element), and an Enter-key handler so the keyboard path still works.
 */

import { useId, useState } from "react";

import { useAuth } from "./auth-context";
import { missingFirebaseEnvVars } from "@/lib/firebase/config";

type Mode = "signin" | "register";

const REMEMBER_KEY = "after_genesis_remember_session";

function readRemembered(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(REMEMBER_KEY) !== "false";
  } catch {
    return true;
  }
}

function storeRemembered(value: boolean): void {
  try {
    window.localStorage.setItem(REMEMBER_KEY, value ? "true" : "false");
  } catch {
    /* Private browsing and locked-down storage are not errors here. */
  }
}

export function SignInPanel({
  onSignedIn,
  /**
   * Before Genesis there is nothing behind the door, so the same panel asks a
   * different question: not "let me in" but "tell me when it starts". The
   * account is the same object either way — see `lib/launch.ts` for why the
   * waitlist is an account rather than a second store of people.
   */
  waitlist = false,
}: {
  onSignedIn?: () => void;
  waitlist?: boolean;
}) {
  const { configured, signInGoogle, signInEmail, registerEmail, signInGuest, resetPassword } =
    useAuth();

  const [mode, setMode] = useState<Mode>(waitlist ? "register" : "signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(readRemembered);
  const [busy, setBusy] = useState<null | "google" | "email" | "guest" | "reset">(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const emailId = useId();
  const passwordId = useId();
  const rememberId = useId();
  const messageId = useId();

  function setRememberChoice(next: boolean) {
    setRemember(next);
    storeRemembered(next);
  }

  async function run(kind: NonNullable<typeof busy>, action: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      await action();
      onSignedIn?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign-in did not complete.");
    } finally {
      setBusy(null);
    }
  }

  const emailReady = email.trim().length > 0 && password.length > 0;
  const missingEnvVars = missingFirebaseEnvVars();

  function submitEmail() {
    if (!emailReady || busy) return;
    void run("email", () =>
      mode === "signin"
        ? signInEmail(email.trim(), password, remember)
        : registerEmail(email.trim(), password, remember),
    );
  }

  if (!configured) {
    return (
      <div className="panel p-5">
        <p className="eyebrow">Sign-in unavailable</p>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          This deployment was built without a Firebase web configuration, so no account can be
          created or restored. The world itself is unaffected — it does not know this application
          exists.
        </p>
        <p className="mt-3 text-xs text-dim">Set {missingEnvVars.length === 1 ? "this" : "these"} and rebuild:</p>
        <ul className="mono mt-1.5 space-y-0.5 text-xs text-amber">
          {missingEnvVars.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-label={mode === "signin" ? "Sign in" : "Create an account"}
      className="panel p-5 sm:p-6"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-medium tracking-tight text-ink">
          {waitlist
            ? mode === "register"
              ? "Be there when it starts"
              : "Sign in"
            : mode === "signin"
              ? "Enter the observatory"
              : "Create an account"}
        </h2>
        <button
          type="button"
          onClick={() => {
            setMode(mode === "signin" ? "register" : "signin");
            setError(null);
            setNotice(null);
          }}
          className="text-xs text-amber hover:underline"
        >
          {mode === "signin" ? (waitlist ? "Join the waitlist" : "Create one") : "I have an account"}
        </button>
      </div>

      <p className="mt-1.5 text-xs leading-relaxed text-dim">
        {waitlist
          ? "Your place on the waitlist is your account. We will write to you once — when the first inhabitant wakes."
          : "An account decides what you may watch. It gives you no way to act inside the world."}
      </p>

      {/* Google ------------------------------------------------------------ */}
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => void run("google", () => signInGoogle(remember))}
        className="mt-4 flex w-full items-center justify-center gap-2.5 rounded border border-line bg-panel-2 px-4 py-2.5 text-sm text-ink transition-colors hover:border-amber-dim hover:bg-panel disabled:cursor-not-allowed disabled:opacity-55"
      >
        <GoogleMark />
        {busy === "google" ? "Opening Google…" : "Continue with Google"}
      </button>

      <div className="my-4 flex items-center gap-3">
        <span className="h-px flex-1 bg-line" />
        <span className="eyebrow">or</span>
        <span className="h-px flex-1 bg-line" />
      </div>

      {/* Email ------------------------------------------------------------- */}
      <div className="space-y-3">
        <div>
          <label htmlFor={emailId} className="eyebrow block">
            Email
          </label>
          <input
            id={emailId}
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitEmail();
            }}
            autoComplete="email"
            inputMode="email"
            placeholder="you@example.com"
            aria-describedby={error || notice ? messageId : undefined}
            className="mono mt-1.5 w-full rounded border border-line bg-abyss px-3 py-2 text-sm text-ink placeholder:text-dim focus:border-amber focus:outline-none"
          />
        </div>

        <div>
          <div className="flex items-baseline justify-between gap-3">
            <label htmlFor={passwordId} className="eyebrow block">
              Password
            </label>
            {mode === "signin" && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  if (!email.trim()) {
                    setError("Enter your email address first, then request a reset link.");
                    return;
                  }
                  void run("reset", async () => {
                    await resetPassword(email.trim());
                    setNotice(`If an account exists for ${email.trim()}, a reset link is on its way.`);
                  });
                }}
                className="text-[0.7rem] text-dim hover:text-amber hover:underline disabled:opacity-55"
              >
                Forgotten?
              </button>
            )}
          </div>
          <input
            id={passwordId}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitEmail();
            }}
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            placeholder={mode === "register" ? "at least six characters" : "••••••••"}
            aria-describedby={error || notice ? messageId : undefined}
            className="mono mt-1.5 w-full rounded border border-line bg-abyss px-3 py-2 text-sm text-ink placeholder:text-dim focus:border-amber focus:outline-none"
          />
        </div>

        <button
          type="button"
          disabled={!emailReady || busy !== null}
          onClick={submitEmail}
          className="w-full rounded border border-amber-dim bg-amber/12 px-4 py-2.5 text-sm font-medium text-amber transition-colors hover:bg-amber/20 disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-dim"
        >
          {busy === "email"
            ? "Working…"
            : mode === "signin"
              ? "Sign in with email"
              : waitlist
                ? "Join with email"
                : "Create account"}
        </button>
      </div>

      {/* Remember ---------------------------------------------------------- */}
      <div className="mt-4 flex items-start gap-2.5">
        <input
          id={rememberId}
          type="checkbox"
          checked={remember}
          onChange={(event) => setRememberChoice(event.target.checked)}
          className="mt-0.5 size-3.5 accent-[var(--color-amber)]"
        />
        <label htmlFor={rememberId} className="text-xs leading-relaxed text-muted">
          Keep me signed in on this device
          <span className="block text-dim">
            Off means the session ends when you close the tab.
          </span>
        </label>
      </div>

      {/*
        Guest ---------------------------------------------------------------
        Withheld while the world is sealed. An anonymous account carries no
        address to write to and there is nothing yet to look at, so offering it
        here would be a dead end — it returns on its own at Genesis, when it
        means something again.
      */}
      {!waitlist && (
        <div className="hairline mt-4 pt-4">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void run("guest", () => signInGuest(remember))}
            className="w-full rounded border border-dashed border-line px-4 py-2.5 text-sm text-muted transition-colors hover:border-line-soft hover:text-ink disabled:opacity-55"
          >
            {busy === "guest" ? "Opening…" : "Continue as guest"}
          </button>
          <p className="mt-2 text-[0.7rem] leading-relaxed text-dim">
            A guest account watches everything a free account watches. Add a Google or email sign-in
            later and it keeps the same identity.
          </p>
        </div>
      )}

      {(error || notice) && (
        <p
          id={messageId}
          role="status"
          aria-live="polite"
          className={`mt-4 rounded border px-3 py-2 text-xs leading-relaxed ${
            error ? "border-warn/40 bg-warn/8 text-warn" : "border-alive/35 bg-alive/8 text-alive"
          }`}
        >
          {error ?? notice}
        </p>
      )}
    </div>
  );
}

/** Google's mark, inline so the page makes no third-party request to render it. */
function GoogleMark() {
  return (
    <svg aria-hidden viewBox="0 0 18 18" className="size-4 shrink-0">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}
