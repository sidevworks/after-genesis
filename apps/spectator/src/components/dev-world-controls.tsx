"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type DevStatus = {
  running: boolean;
  provider: "gemini" | "offline";
  voice: {
    state: "idle" | "stale" | "rendering" | "ready" | "error";
    lastPublishedAt: string | null;
    error: string | null;
  };
  lastCommand: string | null;
  lastExitCode: number | null;
  lastOutput: string;
  lastError: string | null;
  summary: {
    simTime: number;
    eventCount: number;
    living: number;
    total: number;
    chainHead: string;
  } | null;
};

const CONTROL_URL = process.env.NEXT_PUBLIC_DEV_WORLD_CONTROL_URL ?? "http://127.0.0.1:8787";

function dayOf(simTime: number): string {
  const day = Math.floor(simTime / 1440);
  const minutes = simTime % 1440;
  const hour = Math.floor(minutes / 60);
  return `Day ${day} ${String(hour).padStart(2, "0")}:00`;
}

function latestLine(output: string): string | null {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? null;
}

export function DevWorldControls() {
  const router = useRouter();
  const enabled = process.env.NEXT_PUBLIC_DEV_WORLD_CONTROLS === "true";
  const [status, setStatus] = useState<DevStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState("1");
  const [speed, setSpeed] = useState("instant");
  const [provider, setProvider] = useState<"gemini" | "offline">("offline");
  const liveRefreshRef = useRef(false);
  const lastChainHeadRef = useRef<string | null>(null);

  async function refresh() {
    try {
      const response = await fetch(`${CONTROL_URL}/status`, { cache: "no-store" });
      if (!response.ok) throw new Error(`controller returned ${response.status}`);
      const body = (await response.json()) as DevStatus;
      setStatus(body);
      setProvider(body.provider);
      setError(null);
      const chainHead = body.summary?.chainHead ?? null;
      if (liveRefreshRef.current && chainHead !== null && chainHead !== lastChainHeadRef.current) {
        lastChainHeadRef.current = chainHead;
        router.refresh();
      }
      if (liveRefreshRef.current && !body.running && body.lastExitCode === 0) {
        liveRefreshRef.current = false;
        router.refresh();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function post(path: string) {
    setError(null);
    try {
      const response = await fetch(`${CONTROL_URL}${path}`, { method: "POST" });
      const body = (await response.json()) as DevStatus & { error?: string };
      setStatus(body);
      setProvider(body.provider);
      if (!response.ok) throw new Error(body.error ?? `controller returned ${response.status}`);
      liveRefreshRef.current = true;
      lastChainHeadRef.current = body.summary?.chainHead ?? null;
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function runCustom() {
    const value = Number(days);
    const safeDays = Number.isSafeInteger(value) && value >= 1 ? Math.min(value, 365_000) : 1;
    void post(
      `/advance?days=${safeDays}&speed=${encodeURIComponent(speed)}&provider=${provider}`,
    );
  }

  function fastForward(daysToRun: number) {
    void post(`/fast-forward?days=${daysToRun}&provider=offline`);
  }

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), status?.running ? 800 : 2500);
    return () => window.clearInterval(timer);
  }, [enabled, router, status?.running]);

  if (!enabled) return null;
  const worldUnavailable = status?.summary == null;

  return (
    <section className="border-b border-line bg-panel/65 px-4 py-2 sm:px-6">
      <div className="mx-auto flex max-w-[96rem] flex-wrap items-center gap-2 text-xs">
        <span className="eyebrow mr-2 text-amber">Dev world clock</span>
        <select
          value={provider}
          disabled={status?.running}
          onChange={(event) =>
            setProvider(event.currentTarget.value as "gemini" | "offline")
          }
          className="rounded border border-line bg-panel-2 px-2 py-1 text-muted disabled:opacity-45"
          aria-label="Cognition provider"
        >
          <option value="gemini">AI cognition · Gemini</option>
          <option value="offline">Mechanical engine test · no AI</option>
        </select>
        <button
          type="button"
          disabled={status?.running}
          onClick={() => void post(`/reset?provider=${provider}`)}
          className="rounded border border-line px-2.5 py-1 text-muted hover:border-amber-dim hover:text-amber disabled:opacity-45"
        >
          Reset Day 0
        </button>
        <button
          type="button"
          disabled={!status?.running}
          onClick={() => void post("/stop")}
          className="rounded border border-warn/50 px-2.5 py-1 text-warn hover:bg-warn/10 disabled:opacity-45"
        >
          Stop
        </button>
        <button
          type="button"
          disabled={status?.running || worldUnavailable}
          onClick={() =>
            void post(`/advance?days=1&speed=realtime&provider=${provider}`)
          }
          className="rounded border border-line px-2.5 py-1 text-muted hover:border-amber-dim hover:text-amber disabled:opacity-45"
        >
          24h in 1h
        </button>
        <button
          type="button"
          disabled={status?.running || worldUnavailable}
          onClick={() => void post(`/advance?days=1&speed=fast&provider=${provider}`)}
          className="rounded border border-line px-2.5 py-1 text-muted hover:border-amber-dim hover:text-amber disabled:opacity-45"
        >
          24h in 10m
        </button>
        <button
          type="button"
          disabled={status?.running || worldUnavailable}
          onClick={() => void post(`/advance?days=1&speed=max&provider=${provider}`)}
          className="rounded border border-amber-dim bg-amber/10 px-2.5 py-1 text-amber hover:bg-amber/20 disabled:opacity-45"
        >
          24h in 1m
        </button>
        <button
          type="button"
          disabled={status?.running || worldUnavailable}
          onClick={() => void post(`/advance?days=1&speed=turbo&provider=${provider}`)}
          className="rounded border border-line px-2.5 py-1 text-muted hover:border-amber-dim hover:text-amber disabled:opacity-45"
        >
          24h in 10s
        </button>
        <button
          type="button"
          disabled={status?.running || worldUnavailable}
          onClick={() =>
            void post(`/advance?days=1&speed=instant&provider=${provider}`)
          }
          className="rounded border border-line px-2.5 py-1 text-muted hover:border-amber-dim hover:text-amber disabled:opacity-45"
        >
          24h in 1s
        </button>
        <label className="mono flex items-center gap-1 text-dim">
          Run
          <input
            type="number"
            min={1}
            max={365000}
            value={days}
            disabled={status?.running || worldUnavailable}
            onChange={(event) => setDays(event.currentTarget.value)}
            className="w-20 rounded border border-line bg-panel-2 px-2 py-1 text-ink disabled:opacity-45"
          />
          days
        </label>
        <select
          value={speed}
          disabled={status?.running || worldUnavailable}
          onChange={(event) => setSpeed(event.currentTarget.value)}
          className="rounded border border-line bg-panel-2 px-2 py-1 text-muted disabled:opacity-45"
        >
          <option value="realtime">24h in 1h</option>
          <option value="fast">24h in 10m</option>
          <option value="max">24h in 1m</option>
          <option value="turbo">24h in 10s</option>
          <option value="instant">24h in 1s</option>
        </select>
        <button
          type="button"
          disabled={status?.running || worldUnavailable}
          onClick={runCustom}
          className="rounded border border-amber-dim bg-amber/10 px-2.5 py-1 text-amber hover:bg-amber/20 disabled:opacity-45"
        >
          Run live
        </button>
        <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
        <span className="eyebrow text-dim">Fast-forward · offline</span>
        {[1, 10, 100].map((daysToRun) => (
          <button
            key={daysToRun}
            type="button"
            disabled={status?.running || worldUnavailable}
            onClick={() => fastForward(daysToRun)}
            className="rounded border border-line px-2.5 py-1 text-muted hover:border-amber-dim hover:text-amber disabled:opacity-45"
          >
            {daysToRun}d
          </button>
        ))}
        <span className="mono ml-auto text-dim">
          {status?.running
            ? latestLine(status.lastOutput) ?? "processing..."
            : status?.summary
              ? `${dayOf(status.summary.simTime)} · ${status.summary.eventCount} events · pop ${status.summary.living}/${status.summary.total}`
              : status
                ? "controller online · awaiting Genesis"
                : "controller offline"}
        </span>
        {provider === "offline" && (
          <span className="text-warn">No autonomous reasoning in this mode</span>
        )}
        {status?.voice.state === "rendering" && (
          <span className="text-amber">Rendering voice…</span>
        )}
        {status?.voice.state === "stale" && (
          <button
            type="button"
            disabled={status.running}
            onClick={() => void post("/voice/retry")}
            className="rounded border border-amber-dim px-2.5 py-1 text-amber hover:bg-amber/10 disabled:opacity-45"
          >
            Render pending voice
          </button>
        )}
        {status?.voice.state === "error" && (
          <>
            <span className="text-warn">Voice failed: {status.voice.error}</span>
            <button
              type="button"
              disabled={status.running}
              onClick={() => void post("/voice/retry")}
              className="rounded border border-warn/50 px-2.5 py-1 text-warn hover:bg-warn/10 disabled:opacity-45"
            >
              Retry voice
            </button>
          </>
        )}
        {(error ?? status?.lastError) && (
          <span className="text-warn">{error ?? status?.lastError}</span>
        )}
      </div>
    </section>
  );
}
