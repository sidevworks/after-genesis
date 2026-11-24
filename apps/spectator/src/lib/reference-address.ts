// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
export interface ResolvedReferenceAddress {
  refId: string;
  view: "ref" | "event" | "watch";
  worldId: string;
}

const VIEWS = new Set<ResolvedReferenceAddress["view"]>(["ref", "event", "watch"]);

export function resolveReferenceAddress(
  pathname: string,
  search: string,
): ResolvedReferenceAddress | null {
  const match = pathname.match(/^\/world\/([^/]+)\/(ref|event|watch)\/([^/]+)\/?$/);
  if (match?.[1] && match[2] && match[3]) {
    return {
      worldId: decodeURIComponent(match[1]),
      view: match[2] as ResolvedReferenceAddress["view"],
      refId: decodeURIComponent(match[3]),
    };
  }

  const query = new URLSearchParams(search);
  const refId = query.get("ref");
  const queryView = query.get("view");
  const view = queryView && VIEWS.has(queryView as ResolvedReferenceAddress["view"])
    ? (queryView as ResolvedReferenceAddress["view"])
    : "ref";
  return refId
    ? {
        worldId: query.get("world") ?? "W001",
        view,
        refId,
      }
    : null;
}
