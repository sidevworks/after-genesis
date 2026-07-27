import type { ReactNode } from "react";

export function Panel({
  title,
  eyebrow,
  aside,
  children,
  className = "",
  id,
}: {
  title?: ReactNode;
  eyebrow?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={`panel ${className}`}>
      {(title || eyebrow || aside) && (
        <header className="panel-head">
          <div className="min-w-0">
            {eyebrow && <p className="eyebrow">{eyebrow}</p>}
            {title && (
              <h2 className="text-[0.95rem] font-medium tracking-tight text-ink">
                {title}
              </h2>
            )}
          </div>
          {aside && <div className="shrink-0 text-xs text-dim">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "default" | "amber" | "alive" | "warn";
}) {
  const toneClass =
    tone === "amber"
      ? "text-amber"
      : tone === "alive"
        ? "text-alive"
        : tone === "warn"
          ? "text-warn"
          : "text-ink";
  return (
    <div className="px-4 py-3">
      <p className="eyebrow">{label}</p>
      <p className={`mono mt-1 text-xl leading-none ${toneClass}`}>{value}</p>
      {sub && <p className="mt-1.5 text-xs text-dim">{sub}</p>}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "amber" | "claim" | "alive" | "gone" | "warn";
  title?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "border-line text-muted",
    amber: "border-amber-dim text-amber",
    claim: "border-claim-dim text-claim",
    alive: "border-alive/40 text-alive",
    gone: "border-line text-gone",
    warn: "border-warn/40 text-warn",
  };
  return (
    <span
      title={title}
      className={`mono inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[0.65rem] uppercase tracking-wider ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/** A labelled bar. Reads a value; it cannot set one. */
export function Meter({
  label,
  value,
  colour = "var(--color-amber)",
  display,
}: {
  label: string;
  value: number;
  colour?: string;
  display?: string;
}) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted">{label}</span>
        <span className="mono text-xs text-dim">{display ?? `${pct}%`}</span>
      </div>
      <div
        className="mt-1 h-1 w-full overflow-hidden rounded-full bg-line"
        role="meter"
        aria-label={label}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: colour }} />
      </div>
    </div>
  );
}

export function KeyValue({
  rows,
}: {
  rows: Array<{ key: string; value: ReactNode; mono?: boolean }>;
}) {
  return (
    <dl className="divide-y divide-line-soft">
      {rows.map((row) => (
        <div key={row.key} className="grid grid-cols-1 gap-1 px-4 py-2.5 sm:grid-cols-[11rem_1fr] sm:gap-4">
          <dt className="eyebrow pt-0.5">{row.key}</dt>
          <dd className={`min-w-0 text-sm break-words ${row.mono ? "mono text-muted" : "text-ink"}`}>
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-sm text-dim">{children}</p>;
}

export function PageHeader({
  eyebrow,
  title,
  lede,
  aside,
}: {
  eyebrow: string;
  title: string;
  lede?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-4 border-b border-line pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="max-w-2xl">
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="mt-1.5 text-2xl font-medium tracking-tight text-ink sm:text-3xl">
          {title}
        </h1>
        {lede && <p className="mt-2.5 text-sm leading-relaxed text-muted">{lede}</p>}
      </div>
      {aside && <div className="shrink-0">{aside}</div>}
    </header>
  );
}
