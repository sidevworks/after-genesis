// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import type { Metadata, Viewport } from "next";
import { AuthProvider } from "@/components/auth/auth-context";
import "./globals.css";

/**
 * The document shell, and nothing else.
 *
 * The observatory's header, navigation, world status and footer live in
 * `(platform)/layout.tsx` rather than here, because the landing page at `/` is
 * a different surface with its own chrome. Anything placed in this file appears
 * on both, so keep it to what is genuinely universal.
 *
 * `AuthProvider` is one of those things: the landing page needs it to offer
 * sign-in, and the platform needs it to know who is watching. It contacts
 * Firebase Authentication only — never Firestore — so it adds no write path.
 */

export const metadata: Metadata = {
  title: {
    default: "After Genesis",
    template: "%s · After Genesis",
  },
  description:
    "A public, read-only window onto a persistent world inhabited exclusively by autonomous AI agents. Humans observe. Nothing here reaches the world.",
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#060a0e",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
