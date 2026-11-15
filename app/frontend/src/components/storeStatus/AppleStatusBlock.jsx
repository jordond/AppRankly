import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { VersionRow, StatusFooter } from './StatusParts';

const PLATFORM_LABEL = { IOS: 'iOS', MAC_OS: 'macOS', TV_OS: 'tvOS', VISION_OS: 'visionOS' };

function PhasedRelease({ phased }) {
  if (!phased || (phased.state !== 'ACTIVE' && phased.state !== 'PAUSED')) return null;
  return (
    <span className="text-[11px] text-slate-400">
      Phased release {phased.state === 'PAUSED' ? 'paused' : 'active'}: day {phased.day} of 7
      {phased.percent != null ? ` (~${phased.percent}%)` : ''}
    </span>
  );
}

// Review and release state for one app on the App Store.
export default function AppleStatusBlock({ status, error, fetchedAt }) {
  const platforms = status?.platforms || [];
  const submission = status?.reviewSubmission;

  return (
    <div className="space-y-2">
      {platforms.map(p => (
        <div key={p.platform} className="space-y-1.5">
          {platforms.length > 1 && (
            <div className="text-[11px] font-semibold text-slate-400">{PLATFORM_LABEL[p.platform] || p.platform}</div>
          )}
          <VersionRow label="Live" version={p.live}><PhasedRelease phased={p.live?.phasedRelease} /></VersionRow>
          <VersionRow label={p.live ? 'Next' : 'Latest'} version={p.inFlight}><PhasedRelease phased={p.inFlight?.phasedRelease} /></VersionRow>
          {!p.live && !p.inFlight && <p className="text-xs text-slate-500">No versions.</p>}
        </div>
      ))}

      {status && platforms.length === 0 && <p className="text-xs text-slate-500">No versions yet.</p>}

      {submission?.needsAttention && (
        <p className="flex items-center gap-1.5 text-xs text-rose-300">
          <AlertTriangle size={13} className="shrink-0" />
          <span>Review submission has unresolved issues. Open App Store Connect for the details.</span>
        </p>
      )}

      <StatusFooter status={status} error={error} fetchedAt={fetchedAt} />
    </div>
  );
}
