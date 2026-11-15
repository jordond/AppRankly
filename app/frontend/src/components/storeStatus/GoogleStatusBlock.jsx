import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { VersionRow, StatusFooter } from './StatusParts';

// Play Console names for the built-in tracks; custom tracks show their own name.
const TRACK_LABEL = { production: 'Production', beta: 'Open testing', alpha: 'Closed testing', internal: 'Internal testing' };

// The rollout entry for a release: same track, same highest version code.
function findRollout(rollout, track, release) {
  const code = release?.versionCodes?.[0];
  if (code == null) return null;
  return (rollout?.tracks?.[track] || []).find(r => r.versionCodes?.[0] === code) || null;
}

function Rollout({ entry }) {
  if (!entry || entry.userFraction == null) return null;
  const percent = `${Math.round(entry.userFraction * 1000) / 10}%`;
  return entry.status === 'halted'
    ? <span className="text-[11px] text-rose-300">Rollout halted at {percent}</span>
    : <span className="text-[11px] text-slate-400">Rollout {percent}</span>;
}

// Review and release state for one app on Google Play, one group per track that has a release.
// `rollout` ({ status, error }) is only present when rollout reading is switched on.
export default function GoogleStatusBlock({ status, error, fetchedAt, rollout }) {
  const tracks = status?.tracks || [];

  return (
    <div className="space-y-2">
      {tracks.map(t => (
        <div key={t.track} className="space-y-1.5">
          <div className="text-[11px] font-semibold text-slate-400" title={`Track: ${t.track}`}>{TRACK_LABEL[t.track] || t.track}</div>
          <VersionRow label="Live" version={t.live}><Rollout entry={findRollout(rollout?.status, t.track, t.live)} /></VersionRow>
          <VersionRow label={t.live ? 'Next' : 'Latest'} version={t.inFlight} />
        </div>
      ))}

      {status && tracks.length === 0 && <p className="text-xs text-slate-500">No releases on any track.</p>}

      {rollout?.error && !error && (
        <p className="flex items-center gap-1.5 text-[11px] text-amber-300/80" title={rollout.error.hint || ''}>
          <AlertTriangle size={12} className="shrink-0" />
          <span>{rollout.error.message}</span>
        </p>
      )}

      <StatusFooter status={status} error={error} fetchedAt={fetchedAt} />
    </div>
  );
}
