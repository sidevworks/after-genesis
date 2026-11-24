// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
import type { Coord, ResourceKind, Structure } from "../world-types";

export type ProjectedResourceBundle = Partial<Record<ResourceKind, number>>;

export interface HistoricalStructure extends Structure {
  /** Null when no canonical condition reading existed at this tick. */
  readonly projectedCondition: number | null;
  readonly conditionEventSequence: number | null;
}

export interface RoadTile {
  readonly at: Coord;
  readonly traversals: number;
  /** Relative to the busiest reconstructed tile, 0..1. */
  readonly frequency: number;
}

export interface ResourceSite {
  readonly at: Coord;
  readonly initial: ProjectedResourceBundle;
  readonly remaining: ProjectedResourceBundle;
  readonly extracted: ProjectedResourceBundle;
}

export interface StockpileSite {
  readonly structureId: string;
  readonly at: Coord;
  /**
   * Net canonical deposits and withdrawals observed by the requested tick.
   * This is not labelled as an absolute balance when Genesis inventory is absent.
   */
  readonly recordedNet: ProjectedResourceBundle;
  readonly completeBalanceKnown: boolean;
}

export interface SettlementProjection {
  readonly tick: number;
  readonly structures: readonly HistoricalStructure[];
  readonly roads: readonly RoadTile[];
  readonly resourceSites: readonly ResourceSite[];
  readonly stockpiles: readonly StockpileSite[];
}

