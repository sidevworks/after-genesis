/**
 * Render the Watch reels' audio ahead of time (§21, §4G).
 *
 * ## Why this is a script and not a request the app makes
 *
 * The spectator app is a static export with no server (see `next.config.mjs`),
 * deliberately: §17 requires the public client to have no canonical write path,
 * and §28 requires that no human-facing write route exist at all. That decision
 * also settles how audio works. There is no route handler that could proxy a
 * provider call, and a client-side call would ship `ELEVENLABS_API_KEY` to
 * every spectator.
 *
 * So audio is rendered here, offline, on a machine that holds the key, and
 * published as ordinary static files. The browser only ever fetches an `.mp3`.
 *
 * ## Usage
 *
 *     node --experimental-strip-types scripts/render-voice.mts [--reel=month|all]
 *                                                              [--limit=N] [--dry-run]
 *
 * `--dry-run` prints what would be synthesized and its estimated cost without
 * contacting the provider or spending anything. `--limit` caps new syntheses
 * per run, so an exploratory render cannot empty a budget by accident (§15).
 *
 * Re-running is cheap: clips are content-addressed, so only genuinely new
 * lines are billed.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ElevenLabsClient,
  EMPTY_NARRATION_CACHE,
  buildVoiceRegistry,
  dayPartOf,
  isCurrentCache,
  narrationKey,
  renderVoiceLines,
  spanOf,
  styleNarration,
  toEntry,
  type NarrationCache,
  type NarrationEntry,
  type VoiceLine as MediaVoiceLine,
} from "@after-genesis/media";
import { GeminiProvider } from "@after-genesis/cognition";
import { buildChronicle } from "../src/lib/cinema/chronicle.ts";
import { speakerLookupFor } from "../src/lib/cinema/speakers.ts";
import { selectVoiceLines } from "../src/lib/cinema/voice-lines.ts";
import observatoryRun from "../src/fixtures/pre-genesis-run.json" with { type: "json" };
import type { ObservatoryRun } from "../src/lib/observatory-types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(APP_ROOT, "../..");

/** ElevenLabs bills per character. Used only for the dry-run estimate. */
const USD_PER_1K_CHARS = 0.3;

function arg(name: string, fallback: string): string {
  const match = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return match === undefined ? fallback : match.slice(name.length + 3);
}

const dryRun = process.argv.includes("--dry-run");
const reel = arg("reel", "all");
const limit = Number.parseInt(arg("limit", "0"), 10) || Number.POSITIVE_INFINITY;

/**
 * `--plain` speaks the canonical captions verbatim, with no model in the loop.
 *
 * Kept as a first-class option rather than a debug flag: it is the only mode
 * in which every spoken word is a canonical fact, and it is the correct mode
 * for an audit recording.
 */
const plain = process.argv.includes("--plain");
const live = process.argv.includes("--live");
const input = arg("input", "");

/**
 * Load `.env` without a dependency.
 *
 * Deliberately explicit about duplicate keys: a repeated key is the exact
 * mistake that made twenty-one configured voices invisible, and a loader that
 * silently keeps the last one is how it went unnoticed.
 */
async function loadEnv(): Promise<Record<string, string | undefined>> {
  const path = join(REPO_ROOT, ".env");
  if (!existsSync(path)) return { ...process.env };

  const env: Record<string, string> = {};
  const duplicates = new Set<string>();

  for (const rawLine of (await readFile(path, "utf8")).split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals === -1) continue;

    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1).trim().replace(/^["']|["']$/g, "");
    if (key in env) duplicates.add(key);
    env[key] = value;
  }

  if (duplicates.size > 0) {
    throw new Error(
      `.env assigns these keys more than once: ${[...duplicates].join(", ")}. ` +
        `Only the last assignment of a key survives, so the earlier values are silently ignored. ` +
        `Use one key per value and comma-separate pools.`,
    );
  }

  return { ...process.env, ...env };
}

/**
 * The Gemini binding used to dramatise captions, or null when unavailable.
 *
 * §3 routes routine cognition to the cheapest model; narration styling is as
 * routine as work gets, so it uses `AG_MODEL_ROUTINE`. A missing key is not an
 * error: the render simply speaks canonical captions, which is always correct.
 */
function narrationStyler(env: Readonly<Record<string, string | undefined>>) {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    console.log("  GEMINI_API_KEY is not set — speaking canonical captions verbatim");
    return null;
  }
  const provider = new GeminiProvider({ apiKey });
  const modelId = env.AG_MODEL_ROUTINE?.trim() || "gemini-3.6-flash";
  return { modelId, generate: (request: Parameters<typeof provider.generate>[0]) => provider.generate(request) };
}

async function loadNarrationCache(path: string): Promise<NarrationCache> {
  if (!existsSync(path)) return EMPTY_NARRATION_CACHE;
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    // A cache written under different rules is discarded rather than trusted:
    // raising NARRATION_STYLE_VERSION must actually re-check every line.
    return isCurrentCache(parsed) ? parsed : EMPTY_NARRATION_CACHE;
  } catch {
    return EMPTY_NARRATION_CACHE;
  }
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

interface Reel {
  readonly name: string;
  readonly run: ObservatoryRun;
}

/**
 * The reels this renderer can produce.
 *
 * One reel, rendered from the world the app is currently showing. A second
 * reel once existed, built from a retained demo run; it was removed with that
 * run, because audio derived from a previous world is not this world's voice.
 */
