// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
import type { Metadata } from "next";
import { ReferenceResolver } from "@/components/reference-resolver";

export const metadata: Metadata = {
  title: "Universal reference",
  description: "Resolve any permanent After Genesis Observatory Reference ID.",
};

export default function ReferenceResolverPage() {
  return <ReferenceResolver />;
}
