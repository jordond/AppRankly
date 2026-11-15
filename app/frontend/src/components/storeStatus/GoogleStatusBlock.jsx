import React from 'react';
import { VersionRow, StatusFooter } from './StatusParts';

// Play Console names for the built-in tracks; custom tracks show their own name.
const TRACK_LABEL = { production: 'Production', beta: 'Open testing', alpha: 'Closed testing', internal: 'Internal testing' };

// Review and release state for one app on Google Play, one group per track that has a release.
export default function GoogleStatusBlock({ status, error, fetchedAt }) {
  const tracks = status?.tracks || [];

  return (
    <div className="space-y-2">
      {tracks.map(t => (
        <div key={t.track} className="space-y-1.5">
          <div className="text-[11px] font-semibold text-slate-400" title={`Track: ${t.track}`}>{TRACK_LABEL[t.track] || t.track}</div>
          <VersionRow label="Live" version={t.live} />
          <VersionRow label={t.live ? 'Next' : 'Latest'} version={t.inFlight} />
        </div>
      ))}

      {status && tracks.length === 0 && <p className="text-xs text-slate-500">No releases on any track.</p>}

      <StatusFooter status={status} error={error} fetchedAt={fetchedAt} />
    </div>
  );
}
