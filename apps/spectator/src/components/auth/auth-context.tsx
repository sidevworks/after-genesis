// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  continueAsGuest,
  describeAuthError,
  endSession,
  registerWithEmail,
  requestPasswordReset,
  signInWithEmail,
  signInWithGoogle,
  watchAuthState,
  type User,
} from "@/lib/firebase/auth-client";
import { isAuthConfigured } from "@/lib/firebase/config";

export type Viewer = {
  readonly uid: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly photoURL: string | null;
  /** True for a guest (anonymous Firebase) account. */
  readonly isGuest: boolean;
};

interface AuthContextValue {
  /** `undefined` while Firebase is still resolving the persisted session. */
  readonly viewer: Viewer | null | undefined;
  readonly ready: boolean;
  readonly configured: boolean;
  signInGoogle(remember: boolean): Promise<void>;
  signInEmail(email: string, password: string, remember: boolean): Promise<void>;
  registerEmail(email: string, password: string, remember: boolean): Promise<void>;
  signInGuest(remember: boolean): Promise<void>;
  resetPassword(email: string): Promise<void>;
  signOutViewer(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function toViewer(user: User | null): Viewer | null {
  if (!user) return null;
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    photoURL: user.photoURL,
    isGuest: user.isAnonymous,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [viewer, setViewer] = useState<Viewer | null | undefined>(undefined);
  const configured = isAuthConfigured();

  useEffect(() => watchAuthState((user) => setViewer(toViewer(user))), []);

  /**
   * Every entry point funnels through here so that a Firebase error code never
   * reaches the interface untranslated.
   */
  const attempt = useCallback(async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      throw describeAuthError(error);
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      viewer,
      ready: viewer !== undefined,
      configured,
      signInGoogle: (remember) => attempt(() => signInWithGoogle(remember)),
      signInEmail: (email, password, remember) =>
        attempt(() => signInWithEmail(email, password, remember)),
      registerEmail: (email, password, remember) =>
        attempt(() => registerWithEmail(email, password, remember)),
      signInGuest: (remember) => attempt(() => continueAsGuest(remember)),
      resetPassword: (email) => attempt(() => requestPasswordReset(email)),
      signOutViewer: () => attempt(() => endSession()),
    }),
    [viewer, configured, attempt],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }
  return context;
}

/** Convenience for surfaces that only need to know whether anyone is here. */
export function useViewer(): Viewer | null | undefined {
  return useAuth().viewer;
}
