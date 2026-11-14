import React from 'react';
import LinkButton from './LinkButton';

// A row of link buttons, followed by one line per distinct reason a link is disabled.
export default function LinkGroup({ links = [] }) {
  if (links.length === 0) return null;
  const reasons = Array.from(new Set(links.filter(l => !l.url && l.reason).map(l => l.reason)));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {links.map(link => <LinkButton key={link.id} link={link} />)}
      </div>
      {reasons.map(reason => (
        <p key={reason} className="text-[11px] text-amber-300/80 leading-snug">{reason}</p>
      ))}
    </div>
  );
}
