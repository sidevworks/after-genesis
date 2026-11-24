// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * Firebase *web* configuration for the spectator application.
 *
 * These six values are public by construction. They are compiled into the
 * client bundle and are visible to anyone who opens the page — that is how the
 * Firebase web SDK is designed to work. They identify a project; they do not
 * authorise anything. Access is decided by Firebase security rules and by the
 * Firebase Authentication authorised-domain list, never by the secrecy of the
 * API key.
 *
 * What must NEVER appear here, or anywhere else under `apps/spectator`:
 *
 *   - a service-account JSON key, or any field of one
 *   - the application-credentials path variable the runtime uses
 *   - the Gemini or ElevenLabs API keys
 *   - any Firebase Admin SDK credential
 *
 * `read-only.test.ts` asserts the absence of each of those by pattern, so this
 * is a checked claim rather than a comment.
 *
 * claude.md §17: the simulation runtime's service account is the only writer to
 * canonical state and must never be present in the spectator app's environment,
 * including its Vercel project. A service-account key is not a substitute for
 * the web config below — it is a different kind of object entirely, and putting
 * one in a browser bundle hands the world's write credential to every visitor.
 *
 * Every variable is `NEXT_PUBLIC_`-prefixed so that Next inlines it at build
 * time. `output: "export"` means there is no server to read them at runtime.
 * Set them in the Vercel project's environment (all environments) and locally
 * in `.env` / `.env.local`.
 */

export interface FirebaseWebConfig {
  readonly apiKey: string;
  readonly authDomain: string;
  readonly projectId: string;
  readonly storageBucket?: string;
  readonly messagingSenderId?: string;
  readonly appId?: string;
}

/**
 * Literal `process.env.X` reads. Next replaces each of these at build time by
 * textual substitution, so they cannot be computed, looped over or indexed
 * dynamically — that is why this reads as a repetitive block rather than a map.
 */
const RAW = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
} as const;

function present(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The configuration, or `null` when it has not been supplied.
 *
 * Returning `null` rather than throwing is deliberate: a missing web config is
 * a deployment gap, not a corrupt world. The build must still succeed and the
 * landing page must still render and explain itself — it simply cannot offer
 * sign-in until the values exist.
 */
export function firebaseWebConfig(): FirebaseWebConfig | null {
  if (
    !present(RAW.apiKey) ||
    !present(RAW.authDomain) ||
    !present(RAW.projectId) ||
    !present(RAW.appId)
  ) {
    return null;
  }
  return {
    apiKey: RAW.apiKey,
    authDomain: RAW.authDomain,
    projectId: RAW.projectId,
    ...(present(RAW.storageBucket) ? { storageBucket: RAW.storageBucket } : {}),
    ...(present(RAW.messagingSenderId) ? { messagingSenderId: RAW.messagingSenderId } : {}),
    appId: RAW.appId,
  };
}

/** Whether sign-in can be offered at all in this build. */
export function isAuthConfigured(): boolean {
  return firebaseWebConfig() !== null;
}

/**
 * The names an operator has to set, in the order the Firebase console presents
 * them. Rendered on the landing page when configuration is absent, so that a
 * misconfigured deployment diagnoses itself instead of failing silently.
 */
export const REQUIRED_ENV_VARS = [
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
] as const;

export function missingFirebaseEnvVars(): readonly (typeof REQUIRED_ENV_VARS)[number][] {
  const missing: (typeof REQUIRED_ENV_VARS)[number][] = [];
  if (!present(RAW.apiKey)) missing.push("NEXT_PUBLIC_FIREBASE_API_KEY");
  if (!present(RAW.authDomain)) missing.push("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN");
  if (!present(RAW.projectId)) missing.push("NEXT_PUBLIC_FIREBASE_PROJECT_ID");
  if (!present(RAW.appId)) missing.push("NEXT_PUBLIC_FIREBASE_APP_ID");
  return missing;
}
