import Link from "next/link";

export default function NotFound() {
  return (
    <div className="py-16">
      <p className="eyebrow">404</p>
      <h1 className="mt-2 text-2xl font-medium tracking-tight">No such record</h1>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
        Nothing in the world has this identifier. If you were looking for an inhabitant, note that
        deceased inhabitants are never removed — a missing profile means the inhabitant was never
        created, not that it was deleted.
      </p>
      <nav className="mt-5 flex flex-wrap gap-4 text-sm">
        <Link href="/overview" className="text-amber hover:underline">
          Overview
        </Link>
        <Link href="/inhabitants" className="text-amber hover:underline">
          All inhabitants
        </Link>
        <Link href="/events" className="text-amber hover:underline">
          Canonical event log
        </Link>
      </nav>
    </div>
  );
}
