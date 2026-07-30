"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type DevStatus = {
  running: boolean;
  provider: "gemini" | "offline";
  model: GeminiModel;
  deliberateModel: GeminiModel;
  voice: {
    enabled: boolean;
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
  progress: {
    completedTurns: number;
    targetTurns: number;
    percent: number;
    simTime: number;
  } | null;
};

type GeminiModel = "gemini-3.5-flash-lite" | "gemini-3.6-flash";
type ProviderMode = "gemini" | "offline";

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
  const [providerMode, setProviderMode] = useState<ProviderMode>("gemini");
  const [fastModel, setFastModel] = useState<GeminiModel>("gemini-3.6-flash");
  const [deepModel, setDeepModel] = useState<GeminiModel>("gemini-3.6-flash");
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const liveRefreshRef = useRef(false);
  const lastChainHeadRef = useRef<string | null>(null);
  const cognitionInitializedRef = useRef(false);

  const provider = providerMode === "offline" ? "offline" : "gemini";

  function modeFromStatus(body: DevStatus): ProviderMode {
    if (body.provider === "offline") return "offline";
    return "gemini";
  }

  async function refresh() {
    try {
      const response = await fetch(`${CONTROL_URL}/status`, { cache: "no-store" });
      if (!response.ok) throw new Error(`controller returned ${response.status}`);
      const body = (await response.json()) as DevStatus;
      setStatus(body);
      if (!cognitionInitializedRef.current) {
        cognitionInitializedRef.current = true;
        setProviderMode(modeFromStatus(body));
        setVoiceEnabled(body.voice.enabled ?? false);
        setFastModel(body.model);
        setDeepModel(body.deliberateModel ?? body.model);
      } else if (!status?.running) {
        setFastModel(body.model);
        setDeepModel(body.deliberateModel ?? body.model);
      }
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
      setProviderMode(modeFromStatus(body));
      setFastModel(body.model);
      setDeepModel(body.deliberateModel ?? body.model);
      setVoiceEnabled(body.voice.enabled ?? voiceEnabled);
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
      `/advance?days=${safeDays}&speed=${encodeURIComponent(speed)}&provider=${provider}&model=${fastModel}&deliberateModel=${deepModel}&voice=${voiceEnabled ? "on" : "off"}`,
    );
  }

  function fastForward(daysToRun: number) {
    void post(
      `/fast-forward?days=${daysToRun}&provider=${provider}&model=${fastModel}&deliberateModel=${deepModel}&voice=${voiceEnabled ? "on" : "off"}`,
    );
  }

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), status?.running ? 800 : 2500);
    return () => window.clearInterval(timer);
  }, [enabled, router, status?.running]);

  if (!enabled) return null;
  const worldUnavailable = status?.summary == null;
  const progress = status?.progress ?? null;

  return (
    <section className="border-b border-line bg-panel/65 px-4 py-2 sm:px-6">
      <div className="mx-auto flex max-w-[96rem] flex-wrap items-center gap-2 text-xs">
        <span className="eyebrow mr-2 text-amber">Dev world clock</span>
        <select
          value={providerMode}
          disabled={status?.running}
          onChange={(event) => setProviderMode(event.currentTarget.value as ProviderMode)}
          className="rounded border border-line bg-panel-2 px-2 py-1 text-muted disabled:opacity-45"
          aria-label="Cognition provider"
        >
          <option value="gemini">Gemini</option>
          <option value="offline">No AI · engine-only test</option>
        </select>
        {providerMode === "gemini" && (
          <>
            <label className="mono flex items-center gap-1.5 rounded border border-line px-2 py-1 text-muted">
              Fast model
              <select
                value={fastModel}
                disabled={status?.running}
                onChange={(event) => {
                  const next = event.currentTarget.value as GeminiModel;
                  setFastModel(next);
                  if (next === "gemini-3.6-flash") {
                    setDeepModel(next);
                  }
                }}
                className="rounded border border-line bg-panel-2 px-2 py-1 text-muted disabled:opacity-45"
                aria-label="Fast model"
              >
                <option value="gemini-3.5-flash-lite">Gemini 3.5 Flash Lite</option>
                <option value="gemini-3.6-flash">Gemini 3.6 Flash</option>
              </select>
            </label>
            <label className="mono flex items-center gap-1.5 rounded border border-line px-2 py-1 text-muted">
              Deep model
              <select
                value={deepModel}
                disabled={status?.running}
                onChange={(event) => setDeepModel(event.currentTarget.value as GeminiModel)}
                className="rounded border border-line bg-panel-2 px-2 py-1 text-muted disabled:opacity-45"
                aria-label="Deep model"
              >
                <option value="gemini-3.5-flash-lite">Gemini 3.5 Flash Lite</option>
                <option value="gemini-3.6-flash">Gemini 3.6 Flash</option>
              </select>
            </label>
          </>
        )}
        <label className="mono flex items-center gap-1.5 rounded border border-line px-2 py-1 text-muted">
          <input
            type="checkbox"
            checked={voiceEnabled}
            disabled={status?.running}
            onChange={(event) => {
              setVoiceEnabled(event.currentTarget.checked);
              if (event.currentTarget.checked) setSpeed("instant");
            }}
          />
          Voice
        </label>
        <button
          type="button"
          disabled={status?.running}
          onClick={() =>
            void post(
              `/reset?provider=${provider}&model=${fastModel}&deliberateModel=${deepModel}&voice=${voiceEnabled ? "on" : "off"}`,
            )
          }
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
            void post(
              `/advance?days=1&speed=realtime&provider=${provider}&model=${fastModel}&deliberateModel=${deepModel}&voice=${voiceEnabled ? "on" : "off"}`,
            )
          }
          className="rounded border border-line px-2.5 py-1 text-muted hover:border-amber-dim hover:text-amber disabled:opacity-45"
        >
          24h in 1h
        </button>
        <button
          type="button"
          disabled={status?.running || worldUnavailable}
          onClick={() =>
            void post(
              `/advance?days=1&speed=fast&provider=${provider}&model=${fastModel}&deliberateModel=${deepModel}&voice=${voiceEnabled ? "on" : "off"}`,
            )
          }
          className="rounded border border-line px-2.5 py-1 text-muted hover:border-amber-dim hover:text-amber disabled:opacity-45"
        >
          24h in 10m
        </button>
        <button
          type="button"
          disabled={status?.running || worldUnavailable}
          onClick={() =>
            void post(
              `/advance?days=1&speed=max&provider=${provider}&model=${fastModel}&deliberateModel=${deepModel}&voice=${voiceEnabled ? "on" : "off"}`,
            )
          }
          className="rounded border border-amber-dim bg-amber/10 px-2.5 py-1 text-amber hover:bg-amber/20 disabled:opacity-45"
        >
          24h in 1m
        </button>
        <button
          type="button"
          disabled={status?.running || worldUnavailable}
          onClick={() =>
            void post(
              `/advance?days=1&speed=turbo&provider=${provider}&model=${fastModel}&deliberateModel=${deepModel}&voice=${voiceEnabled ? "on" : "off"}`,
            )
          }
          className="rounded border border-line px-2.5 py-1 text-muted hover:border-amber-dim hover:text-amber disabled:opacity-45"
        >
          24h in 10s
        </button>
        <button
          type="button"
          disabled={status?.running || worldUnavailable}
          onClick={() =>
            void post(
              `/advance?days=1&speed=instant&provider=${provider}&model=${fastModel}&deliberateModel=${deepModel}&voice=${voiceEnabled ? "on" : "off"}`,
            )
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
        <span className="eyebrow text-dim">
          Fast-forward · {provider === "gemini" ? "Gemini" : "no AI"} · fast {fastModel} · deep {deepModel}
        </span>
        {[1, 10, 25, 50, 100].map((daysToRun) => (
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
          {progress !== null
            ? `${status?.running ? "running" : progress.percent === 100 ? "complete" : "stopped"} · ${progress.completedTurns}/${progress.targetTurns} turns · ${progress.percent}% · ${dayOf(
                progress.simTime,
              )}`
            : status?.running
              ? latestLine(status.lastOutput) ?? "processing..."
              : status?.summary
                ? `${dayOf(status.summary.simTime)} · ${status.summary.eventCount} events · pop ${status.summary.living}/${status.summary.total}`
                : status
                  ? "controller online · awaiting Genesis"
                  : "controller offline"}
        </span>
        <div className="flex w-full items-center gap-2">
          <span className="mono shrink-0 text-[10px] uppercase tracking-wider text-dim">
            Progress
          </span>
          <div
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-line"
            role="progressbar"
            aria-label="Simulation progress"
            aria-valuemin={0}
            aria-valuemax={progress?.targetTurns ?? 100}
            aria-valuenow={progress?.completedTurns ?? 0}
          >
            <div
              className="h-full bg-amber transition-[width] duration-500"
              style={{ width: `${progress?.percent ?? 0}%` }}
            />
          </div>
          <span className="mono w-24 text-right text-[10px] text-dim">
            {progress === null ? "not running" : `${progress.percent}%`}
          </span>
        </div>
        {provider === "offline" && (
          <span className="text-warn">No autonomous reasoning in this mode</span>
        )}
        {provider === "gemini" && (
          <span className="text-dim">
            Live-clock speed is a target; sequential AI response time can make it slower
          </span>
        )}
        {status?.voice.state === "rendering" && (
          <span className="text-amber">Rendering voice…</span>
        )}
        {status?.voice.enabled && status.voice.state === "stale" && (
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
