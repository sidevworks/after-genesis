#!/usr/bin/env node
// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * Read-only per-run statistics for a folder of recorded After Genesis runs.
 *
 *   node tools/summarise-runs.mjs <runs-root> [--verification verification.json]
 *        [--json out.json] [--md out.md]
 *
 * Each run is <runs-root>/<run>/events/*.jsonl (+ model-audit/, audit-report.json).
 * No dependencies; nothing is written into the runs. simTime is in minutes
 * (1440 = one in-world day, 525,600 = one in-world year).
 *
 * "Accepted" means the engine resolved the proposal (outcome status != rejected).
 * Births = accepted create_inhabitant. Cognition is read from each event's
 * provenance.modelId and the genesis founder modelId; "offline-instinct-*" is the
 * built-in rule-based stand-in, not an LLM.
 */
import { readdirSync, readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const root = args[0];
if (!root) {
  console.error("usage: summarise-runs.mjs <runs-root> [--verification f] [--json f] [--md f]");
  process.exit(2);
}
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const verification = opt("--verification") ? JSON.parse(readFileSync(opt("--verification"), "utf8")) : [];

const DAY = 1440;
const runs = [];
for (const run of readdirSync(root).sort()) {
  const dir = join(root, run);
  if (!statSync(dir).isDirectory() || !existsSync(join(dir, "events"))) continue;
  for (const f of readdirSync(join(dir, "events")).filter((n) => n.endsWith(".jsonl"))) {
    const events = readFileSync(join(dir, "events", f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const g = events.find((e) => e.type === "genesis");
    const gi = g?.inputs?.genesis ?? {};
    const founders = [gi.founder, ...(gi.inhabitants ?? [])].filter(Boolean);
    const founderModels = [...new Set(founders.map((x) => x.modelId).filter(Boolean))];
    const eventModels = {};
    const byType = {};
    let maxSim = 0;
    const actors = new Set();
    let accepted = 0, rejected = 0, lastAcceptedSim = 0;
    const rejectionCodes = {};
    for (const e of events) {
      const o = e.resolution?.outcome;
      if (o && e.type !== "genesis") {
        if (o.status === "rejected") { rejected++; rejectionCodes[o.code] = (rejectionCodes[o.code] ?? 0) + 1; }
        else { accepted++; lastAcceptedSim = Math.max(lastAcceptedSim, e.simTime ?? 0); }
      }
      maxSim = Math.max(maxSim, e.simTime ?? 0);
      if (e.actor) actors.add(e.actor);
      const m = e.provenance?.modelId;
      if (m) eventModels[m] = (eventModels[m] ?? 0) + 1;
      const t = e.type.replace(/^action\./, "");
      const status = e.resolution?.outcome?.status;
      byType[t] ??= { total: 0, accepted: 0, rejected: 0 };
      byType[t].total++;
      if (status === "rejected") byType[t].rejected++;
      else byType[t].accepted++;
    }
    const acc = (t) => byType[t]?.accepted ?? 0;
    // Model audit: tokens and cost as recorded by the runtime's price table.
    let calls = 0, inTok = 0, outTok = 0, costMicros = 0;
    const auditDir = join(dir, "model-audit");
    if (existsSync(auditDir)) {
      const walk = (p) => {
        for (const n of readdirSync(p)) {
          const q = join(p, n);
          if (statSync(q).isDirectory()) walk(q);
          else if (n.endsWith(".json")) {
            try {
              const a = JSON.parse(readFileSync(q, "utf8"));
              calls++;
              inTok += a.response?.inputTokens ?? 0;
              outTok += a.response?.outputTokens ?? 0;
              costMicros += a.costMicros ?? 0;
            } catch { /* skip unreadable */ }
          }
        }
      };
      walk(auditDir);
    }
    const llm = Object.keys(eventModels).some((m) => !m.startsWith("offline")) || calls > 0;
    const llmConfiguredNoCalls = !llm && founderModels.some((m) => !m.startsWith("offline"));
    // Final state snapshot (if present): population by status.
    let finalPopulation = null;
    const stateDir = join(dir, "state");
    if (existsSync(stateDir)) {
      const sf = readdirSync(stateDir).find((n) => n.endsWith(".json"));
      if (sf) {
        const st = JSON.parse(readFileSync(join(stateDir, sf), "utf8"));
        const inh = Object.values((st.state ?? st).inhabitants ?? {});
        finalPopulation = { total: inh.length, alive: inh.filter((i) => i.status !== "dead").length };
      }
    }
    const days = maxSim / DAY;
    const v = verification.find((x) => x.run === run && (!x.file || x.file === f));
    let report = null;
    if (existsSync(join(dir, "audit-report.json"))) {
      const r = JSON.parse(readFileSync(join(dir, "audit-report.json"), "utf8"));
      report = { chainOk: r.verification?.ok ?? null, replayOk: r.replay?.ok ?? null };
    }
    runs.push({
      run,
      founders: founders.length,
      founderNames: founders.map((x) => x.displayName),
      cognition: llm ? "LLM" : llmConfiguredNoCalls ? "LLM configured, no call recorded" : "offline-instinct",
      finalPopulation,
      models: Object.keys(eventModels).length ? eventModels : Object.fromEntries(founderModels.map((m) => [m, 0])),
      events: events.length,
      acceptedActions: accepted,
      rejectedActions: rejected,
      rejectionCodes,
      lastAcceptedDay: Math.round((lastAcceptedSim / DAY) * 10) / 10,
      inWorldDays: Math.round(days * 10) / 10,
      actors: actors.size,
      births: acc("create_inhabitant"),
      birthAttempts: byType.create_inhabitant?.total ?? 0,
      artifacts: acc("create_artifact"),
      builds: acc("build"),
      communications: acc("communicate") + acc("announce"),
      byType,
      modelCalls: calls,
      inputTokens: inTok,
      outputTokens: outTok,
      recordedCostUsd: costMicros / 1e6,
      perInWorldDay: days > 0 && calls > 0
        ? { calls: calls / days, inputTokens: inTok / days, outputTokens: outTok / days, costUsd: costMicros / 1e6 / days }
        : null,
      chainVerifiedNow: v ? v.chainOk : null,
      replayWithCurrentEngine: v ? (v.replay?.ok ?? v.replayWithEngineAtHEAD ?? false) : null,
      replayReproducedAtCommit: v?.replayReproducedAtCommit ?? null,
      contemporaneousAuditReport: report,
    });
  }
}

if (opt("--json")) writeFileSync(opt("--json"), JSON.stringify(runs, null, 2) + "\n");
const lines = [
  "| Run | Cognition (model) | Founders | Alive at end | In-world days | Last accepted action (day) | Events (accepted/rejected) | Births (accepted/attempts) | Artifacts | Builds | Messages | Model calls | Recorded cost USD | Chain OK |",
  "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
];
for (const r of runs) {
  const models = Object.keys(r.models).join(", ");
  lines.push(`| ${r.run} | ${r.cognition} (${models}) | ${r.founders} | ${r.finalPopulation ? r.finalPopulation.alive : "n/a"} | ${r.inWorldDays} | ${r.lastAcceptedDay} | ${r.events} (${r.acceptedActions}/${r.rejectedActions}) | ${r.births}/${r.birthAttempts} | ${r.artifacts} | ${r.builds} | ${r.communications} | ${r.modelCalls} | ${r.recordedCostUsd.toFixed(3)} | ${r.chainVerifiedNow ?? "n/a"} |`);
}
const md = lines.join("\n") + "\n";
if (opt("--md")) writeFileSync(opt("--md"), md);
process.stdout.write(md);
