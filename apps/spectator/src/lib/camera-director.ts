// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
import type {
  CameraAnchor,
  CameraMode,
  OpenCameraRequest,
  ReferenceRecord,
} from "./observatory-types";

export interface CameraView {
  request: OpenCameraRequest;
  resolvedMode: CameraMode;
  anchor: CameraAnchor | null;
  fallbackReason: string | null;
  readOnly: true;
}

export function openCamera(
  request: OpenCameraRequest,
  target: ReferenceRecord,
  anchors: CameraAnchor[],
): CameraView {
  const anchor =
    anchors.find((candidate) => candidate.targetRef === target.refId) ??
    (target.spatial.position
      ? {
          anchorId: "derived-spatial",
          targetRef: target.refId,
          anchorType: "point" as const,
          position: target.spatial.position,
          orientation: target.spatial.orientation ?? { x: 0, y: 0, z: 0, w: 1 },
          bounds: target.spatial.bounds,
          preferredDistance: 6,
          preferredHeight: 3,
          occlusionPolicy: "avoid" as const,
          generated: true,
        }
      : null);
  if (!anchor) {
    return {
      request,
      resolvedMode: "FALLBACK_REFERENCE_VIEW",
      anchor: null,
      fallbackReason: "No canonical or safely derived spatial anchor is available.",
      readOnly: true,
    };
  }

  if (request.mode === "INTERIOR_VIEW" && anchor.anchorType !== "volume") {
    return {
      request,
      resolvedMode: "INSPECT",
      anchor,
      fallbackReason: "No valid interior volume is recorded.",
      readOnly: true,
    };
  }

  if (request.mode === "THIRD_PERSON_FOLLOW" && target.referenceClass !== "ENT") {
    return {
      request,
      resolvedMode: "WIDE_FOLLOW",
      anchor,
      fallbackReason: "Third-person framing is unavailable; environmental tracking is used.",
      readOnly: true,
    };
  }

  return {
    request,
    resolvedMode: request.mode,
    anchor,
    fallbackReason: null,
    readOnly: true,
  };
}
