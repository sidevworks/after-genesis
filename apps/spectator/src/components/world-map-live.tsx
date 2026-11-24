// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useEffect, useState } from "react";
import { getApps, initializeApp } from "firebase/app";
import { doc, getFirestore, onSnapshot } from "firebase/firestore";
import type { WorldMap } from "@/lib/world-types";
import { WorldMapView } from "./world-map";

/**
 * Static export still needs a genuinely live public map. When the configured
 * source is Firestore, subscribe only to its public read projection; no
 * canonical write capability is present in this client bundle.
 */
export function LiveWorldMapView({ initialMap }: { initialMap: WorldMap }) {
  const [map, setMap] = useState(initialMap);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_WORLD_SOURCE !== "firestore") return;
    const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
    const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    const worldId = process.env.NEXT_PUBLIC_WORLD_ID;
    if (!apiKey || !projectId || !worldId) return;

    const name = `spectator-live-map-${worldId}`;
    const app = getApps().find((candidate) => candidate.name === name) ?? initializeApp({
      apiKey,
      authDomain: `${projectId}.firebaseapp.com`,
      projectId,
    }, name);
    return onSnapshot(doc(getFirestore(app), "worlds", worldId, "public", "map"), (snapshot) => {
      if (snapshot.exists()) setMap(snapshot.data() as WorldMap);
    });
  }, []);

  return <WorldMapView map={map} />;
}