async function reels(): Promise<readonly Reel[]> {
  let run = observatoryRun as unknown as ObservatoryRun;
  const requestedInput =
    input.length > 0
      ? resolve(REPO_ROOT, input)
      : live
        ? join(APP_ROOT, ".dev-world", "observatory-run.json")
        : null;
  if (requestedInput !== null) {
    if (!existsSync(requestedInput)) {
      throw new Error(
        `voice reel input does not exist at ${requestedInput}; run the dev controller export first`,
      );
    }
    run = JSON.parse(await readFile(requestedInput, "utf8")) as ObservatoryRun;
  }
  const all: Reel[] = [{ name: "month", run }];
  return reel === "all" ? all : all.filter((entry) => entry.name === reel);
}

async function main(): Promise<void> {
  const env = await loadEnv();
  const registry = buildVoiceRegistry(env);

  for (const { name, run } of await reels()) {
    const chronicle = buildChronicle(run);
    const lookup = speakerLookupFor(run);
    const selectedBase = selectVoiceLines(chronicle, lookup);
    const selected = live
      ? [...selectedBase].sort((left, right) => {
          const leftPriority = left.kind === "dialogue" ? 0 : 1;
          const rightPriority = right.kind === "dialogue" ? 0 : 1;
          return leftPriority - rightPriority || left.segmentId.localeCompare(right.segmentId);
        })
      : selectedBase;

    const outputRoot = join(APP_ROOT, "public", "voice", name);
    const cachePath = join(outputRoot, "narration.json");
    const styler = plain ? null : narrationStyler(env);

    // Dialogue is never styled. It is what an inhabitant actually said; a
    // model rewriting it would be putting words in its mouth (§21 keeps
    // verbatim dialogue and dramatised narration strictly apart).
    const cache = await loadNarrationCache(cachePath);
    const entries: Record<string, NarrationEntry> = { ...cache.entries };
    let stylingCalls = 0;
    let stylingRefusals = 0;

    const lines: MediaVoiceLine[] = [];
    for (const line of selected) {
      if (line.kind === "dialogue" || styler === null || dryRun) {
        lines.push({
          segmentId: line.segmentId,
          kind: line.kind,
          text: line.text,
          canonicalText: line.text,
          styled: false,
          styleModelId: null,
          speaker: line.speaker,
        });
        continue;
      }

      const context = {
        canonical: line.text,
        actionType: line.actionType,
        allowedNames: line.allowedNames,
        // Canonical time and duration, in words. Without them the model has
        // only the caption to work from and returns telegram prose.
        dayPart: dayPartOf(line.minuteOfDay),
        span: spanOf(line.minutes),
      };
      const key = narrationKey({ ...context, modelId: styler.modelId });

      let entry = entries[key];
      if (entry === undefined) {
        const result = await styleNarration(context, styler);
        entry = toEntry(result);
        entries[key] = entry;
        stylingCalls += 1;
        if (!entry.styled) {
          stylingRefusals += 1;
          console.log(`  style refused ${line.segmentId}: ${entry.rejections.join(" | ")}`);
        }
      }

      lines.push({
        segmentId: line.segmentId,
        kind: line.kind,
        text: entry.spoken,
        canonicalText: entry.canonical,
        styled: entry.styled,
        styleModelId: entry.modelId,
        speaker: line.speaker,
      });
    }

    if (styler !== null && !dryRun && stylingCalls > 0) {
      const next: NarrationCache = { ...EMPTY_NARRATION_CACHE, entries };
      await mkdir(outputRoot, { recursive: true });
      await writeJsonAtomically(cachePath, next);
      console.log(
        `[${name}] styled ${stylingCalls} new line(s), ${stylingRefusals} fell back to the canonical caption`,
      );
    }

    const characters = lines.reduce((total, line) => total + line.text.length, 0);
    const dialogue = lines.filter((line) => line.kind === "dialogue").length;

    console.log(
      `\n[${name}] ${lines.length} lines (${dialogue} dialogue, ${lines.length - dialogue} narration), ` +
        `${characters.toLocaleString()} characters, ` +
        `~$${((characters / 1000) * USD_PER_1K_CHARS).toFixed(2)} at list price before caching`,
    );

    if (dryRun) {
      for (const line of lines.slice(0, 10)) {
        console.log(`  ${line.kind.padEnd(9)} ${line.segmentId}  ${line.text.slice(0, 78)}`);
      }
      if (lines.length > 10) console.log(`  … and ${lines.length - 10} more`);
      continue;
    }

    await mkdir(join(outputRoot, "clips"), { recursive: true });

    const client = new ElevenLabsClient({ apiKey: env.ELEVENLABS_API_KEY ?? "" });
    const report = await renderVoiceLines(lines, {
      worldId: run.world.id,
      registry,
      client,
      maxNewClips: limit,
      writeAudio: async (relativePath, audio) => {
        await writeFile(join(outputRoot, relativePath), audio);
      },
      audioExists: async (relativePath) => existsSync(join(outputRoot, relativePath)),
      onProgress: (message) => console.log(`  ${message}`),
    });

    await writeJsonAtomically(join(outputRoot, "manifest.json"), report.manifest);

    console.log(
      `[${name}] synthesized ${report.synthesized}, reused ${report.reused}, failed ${report.failed}, ` +
        `${(report.bytesWritten / 1024).toFixed(0)} KiB written → public/voice/${name}/`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
