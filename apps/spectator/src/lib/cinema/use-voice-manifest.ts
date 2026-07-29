"use client";

/**
 * Loading the rendered-audio manifest for a Watch reel.
 *
 * The manifest is fetched only for subscribers. That is not merely a UI
 * nicety: a free viewer never requests the file, so no clip text, speaker
 * mapping or provider voice id reaches them.
 *
 * It is also not a security boundary, and must not be mistaken for one — see
 * `components/tier-context.tsx` for what actually enforces the subscription and
 * what does not.
 */

import { useEffect, useState } from "react";
// The `/manifest` subpath, not the package root: it is import-free by design,
// so the browser bundle never pulls in the ElevenLabs client. See that file.
import {
  isPlayableManifest,
  type VoiceClip,
  type VoiceManifest,
} from "@after-genesis/media/manifest";

export type { VoiceClip, VoiceManifest };

export type ManifestStatus = "idle" | "loading" | "ready" | "missing" | "error";

export interface VoiceManifestState {
  readonly manifest: VoiceManifest | null;
  readonly status: ManifestStatus;
}

export function useVoiceManifest(reel: string, enabled: boolean): VoiceManifestState {
  const [state, setState] = useState<VoiceManifestState>({ manifest: null, status: "idle" });

  useEffect(() => {
    if (!enabled) {
      setState({ manifest: null, status: "idle" });
      return;
    }

    // Guards against a reel switch resolving out of order and installing a
    // stale manifest over a newer one.
    let active = true;
    setState({ manifest: null, status: "loading" });

    fetch(`/voice/${reel}/manifest.json`)
      .then(async (response) => {
        if (!active) return;
        // A reel with no render yet is an ordinary state, not a failure: the
        // player shows that nothing has been rendered and stays silent.
        if (response.status === 404) {
          setState({ manifest: null, status: "missing" });
          return;
        }
        if (!response.ok) {
          setState({ manifest: null, status: "error" });
          return;
        }

        const parsed: unknown = await response.json();
        if (!active) return;
        setState(
          isPlayableManifest(parsed)
            ? { manifest: parsed, status: "ready" }
            : { manifest: null, status: "error" },
        );
      })
      .catch(() => {
        if (active) setState({ manifest: null, status: "error" });
      });

    return () => {
      active = false;
    };
  }, [reel, enabled]);

  return state;
}
