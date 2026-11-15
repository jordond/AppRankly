import React from 'react';
import { PlayStoreIcon, AppleStoreIcon } from '../icons/StoreIcons';
import { formatAge, humanize } from './StatusParts';

// State transitions detected so far, newest first.
export default function RecentChanges({ changes = [] }) {
  if (changes.length === 0) return null;
  return (
    <div className="space-y-4">
      <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">Recent changes</h3>
      <ul className="glass-card divide-y divide-white/5">
        {changes.map((c, i) => (
          <li key={`${c.detectedAt}-${i}`} className="flex items-center gap-3 px-5 py-3 text-sm">
            {c.platform === 'apple' ? <AppleStoreIcon size={14} /> : <PlayStoreIcon size={14} />}
            <span className="font-semibold text-white">{c.appName} {c.subject}</span>
            <span className="text-slate-400 min-w-0 truncate">
              {c.fromState ? `${humanize(c.fromState)} → ` : ''}{humanize(c.toState)}
            </span>
            <span className="ml-auto shrink-0 text-[11px] text-slate-500">{formatAge(c.detectedAt)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
