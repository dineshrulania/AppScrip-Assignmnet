import { useEffect, useMemo, useState } from "react";
import { useStore } from "./store";
import { useRoute, go } from "./router";
import { useOperator, setOperator } from "./operator";
import { api } from "./api";
import { Ago, Icon, Toasts, clock, dur, useNow } from "./components/ui";
import type { Operator } from "./types";
import Overview from "./pages/Overview";
import Devices from "./pages/Devices";
import Events from "./pages/Events";
import Incidents from "./pages/Incidents";
import Rules from "./pages/Rules";
import System from "./pages/System";
import Lab from "./pages/Lab";

const NAV = [
  {
    id: "",
    label: "Overview",
    icon: "grid",
    title: "Operations overview",
    sub: "Live health and status across the entire network",
  },
  {
    id: "incidents",
    label: "Incidents",
    icon: "alert",
    title: "Incidents",
    sub: "Review, acknowledge and resolve active incidents",
  },
  {
    id: "devices",
    label: "Devices",
    icon: "cpu",
    title: "Devices",
    sub: "All registered nodes and their current status",
  },
  {
    id: "events",
    label: "Live events",
    icon: "activity",
    title: "Live event stream",
    sub: "Incoming events with full rule evaluation trace",
  },
  {
    id: "rules",
    label: "Rules",
    icon: "sliders",
    title: "Detection rules",
    sub: "Configure what conditions trigger an incident",
  },
  {
    id: "system",
    label: "System health",
    icon: "server",
    title: "System health",
    sub: "Pipeline status, queue depth and fault injection",
  },
  {
    id: "lab",
    label: "Failure lab",
    icon: "flask",
    title: "Failure lab",
    sub: "Controlled failure scenarios and recovery tests",
  },
] as const;

export default function App() {
  const route = useRoute();
  const page = route[0] ?? "";
  const nav = NAV.find((n) => n.id === page) ?? NAV[0];
  const activeIncidents = useStore((s) => s.stats?.incidents.open ?? 0);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="white"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <div>
            <div className="brand-name">NetWatch</div>
            <div className="brand-sub">Device monitoring platform</div>
          </div>
        </div>
        {NAV.slice(0, 4).map((n) => (
          <button
            key={n.id}
            className={`nav-item ${page === n.id ? "active" : ""}`}
            onClick={() => go(n.id)}
          >
            <Icon name={n.icon} />
            {n.label}
            {n.id === "incidents" && activeIncidents > 0 && (
              <span className="count">{activeIncidents}</span>
            )}
          </button>
        ))}
        <div className="nav-section">Configure & operate</div>
        {NAV.slice(4).map((n) => (
          <button
            key={n.id}
            className={`nav-item ${page === n.id ? "active" : ""}`}
            onClick={() => go(n.id)}
          >
            <Icon name={n.icon} />
            {n.label}
          </button>
        ))}
        <SidebarFoot />
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <h1>{nav.title}</h1>
            <div className="sub">{nav.sub}</div>
          </div>
          <div className="spacer" />
          <OperatorPicker />
          <ConnectionPill />
        </header>
        <ConnectionBanner />
        <Content page={page} />
      </div>
      <Toasts />
    </div>
  );
}

function Content({ page }: { page: string }) {
  const conn = useStore((s) => s.conn);
  const fromCache = useStore((s) => s.fromCache);
  const stale = conn !== "live" || fromCache;
  return (
    <main className={`content ${stale ? "stale" : ""}`}>
      {page === "" && <Overview />}
      {page === "incidents" && <Incidents />}
      {page === "devices" && <Devices />}
      {page === "events" && <Events />}
      {page === "rules" && <Rules />}
      {page === "system" && <System />}
      {page === "lab" && <Lab />}
    </main>
  );
}

function ConnectionPill() {
  const conn = useStore((s) => s.conn);
  const label = {
    live: "Live",
    connecting: "Connecting…",
    reconnecting: "Reconnecting…",
    offline: "Offline",
  }[conn];
  return (
    <span className={`conn ${conn}`} title="Real-time stream status">
      <span className="dot" />
      {label}
    </span>
  );
}

/** Keeps the UI honest about freshness during outages, and tells the operator when it caught up. */
function ConnectionBanner() {
  const conn = useStore((s) => s.conn);
  const since = useStore((s) => s.connSince);
  const lastSync = useStore((s) => s.lastMessageAt ?? s.lastSyncAt);
  const fromCache = useStore((s) => s.fromCache);
  const resume = useStore((s) => s.resume);
  const now = useNow();
  const [hideResume, setHideResume] = useState<number | null>(null);

  if (conn !== "live" || fromCache) {
    return (
      <div className="banner warn">
        <Icon name="wifiOff" />
        <span>
          <b>
            {conn === "live"
              ? "Showing cached data"
              : "Connection to the platform lost"}
          </b>{" "}
          — you are looking at the last known state
          {lastSync
            ? ` from ${clock(lastSync)} (${dur(now - lastSync)} old)`
            : ""}
          . Actions are disabled until we reconnect
          {conn !== "live" ? `; retrying for ${dur(now - since)}` : ""}.
        </span>
      </div>
    );
  }
  if (resume && now - resume.at < 8000 && hideResume !== resume.at) {
    return (
      <div className="banner ok">
        <Icon name="check" />
        <span>
          <b>Reconnected.</b>{" "}
          {resume.mode === "resumed"
            ? `Caught up on ${resume.replayed} missed update${resume.replayed === 1 ? "" : "s"} — nothing was lost.`
            : "The gap was too long to replay, so the view was reloaded from a fresh snapshot."}
        </span>
        <button
          className="btn ghost sm right"
          onClick={() => setHideResume(resume.at)}
        >
          Dismiss
        </button>
      </div>
    );
  }
  return null;
}

function OperatorPicker() {
  const me = useOperator();
  const [ops, setOps] = useState<Operator[]>([]);
  useEffect(() => {
    api
      .get<Operator[]>("/api/operators")
      .then(setOps)
      .catch(() => {});
  }, []);
  const names = useMemo(
    () => Array.from(new Set([me, ...ops.map((o) => o.name)])),
    [ops, me],
  );
  return (
    <label
      className="flex small muted"
      title="Actions are attributed to this operator"
    >
      Acting as
      <select
        className="input"
        style={{ width: "auto", padding: "5px 8px" }}
        value={me}
        onChange={(e) => setOperator(e.target.value)}
      >
        {names.map((n) => (
          <option key={n}>{n}</option>
        ))}
      </select>
    </label>
  );
}

function SidebarFoot() {
  const stats = useStore((s) => s.stats);
  return (
    <div className="sidebar-foot col" style={{ gap: 6 }}>
      <div className="flex">
        <span className="status-dot online" /> {stats?.devices.online ?? "–"} /{" "}
        {stats?.devices.total ?? "–"} devices online
      </div>
      <div className="flex">
        <Icon name="layers" size={13} /> queue {stats?.queue.depth ?? "–"} · DLQ{" "}
        {stats?.queue.dead_letter ?? "–"}
      </div>
      <div className="flex">
        <Icon name="clock" size={13} /> updated <Ago ts={stats?.at} />
      </div>
    </div>
  );
}
