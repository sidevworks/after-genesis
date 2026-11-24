// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
"use client";

import { usePathname } from "next/navigation";
import { formatSimTime } from "@/lib/format";

interface HeaderSummary {
  worldId: string;
  simTime: number;
  living: number;
  total: number;
  status: string;
}

export function HeaderWorldStatus({
  archive,
  observatory,
}: {
  archive: HeaderSummary;
  observatory: HeaderSummary;
}) {
  const pathname = usePathname() ?? "/";
  const isObservatory =
    pathname.startsWith("/observatory") ||
    pathname.startsWith("/reference") ||
    pathname.startsWith("/world/");
  const summary = isObservatory ? observatory : archive;

  return (
    <>
      <span className="mono text-[0.65rem] tracking-widest text-dim uppercase">
        {summary.worldId}
      </span>
      <div className="order-3 flex w-full items-center gap-4 sm:order-none sm:w-auto">
        <p className="mono text-xs text-amber" title="World clock">
          {formatSimTime(summary.simTime)}
        </p>
        <p className="mono text-xs text-muted" title="Living inhabitants / total ever created">
          pop {summary.living}
          <span className="text-dim">/{summary.total}</span>
        </p>
        <p className="flex items-center gap-1.5 text-xs text-dim">
          <span
            aria-hidden
            className={`inline-block size-1.5 rounded-full ${
              summary.status === "running" ? "bg-alive" : "bg-warn"
            }`}
          />
          {summary.status}
        </p>
      </div>
    </>
  );
}
