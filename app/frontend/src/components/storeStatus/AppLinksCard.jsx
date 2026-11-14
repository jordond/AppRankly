import React from 'react';
import { PlayStoreIcon, AppleStoreIcon } from '../icons/StoreIcons';
import LinkGroup from './LinkGroup';

function StoreColumn({ icon, title, identifier, links, emptyText }) {
  return (
    <div className="space-y-3 min-w-0">
      <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
        {icon}
        <span>{title}</span>
      </div>
      {links ? (
        <>
          {identifier && <p className="text-[11px] font-mono text-slate-500 truncate" title={identifier}>{identifier}</p>}
          <LinkGroup links={links} />
        </>
      ) : (
        <p className="text-xs text-slate-500">{emptyText}</p>
      )}
    </div>
  );
}

// One product, with its App Store and Play Store links side by side.
export default function AppLinksCard({ app }) {
  return (
    <section className="glass-card p-5 space-y-4">
      <h3 className="text-base font-bold text-white truncate">{app.name}</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <StoreColumn
          icon={<AppleStoreIcon size={14} />}
          title="App Store"
          identifier={app.apple ? [app.apple.bundleId, app.apple.appId].filter(Boolean).join(' · ') : null}
          links={app.apple?.links}
          emptyText="Not on the App Store."
        />
        <StoreColumn
          icon={<PlayStoreIcon size={14} />}
          title="Google Play"
          identifier={app.google?.packageName}
          links={app.google?.links}
          emptyText="Not on Google Play."
        />
      </div>
    </section>
  );
}
