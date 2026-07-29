/**
 * The spectator application's *only* contact with Firebase Authentication.
 *
 * Boundary, stated plainly:
 *
 *   Signing in creates an identity record inside Firebase Auth. It does not,
 *   and cannot, write to the canonical world. This module imports
 *   `firebase/app` and `firebase/auth` and nothing else — in particular never
 *   `firebase/firestore` — so there is no code path from a sign-in button to a
 *   canonical document. `read-only.test.ts` asserts that import boundary.
 *
 * claude.md §17 / §20 / §28 concern the *world's* write path. An account is a
 * viewer's own record: it decides which spectator surfaces the reader may open,
 * and nothing about it reaches an inhabitant. The gate this enables is a
 * product doorway, not a security boundary — the underlying data is the public
 * read-only projection either way, and a static export cannot enforce more.
 *
 * The app instance is created lazily on first use so that a build with no
 * Firebase configuration still compiles and still renders.
 */

import { getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  browserSessionPersistence,
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
  setPersistence,
  signInAnonymously,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type Auth,
  type User,
} from "firebase/auth";

import { firebaseWebConfig } from "./config";

const APP_NAME = "spectator-auth";

/** The Firebase app used for authentication, or `null` when unconfigured. */
function authApp(): FirebaseApp | null {
  const config = firebaseWebConfig();
  if (!config) return null;
  const existing = getApps().find((app) => app.name === APP_NAME);
  return existing ?? initializeApp(config, APP_NAME);
}

/** The `Auth` instance, or `null` when the build has no Firebase config. */
export function auth(): Auth | null {
  const app = authApp();
  return app ? getAuth(app) : null;
}

/** Narrow, human-readable reasons a sign-in attempt did not succeed. */
export type AuthFailure =
  | "unconfigured"
  | "popup-blocked"
  | "popup-closed"
  | "invalid-credential"
  | "email-in-use"
  | "weak-password"
  | "invalid-email"
  | "too-many-requests"
  | "provider-disabled"
  | "bad-config"
  | "unauthorised-domain"
  | "network"
  | "unknown";

export class AuthError extends Error {
  readonly reason: AuthFailure;
  constructor(reason: AuthFailure, message: string) {
    super(message);
    this.name = "AuthError";
    this.reason = reason;
  }
}

/**
 * Firebase error codes, translated into something a reader can act on.
 *
 * `auth/operation-not-allowed` is called out specifically because it is the
 * error an operator sees when a provider exists in code but has not been
 * enabled in the Firebase console — the single most likely first-run failure.
 */
export function describeAuthError(error: unknown): AuthError {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";

  switch (code) {
    case "auth/popup-blocked":
      return new AuthError(
        "popup-blocked",
        "Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.",
      );
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return new AuthError("popup-closed", "The Google sign-in window closed before it finished.");
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return new AuthError("invalid-credential", "That email and password do not match an account.");
    case "auth/email-already-in-use":
      return new AuthError(
        "email-in-use",
        "An account already exists for that email. Sign in instead.",
      );
    case "auth/weak-password":
      return new AuthError("weak-password", "Choose a password of at least six characters.");
    case "auth/invalid-email":
      return new AuthError("invalid-email", "That does not look like an email address.");
    case "auth/too-many-requests":
      return new AuthError(
        "too-many-requests",
        "Too many attempts from this device. Wait a few minutes and try again.",
      );
    case "auth/operation-not-allowed":
    case "auth/admin-restricted-operation":
      return new AuthError(
        "provider-disabled",
        "That sign-in method is not enabled on this Firebase project yet.",
      );
    /*
     * The two deployment mistakes, named rather than passed through raw.
     * Both surface as opaque Firebase strings and both have a precise fix.
     */
    case "auth/api-key-not-valid":
    case "auth/api-key-not-valid.-please-pass-a-valid-api-key.":
    case "auth/invalid-api-key":
      return new AuthError(
        "bad-config",
        "This deployment's Firebase API key is not valid. Check NEXT_PUBLIC_FIREBASE_API_KEY and rebuild.",
      );
    case "auth/unauthorized-domain":
      return new AuthError(
        "unauthorised-domain",
        "This domain is not on the Firebase project's authorised list. Add it under Authentication → Settings → Authorised domains.",
      );
    case "auth/network-request-failed":
      return new AuthError("network", "The network request failed. Check your connection.");
    default:
      return new AuthError(
        "unknown",
        error instanceof Error && error.message ? error.message : "Sign-in did not complete.",
      );
  }
}

function requireAuth(): Auth {
  const instance = auth();
  if (!instance) {
    throw new AuthError(
      "unconfigured",
      "This deployment has no Firebase web configuration, so sign-in is unavailable.",
    );
  }
  return instance;
}

/**
 * `remember` maps to Firebase persistence: local survives a closed tab, session
 * does not. Applied before every sign-in so the choice on the form is the
 * choice that takes effect.
 */
async function applyPersistence(instance: Auth, remember: boolean): Promise<void> {
  await setPersistence(instance, remember ? browserLocalPersistence : browserSessionPersistence);
}

export async function signInWithGoogle(remember: boolean): Promise<User> {
  const instance = requireAuth();
  await applyPersistence(instance, remember);
  const provider = new GoogleAuthProvider();
  // Always let the reader pick an account rather than silently reusing one.
  provider.setCustomParameters({ prompt: "select_account" });
  const credential = await signInWithPopup(instance, provider);
  return credential.user;
}

export async function signInWithEmail(
  email: string,
  password: string,
  remember: boolean,
): Promise<User> {
  const instance = requireAuth();
  await applyPersistence(instance, remember);
  const credential = await signInWithEmailAndPassword(instance, email, password);
  return credential.user;
}

export async function registerWithEmail(
  email: string,
  password: string,
  remember: boolean,
): Promise<User> {
  const instance = requireAuth();
  await applyPersistence(instance, remember);
  const credential = await createUserWithEmailAndPassword(instance, email, password);
  return credential.user;
}

/**
 * Guest entry. An anonymous Firebase account is a real, durable identity that
 * can later be upgraded to a Google or email account without losing whatever is
 * attached to it — as opposed to a local flag, which is not an identity at all.
 * Requires Anonymous sign-in to be enabled on the Firebase project.
 */
export async function continueAsGuest(remember: boolean): Promise<User> {
  const instance = requireAuth();
  await applyPersistence(instance, remember);
  const credential = await signInAnonymously(instance);
  return credential.user;
}

export async function requestPasswordReset(email: string): Promise<void> {
  const instance = requireAuth();
  await sendPasswordResetEmail(instance, email);
}

export async function endSession(): Promise<void> {
  const instance = auth();
  if (instance) await signOut(instance);
}

/**
 * Subscribe to identity changes. Returns an unsubscribe function; when the app
 * is unconfigured it reports "signed out" once and never changes.
 */
export function watchAuthState(listener: (user: User | null) => void): () => void {
  const instance = auth();
  if (!instance) {
    listener(null);
    return () => {};
  }
  return onAuthStateChanged(instance, listener);
}

export type { User };
