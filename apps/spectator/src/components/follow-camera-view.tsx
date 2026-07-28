import type { CSSProperties } from "react";
import type { CameraView } from "@/lib/camera-director";
import type { ObservatoryRun, ReferenceRecord } from "@/lib/observatory-types";
import { Badge } from "./ui";

const TERRAIN_COLOURS: Record<string, string> = {
  water: "#173b4c",
  plains: "#40533c",
  fertile: "#58724c",
  forest: "#1f4537",
  stone: "#555b5d",
  stone_deposit: "#555b5d",
  barren: "#594c39",
  unknown: "#252e34",
};

function identityColour(seed: string): string {
  const hue = Number.parseInt(seed.slice(0, 4), 16) % 360;
  return `hsl(${hue} 58% 65%)`;
}

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
  const radius = 5;
  const size = radius * 2 + 1;
  const tiles = Array.from({ length: size * size }, (_, index) => {
    const localX = index % size;
    const localY = Math.floor(index / size);
    const worldX = x + localX - radius;
    const worldY = y + localY - radius;
    const inBounds =
      worldX >= 0 && worldY >= 0 && worldX < run.map.width && worldY < run.map.height;
    const terrain = inBounds
      ? run.map.terrain[worldY * run.map.width + worldX] ?? "unknown"
      : "unknown";
    return { worldX, worldY, terrain, inBounds };
  });
  const canonicalId = String(record.canonicalMetadata.canonicalId ?? "");
  const nearby = run.inhabitants.filter(
    (inhabitant) =>
      inhabitant.id !== canonicalId &&
      Math.abs(inhabitant.location.x - x) <= radius &&
      Math.abs(inhabitant.location.y - y) <= radius,
  );
  const disclosedMoves = run.events.filter(
    (event) => event.actorId === canonicalId && event.canonicalType === "action.move",
  );
  const lastMove = disclosedMoves.at(-1);
  const colour = identityColour(record.observatoryMetadata.visualSeed);
  const style = { "--identity-colour": colour } as CSSProperties;
  const activity = String(record.canonicalMetadata.activityState ?? "unknown");

  return (
    <section className="follow-camera" style={style} aria-labelledby="follow-camera-title">
      <div className="follow-camera__sky" aria-hidden />
      <div className="follow-camera__haze" aria-hidden />

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

      <div className="follow-camera__ground" aria-hidden>
        <div
          className="follow-camera__tiles"
          style={{ gridTemplateColumns: `repeat(${size}, 1fr)` }}
        >
          {tiles.map((tile) => (
            <span
              key={`${tile.worldX},${tile.worldY}`}
              className={tile.inBounds ? "" : "opacity-20"}
              style={{ backgroundColor: TERRAIN_COLOURS[tile.terrain] ?? TERRAIN_COLOURS.unknown }}
            />
          ))}
        </div>
      </div>

      {nearby.map((inhabitant) => {
        const deltaX = inhabitant.location.x - x;
        const deltaY = inhabitant.location.y - y;
        return (
          <div
            key={inhabitant.id}
            className="follow-camera__nearby"
            style={{
              left: `calc(50% + ${(deltaX - deltaY) * 28}px)`,
              top: `calc(62% + ${(deltaX + deltaY) * 13}px)`,
            }}
          >
            <span aria-hidden />
            <small>{inhabitant.displayName}</small>
          </div>
        );
      })}

      <div className="follow-camera__target">
        <div className="follow-camera__target-glow" aria-hidden />
        <div className="follow-camera__figure" aria-label={`Generated presentation marker for ${record.displayName}`}>
          <span className="follow-camera__head" aria-hidden />
          <span className="follow-camera__body" aria-hidden />
          <span className="follow-camera__leg follow-camera__leg--left" aria-hidden />
          <span className="follow-camera__leg follow-camera__leg--right" aria-hidden />
        </div>
        <p>{record.displayName}</p>
        <span className="mono">{activity}</span>
      </div>

      <div className="follow-camera__reticle" aria-hidden>
        <span />
      </div>

      <div className="follow-camera__hud follow-camera__hud--bottom">
        <div>
          <p className="eyebrow">Canonical position</p>
          <p className="mono mt-1 text-sm text-ink">
            ({x}, {y}) · {String(record.canonicalMetadata.status ?? record.status)}
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
