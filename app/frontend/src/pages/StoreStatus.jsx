import React, { useState, useEffect, useCallback } from 'react';
import { Activity, AlertCircle, RefreshCw } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { MOCK_STORE_STATUS } from '../lib/storeStatusMock';
import { PlayStoreIcon, AppleStoreIcon } from '../components/icons/StoreIcons';
import AppLinksCard from '../components/storeStatus/AppLinksCard';
import LinkGroup from '../components/storeStatus/LinkGroup';
import RecentChanges from '../components/storeStatus/RecentChanges';
import SetupGuide from '../components/storeStatus/SetupGuide';

function groupCustomLinks(links = []) {
  const groups = new Map();
  links.forEach(link => {
    const key = link.group || 'Custom';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(link);
  });
  return Array.from(groups, ([title, items]) => ({ title, items }));
}

function CommonLinksPanel({ icon, title, links }) {
  if (!links || links.length === 0) return null;
  return (
    <div className="glass-card p-5 space-y-3">
      <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
        {icon}
        <span>{title}</span>
      </div>
      <LinkGroup links={links} />
    </div>
  );
}

export default function StoreStatus({ authToken, isStaticMode, isDemoMode }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async (fresh = false) => {
    if (isDemoMode || isStaticMode) {
      setData(MOCK_STORE_STATUS);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/store-status${fresh ? '?fresh=1' : ''}`, {}, authToken, isStaticMode);
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      setData(await res.json());
    } catch (err) {
      setError(err.message || 'Failed to load store status');
    } finally {
      setLoading(false);
    }
  }, [authToken, isStaticMode, isDemoMode]);

  useEffect(() => { load(); }, [load]);

  const apps = data?.apps || [];
  const common = data?.common || {};
  const customGroups = groupCustomLinks(common.custom);

  return (
    <div className="space-y-8 animate-in fade-in duration-200">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white">Store Status</h2>
          <p className="text-sm text-slate-400">Review and release state for each app, with links straight to the matching console pages.</p>
        </div>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={loading}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold border border-white/10 text-slate-200 bg-white/5 hover:bg-white/10 disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          <span>Refresh</span>
        </button>
      </div>

      {error && (
        <div className="glass-card p-4 flex items-center gap-3 text-sm text-rose-300 border-rose-500/30">
          <AlertCircle size={16} className="shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading && !data ? (
        <div className="flex items-center justify-center text-slate-400 text-xs py-12">
          <Activity className="animate-spin text-accent-blue mr-2" size={18} />
          <span>Loading apps...</span>
        </div>
      ) : (
        <>
          <div className="space-y-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">Apps</h3>
            {apps.length === 0 && !error ? (
              <p className="text-sm text-slate-500">No apps found. Check the store credentials on the Config page.</p>
            ) : (
              <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
                {apps.map(app => <AppLinksCard key={app.id} app={app} />)}
              </div>
            )}
          </div>

          <RecentChanges changes={data?.recentChanges} />

          {data?.polling && !data.polling.enabled && (
            <p className="text-xs text-slate-500">
              Background checks and change alerts are off. Set <code className="text-slate-300">storeStatus.enabled</code> to
              true in config.json to check on a schedule and get notified when a state changes.
            </p>
          )}

          <SetupGuide authToken={authToken} isStaticMode={isStaticMode} isDemoMode={isDemoMode} />

          <div className="space-y-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">Account links</h3>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <CommonLinksPanel icon={<AppleStoreIcon size={14} />} title="Apple" links={common.apple} />
              <CommonLinksPanel icon={<PlayStoreIcon size={14} />} title="Google" links={common.google} />
              {customGroups.map(group => (
                <CommonLinksPanel key={group.title} title={group.title} links={group.items} />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
