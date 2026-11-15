import React from 'react';
import { AlertTriangle } from 'lucide-react';

const STATE_STYLE = {
  LIVE: { label: 'Live', className: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  APPROVED_PENDING_RELEASE: { label: 'Approved, not released', className: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
  IN_REVIEW: { label: 'In review', className: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  WAITING_FOR_REVIEW: { label: 'Waiting for review', className: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  REJECTED: { label: 'Rejected', className: 'bg-rose-500/15 text-rose-300 border-rose-500/30' },
  DRAFT: { label: 'Draft', className: 'bg-white/5 text-slate-300 border-white/10' },
  SUPERSEDED: { label: 'Replaced', className: 'bg-white/5 text-slate-400 border-white/10' },
  OTHER: { label: 'Unknown', className: 'bg-white/5 text-slate-300 border-white/10' }
};

export const humanize = (raw) => String(raw || '').toLowerCase().replace(/_/g, ' ');

export function formatAge(iso, now = Date.now()) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const minutes = Math.max(0, Math.round((now - then) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function StateBadge({ state, rawState }) {
  const style = STATE_STYLE[state] || STATE_STYLE.OTHER;
  return (
    <span title={rawState || ''} className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-bold border ${style.className}`}>
      {style.label}
    </span>
  );
}

// One version or release: label, name, build, state badge, and anything extra after it.
export function VersionRow({ label, labelTitle, version, children }) {
  if (!version) return null;
  return (
    <div className="flex items-center gap-2 flex-wrap text-sm">
      <span className="w-16 shrink-0 text-[11px] uppercase tracking-wider text-slate-500" title={labelTitle}>{label}</span>
      <span className="font-semibold text-white">{version.version || '?'}</span>
      {version.buildNumber && <span className="text-xs text-slate-500">({version.buildNumber})</span>}
      <StateBadge state={version.state} rawState={version.rawState} />
      {version.state !== 'LIVE' && version.rawState && (
        <span className="text-[11px] text-slate-500">{humanize(version.rawState)}</span>
      )}
      {children}
    </div>
  );
}

// Fetch error and "checked N min ago" line shared by both stores.
export function StatusFooter({ status, error, fetchedAt }) {
  const age = fetchedAt ? formatAge(fetchedAt) : null;
  return (
    <>
      {error && (
        <div className="text-xs text-amber-300/90 space-y-0.5">
          <p className="flex items-center gap-1.5">
            <AlertTriangle size={13} className="shrink-0" />
            <span>{error.message}</span>
          </p>
          {error.hint && <p className="text-amber-300/70">{error.hint}</p>}
        </div>
      )}
      {age && (
        <p className="text-[11px] text-slate-500">
          {error && status ? `Showing last known state, checked ${age}` : `Checked ${age}`}
        </p>
      )}
    </>
  );
}
