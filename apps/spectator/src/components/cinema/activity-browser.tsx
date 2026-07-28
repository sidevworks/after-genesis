"use client";

import { useId, useMemo, useState } from "react";
import { MINUTES_PER_DAY } from "@/lib/cinema/types";
import type { ChannelActivity, ChannelSubject } from "./cinema-channel";

const ALL = "all";

function dayOf(tick: number) {
  return Math.floor(tick / MINUTES_PER_DAY) + 1;
}

function titleCase(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function ActivityBrowser({
  activities,
  subjects,
  onSelect,
}: {
  readonly activities: readonly ChannelActivity[];
  readonly subjects: readonly ChannelSubject[];
  readonly onSelect: (activity: ChannelActivity) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [day, setDay] = useState(ALL);
  const [type, setType] = useState(ALL);
  const [actor, setActor] = useState(ALL);
  const [conversationsOnly, setConversationsOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const names = useMemo(
    () => new Map(subjects.map((subject) => [subject.id, subject.displayName])),
    [subjects],
  );
  const days = useMemo(
    () => [...new Set(activities.map((activity) => dayOf(activity.startedAt)))].sort((a, b) => a - b),
    [activities],
  );
  const types = useMemo(
    () => [...new Set(activities.map((activity) => activity.actionType))].sort(),
    [activities],
  );
  const actors = useMemo(() => {
    const participantIds = new Set(activities.flatMap((activity) => [...activity.participants]));
    return subjects.filter((subject) => participantIds.has(subject.id));
  }, [activities, subjects]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return activities
      .filter((activity) => day === ALL || dayOf(activity.startedAt) === Number(day))
      .filter((activity) => type === ALL || activity.actionType === type)
      .filter((activity) => actor === ALL || activity.participants.includes(actor))
      .filter(
        (activity) =>
          !conversationsOnly ||
          (activity.activityState === "conversing" && activity.participants.length >= 2),
      )
      .filter((activity) => {
        if (needle === "") return true;
        const participantNames = activity.participants
          .map((participant) => names.get(participant) ?? participant)
          .join(" ");
        return `${activity.sequence} ${activity.actionType} ${activity.activityState} ${participantNames}`
          .toLocaleLowerCase()
          .includes(needle);
      })
      .toSorted((a, b) => b.startedAt - a.startedAt || b.sequence - a.sequence);
  }, [activities, actor, conversationsOnly, day, names, query, type]);

  const select = (activity: ChannelActivity) => {
    setSelectedId(activity.id);
    onSelect(activity);
  };

  return (
    <section className="activity-browser" aria-labelledby={`${id}-title`}>
      <div className="activity-browser__heading">
        <div>
          <span className="eyebrow" id={`${id}-title`}>Past activity</span>
          <p>Search the complete record and jump to any action.</p>
        </div>
        <output aria-live="polite">
          {filtered.length.toLocaleString()} of {activities.length.toLocaleString()}
        </output>
      </div>

      <div className="activity-browser__filters">
        <label className="activity-browser__search">
          <span className="sr-only">Search past activity</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search action, actor, or event number…"
          />
        </label>
        <label>
          <span className="sr-only">Filter by day</span>
          <select value={day} onChange={(event) => setDay(event.currentTarget.value)}>
            <option value={ALL}>Every day</option>
            {days.map((value) => <option key={value} value={value}>Day {value}</option>)}
          </select>
        </label>
        <label>
          <span className="sr-only">Filter by action type</span>
          <select value={type} onChange={(event) => setType(event.currentTarget.value)}>
            <option value={ALL}>Every action</option>
            {types.map((value) => <option key={value} value={value}>{titleCase(value)}</option>)}
          </select>
        </label>
        <label>
          <span className="sr-only">Filter by actor</span>
          <select value={actor} onChange={(event) => setActor(event.currentTarget.value)}>
            <option value={ALL}>Every inhabitant</option>
            {actors.map((subject) => (
              <option key={subject.id} value={subject.id}>{subject.displayName}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="activity-browser__toggle"
          aria-pressed={conversationsOnly}
          onClick={() => setConversationsOnly((value) => !value)}
        >
          Conversations
        </button>
      </div>

      <ul className="activity-browser__list" aria-label="Recorded activities">
        {filtered.map((activity) => {
          const participantNames = activity.participants.map(
            (participant) => names.get(participant) ?? "Unknown inhabitant",
          );
          const isConversation =
            activity.activityState === "conversing" && activity.participants.length >= 2;
          return (
            <li key={activity.id}>
              <button
                type="button"
                className="activity-browser__event"
                aria-pressed={selectedId === activity.id}
                onClick={() => select(activity)}
              >
                <span className="activity-browser__event-day">Day {dayOf(activity.startedAt)}</span>
                <span className="activity-browser__event-main">
                  <strong>{titleCase(activity.actionType)}</strong>
                  <small>
                    Event {activity.sequence}
                    {participantNames.length > 0 ? ` · ${participantNames.join(", ")}` : ""}
                  </small>
                </span>
                <span className="activity-browser__event-meta">
                  {isConversation ? "Conversation" : titleCase(activity.activityState)}
                  {!activity.contentsDisclosed ? " · details withheld" : ""}
                </span>
                <span aria-hidden="true" className="activity-browser__play">Replay →</span>
              </button>
            </li>
          );
        })}
        {filtered.length === 0 && (
          <li className="activity-browser__empty">No recorded activity matches these filters.</li>
        )}
      </ul>
    </section>
  );
}
