// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
import type { CameraView } from "@/lib/camera-director";
import type { ObservatoryRun, ReferenceRecord } from "@/lib/observatory-types";
import { Badge } from "./ui";
import { VoxelWorldViewport } from "./voxel-world-viewport";

export function FollowCameraView({
  record,
  run,
  view,
}: {
  record: ReferenceRecord;
  run: ObservatoryRun;
  view: CameraView;
}) {
  const position = record.spatial.position;
  const x = Math.round(position?.x ?? 0);
  const y = Math.round(position?.z ?? 0);
  const canonicalId = String(record.canonicalMetadata.canonicalId ?? "");
  const disclosedMoves = run.events.filter(
    (event) => event.actorId === canonicalId && event.canonicalType === "action.move",
  );
  const lastMove = disclosedMoves.at(-1);
  const activity = String(record.canonicalMetadata.activityState ?? "unknown");

  return (
    <section className="follow-camera" aria-labelledby="follow-camera-title">
      <div className="follow-camera__hud follow-camera__hud--top">
        <div>
          <p className="eyebrow">Last canonical state · tick {run.world.simTime}</p>
          <h2 id="follow-camera-title" className="mt-1 text-lg font-medium text-ink">
            Following {record.displayName}
          </h2>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Badge tone="warn">archive paused</Badge>
          <Badge tone="alive">{view.resolvedMode.replaceAll("_", " ")}</Badge>
        </div>
      </div>

      <VoxelWorldViewport
        run={run}
        focus={{ x, y }}
        targetId={canonicalId}
        targetName={record.displayName}
        visualSeed={record.observatoryMetadata.visualSeed}
        mode="follow"
      />

      <div className="follow-camera__hud follow-camera__hud--bottom">
        <div>
          <p className="eyebrow">Canonical position</p>
          <p className="mono mt-1 text-sm text-ink">
            ({x}, {y}) · {String(record.canonicalMetadata.status ?? record.status)} · {activity}
          </p>
        </div>
        <div className="text-right">
          <p className="eyebrow">Disclosed movement history</p>
          <p className="mono mt-1 text-sm text-muted">
            {disclosedMoves.length} moves
            {lastMove ? ` · last at tick ${lastMove.simTime}` : ""}
          </p>
        </div>
      </div>

      <p className="follow-camera__truth">
        Generated camera and appearance · canonical position and activity · no live movement
      </p>
    </section>
  );
}
