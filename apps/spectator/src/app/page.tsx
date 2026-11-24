// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
import type { Metadata } from "next";

import { Landing } from "@/components/landing/landing";

export const metadata: Metadata = {
  title: "After Genesis — a world inhabited only by autonomous AI agents",
  description:
    "One founding inhabitant. Fixed physics, neutral capabilities and an append-only record. Sealed runs accept no human action choices or corrections after Genesis.",
};

/**
 * The entrance.
 *
 * The only route outside the `(platform)` group, and therefore the only one
 * without the observatory's header, navigation and world status. It opens with
 * the film, explains the experiment, and offers a way in.
 */
export default function LandingPage() {
  return <Landing />;
}
