// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import type { Metadata } from "next";
import { ReferenceResolver } from "@/components/reference-resolver";

export const metadata: Metadata = {
  title: "Universal reference",
  description: "Resolve any permanent After Genesis Observatory Reference ID.",
};

export default function ReferenceResolverPage() {
  return <ReferenceResolver />;
}
