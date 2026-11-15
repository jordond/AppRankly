import React from 'react';
import { PlayStoreIcon, AppleStoreIcon } from '../icons/StoreIcons';
import LinkGroup from './LinkGroup';
import AppleStatusBlock from './AppleStatusBlock';
import GoogleStatusBlock from './GoogleStatusBlock';

function StoreColumn({ icon, title, identifier, links, emptyText, children }) {
  return (
    <div className="space-y-3 min-w-0">
      <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
        {icon}
        <span>{title}</span>
      </div>
      {links ? (
        <>
          {identifier && <p className="text-[11px] font-mono text-slate-500 truncate" title={identifier}>{identifier}</p>}
          {children}
          <LinkGroup links={links} />
        </>
      ) : (
        <p className="text-xs text-slate-500">{emptyText}</p>
      )}
    </div>
  );
}

// One product: App Store and Play Store side by side, each with its state and console links.
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
        >
          {app.apple && (app.apple.status || app.apple.error) && (
            <AppleStatusBlock status={app.apple.status} error={app.apple.error} fetchedAt={app.apple.fetchedAt} />
          )}
        </StoreColumn>
        <StoreColumn
          icon={<PlayStoreIcon size={14} />}
          title="Google Play"
          identifier={app.google?.packageName}
          links={app.google?.links}
          emptyText="Not on Google Play."
        >
          {app.google && (app.google.status || app.google.error) && (
            <GoogleStatusBlock status={app.google.status} error={app.google.error} fetchedAt={app.google.fetchedAt} />
          )}
        </StoreColumn>
      </div>
    </section>
  );
}
