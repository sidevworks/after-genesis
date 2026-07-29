"use client";

/**
 * Client-side entry gate for the platform routes.
 *
 * What this is: a product doorway. It decides whether a visitor sees the
 * observatory or is sent back to the landing page to sign in.
 *
 * What this is not: a security boundary. `output: "export"` means these pages
 * are static files served by a CDN; anyone can read them with `curl`. That is
 * acceptable precisely because every byte the spectator app ships is already
 * public read-only projection data (claude.md §20). Nothing behind this gate is
 * secret, and nothing behind it can write to the world. If a surface ever needs
 * a real access boundary, it must be enforced by Firestore security rules on
 * the data, not by this component.
 */

import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { useAuth } from "./auth-context";

/** Where to send the reader back to once they have signed in. */
export const RETURN_TO_KEY = "after_genesis_return_to";

export function AuthGate({ children }: { children: ReactNode }) {
  const { viewer, ready, configured } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const skipGate = process.env.NEXT_PUBLIC_SKIP_AUTH_GATE === "true";

  if (skipGate) return <>{children}</>;

  const blocked = ready && viewer === null && configured;

  useEffect(() => {
    if (!blocked) return;
    try {
      if (pathname && pathname !== "/") sessionStorage.setItem(RETURN_TO_KEY, pathname);
    } catch {
      /* Storage being unavailable only costs us the return path. */
    }
    router.replace("/");
  }, [blocked, pathname, router]);

  /**
   * An unconfigured deployment is let through rather than locked out. A missing
   * environment variable should not make the whole observatory unreachable, and
   * there is nothing behind the gate that secrecy protects.
   */
  if (!configured) return <>{children}</>;

  const settled = ready && viewer !== null;

  /*
   * `children` is rendered in every state, and merely hidden while the viewer
   * is unresolved or on their way out.
   *
   * Returning a placeholder instead would mean each platform route prerenders
   * to a spinner: `output: "export"` runs this component at build time, where
   * there is no session to restore and `ready` is always false. The static HTML
   * would then contain none of the world — no content for a crawler, nothing
   * before hydration, and no page for `read-only.test.ts` to inspect for
   * submitting controls, which is the check that makes the read-only guarantee
   * mechanical rather than aspirational.
   *
   * `hidden` keeps the markup in the document while removing it from the
   * accessibility tree and from view, so a signed-out reader is not shown the
   * observatory during the redirect.
   */
  return (
    <>
      {!settled && (
        <div
          role="status"
          aria-live="polite"
          className="grid min-h-[60vh] place-items-center px-6 text-center"
        >
          <div>
            <p className="eyebrow">{ready ? "Redirecting" : "Restoring your session"}</p>
            <p className="mt-2 text-sm text-muted">
              {ready ? "Taking you back to the entrance…" : "One moment."}
            </p>
          </div>
        </div>
      )}
      <div hidden={!settled}>{children}</div>
    </>
  );
}
