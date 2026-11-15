import React, { useState } from 'react';
import { CheckCircle2, XCircle, ShieldCheck, Activity } from 'lucide-react';
import { apiFetch } from '../../lib/api';

function CheckList({ title, store }) {
  if (!store) return null;
  return (
    <div className="space-y-1.5 min-w-0">
      <div className="text-[11px] font-semibold text-slate-300">
        {title}
        {store.testedWith && <span className="font-normal text-slate-500"> · tested with {store.testedWith}</span>}
        {store.dedicatedKey && <span className="font-normal text-slate-500"> · dedicated status key</span>}
      </div>
      {!store.configured && <p className="text-xs text-amber-300/90">{store.error?.message || 'Not configured.'}</p>}
      {store.configured && store.checks.length === 0 && <p className="text-xs text-slate-500">No app on this store to test with.</p>}
      {store.checks.map(check => (
        <div key={check.id} className="text-xs">
          <p className="flex items-center gap-1.5">
            {check.ok
              ? <CheckCircle2 size={13} className="shrink-0 text-emerald-400" />
              : <XCircle size={13} className="shrink-0 text-rose-400" />}
            <span className={check.ok ? 'text-slate-300' : 'text-rose-200'}>{check.label}</span>
          </p>
          {!check.ok && check.error && (
            <p className="pl-5 text-[11px] text-slate-400">{check.error.message} {check.error.hint}</p>
          )}
        </div>
      ))}
      {store.rolloutViaEdits && (
        <p className="text-[11px] text-slate-500">Rollout percentage through edits is switched on. It is not tested here, because testing it would open an edit.</p>
      )}
    </div>
  );
}

// What each store needs for this page, plus a button that tries every kind of read once.
export default function SetupGuide({ authToken, isStaticMode, isDemoMode }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const canCheck = !isStaticMode && !isDemoMode;

  const check = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/store-status/capabilities', {}, authToken, isStaticMode);
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      setResult(await res.json());
    } catch (err) {
      setError(err.message || 'Access check failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <details className="glass-card p-5 group">
      <summary className="flex items-center gap-2 cursor-pointer text-xs font-bold uppercase tracking-wider text-slate-400 select-none">
        <ShieldCheck size={14} />
        <span>Setup and access</span>
      </summary>
      <div className="mt-4 space-y-4 text-xs text-slate-400">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-1.5">
            <div className="text-[11px] font-semibold text-slate-300">App Store Connect</div>
            <p>
              Version, review, TestFlight and review data need an API key with an app role, such as App Manager or Admin (tested with Admin).
              A key with only Sales and Reports cannot read them.
            </p>
            <p>
              To keep the analytics key at Sales and Reports, add a second key under{' '}
              <code className="text-slate-300">storeStatus.apple</code> (keyFilePath, keyId, issuerId).
            </p>
          </div>
          <div className="space-y-1.5">
            <div className="text-[11px] font-semibold text-slate-300">Google Play</div>
            <p>
              In Play Console, Users and permissions, give the service account "View app information and download bulk
              reports (read-only)" and "View app quality information (read-only)". New permissions can take 24 to 48 hours.
            </p>
            <p>
              In its Google Cloud project, enable the Google Play Android Developer API and the Google Play Developer
              Reporting API. Per-app console buttons also need{' '}
              <code className="text-slate-300">appMetadata.&lt;package&gt;.consoleAppId</code>.
            </p>
          </div>
        </div>
        <p>This page only reads from the stores. It never changes a release, a review or a setting.</p>

        {canCheck && (
          <button
            type="button"
            onClick={check}
            disabled={loading}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold border border-white/10 text-slate-200 bg-white/5 hover:bg-white/10 disabled:opacity-50"
          >
            {loading ? <Activity size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
            <span>Check access</span>
          </button>
        )}
        {error && <p className="text-rose-300">{error}</p>}
        {result && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <CheckList title="App Store Connect" store={result.apple} />
            <CheckList title="Google Play" store={result.google} />
          </div>
        )}
      </div>
    </details>
  );
}
