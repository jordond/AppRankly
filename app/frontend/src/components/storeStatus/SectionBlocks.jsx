import React from 'react';
import { AlertTriangle, Star } from 'lucide-react';
import { formatAge, humanize } from './StatusParts';

// Shared frame for an optional section: small heading, content, and its own fetch error.
function Section({ title, error, children }) {
  return (
    <div className="space-y-1.5 pt-2 border-t border-white/5">
      <div className="text-[11px] font-semibold text-slate-400">{title}</div>
      {children}
      {error && (
        <p className="flex items-center gap-1.5 text-[11px] text-amber-300/80" title={error.hint || ''}>
          <AlertTriangle size={12} className="shrink-0" />
          <span>{error.message}</span>
        </p>
      )}
    </div>
  );
}

const BUILD_STATE_CLASS = {
  PROCESSING: 'text-amber-300',
  FAILED: 'text-rose-300',
  INVALID: 'text-rose-300',
  BETA_REJECTED: 'text-rose-300',
  MISSING_EXPORT_COMPLIANCE: 'text-amber-300',
  WAITING_FOR_BETA_REVIEW: 'text-amber-300',
  IN_BETA_REVIEW: 'text-amber-300',
  IN_BETA_TESTING: 'text-emerald-300',
  BETA_APPROVED: 'text-emerald-300',
  EXPIRED: 'text-slate-500'
};

// Latest TestFlight builds. `data` is { status: { builds, total }, error }.
export function TestFlightBlock({ data, hideError }) {
  if (!data) return null;
  const builds = data.status?.builds || [];
  const error = hideError ? null : data.error;
  if (builds.length === 0 && !error) return null;
  const total = data.status?.total || builds.length;
  return (
    <Section title={`TestFlight${total > builds.length ? ` (latest ${Math.min(3, builds.length)} of ${total})` : ''}`} error={error}>
      {builds.slice(0, 3).map(b => (
        <div key={`${b.appVersion}-${b.buildNumber}`} className="flex items-center gap-2 flex-wrap text-xs">
          <span className="font-semibold text-slate-200">{b.appVersion || '?'}</span>
          <span className="text-slate-500">({b.buildNumber})</span>
          <span
            className={BUILD_STATE_CLASS[b.summaryState] || 'text-slate-300'}
            title={`processing: ${humanize(b.processingState)} · internal: ${humanize(b.internalState)} · external: ${humanize(b.externalState)}`}
          >
            {humanize(b.summaryState) || 'unknown'}
          </span>
          {b.uploadedDate && <span className="text-[11px] text-slate-500">uploaded {formatAge(b.uploadedDate)}</span>}
        </div>
      ))}
    </Section>
  );
}

function Stars({ rating }) {
  const value = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
  return (
    <span className="inline-flex items-center shrink-0" aria-label={`${value} of 5 stars`}>
      {[1, 2, 3, 4, 5].map(i => (
        <Star key={i} size={10} className={i <= value ? 'text-amber-400 fill-amber-400' : 'text-slate-600'} />
      ))}
    </span>
  );
}

// Reviews read from the store API and kept locally. `data` is { status: { total, average, recent }, error }.
export function ReviewsBlock({ data, hideError, note }) {
  if (!data) return null;
  const { total = 0, average = null, recent = [] } = data.status || {};
  const error = hideError ? null : data.error;
  return (
    <Section title="Reviews" error={error}>
      {total === 0 ? (
        !error && <p className="text-[11px] text-slate-500">{note || 'No reviews yet.'}</p>
      ) : (
        <>
          <p className="text-[11px] text-slate-500">
            {total} stored{average != null ? `, average ${Number(average).toFixed(1)}` : ''}
          </p>
          {recent.map(r => (
            <div key={r.reviewId} className="text-xs space-y-0.5">
              <div className="flex items-center gap-2 flex-wrap">
                <Stars rating={r.rating} />
                {r.title && <span className="font-semibold text-slate-200 truncate max-w-[16rem]">{r.title}</span>}
                <span className="text-[11px] text-slate-500">
                  {[r.version, r.territory, r.createdAt ? formatAge(r.createdAt) : null].filter(Boolean).join(' · ')}
                </span>
                {r.replied && <span className="text-[11px] text-emerald-300/80">replied</span>}
              </div>
              {r.body && <p className="text-slate-400 line-clamp-2" title={r.body}>{r.body}</p>}
            </div>
          ))}
        </>
      )}
    </Section>
  );
}

const percent = (fraction) => (fraction == null ? null : `${(Number(fraction) * 100).toFixed(2)}%`);

function VitalRow({ label, metric }) {
  if (!metric || metric.userPerceived == null) {
    return <p className="text-[11px] text-slate-500">{label}: not enough data</p>;
  }
  return (
    <div className="flex items-center gap-2 flex-wrap text-xs">
      <span className="w-12 shrink-0 text-slate-400">{label}</span>
      <span className="font-semibold text-slate-200" title="User-perceived rate, 7-day user-weighted">{percent(metric.userPerceived)}</span>
      {metric.overall != null && <span className="text-[11px] text-slate-500">overall {percent(metric.overall)}</span>}
      {metric.date && (
        <span className="text-[11px] text-slate-500" title={metric.distinctUsers != null ? `About ${metric.distinctUsers} users (rounded by Google Play)` : ''}>
          7 days to {metric.date}
        </span>
      )}
    </div>
  );
}

// Android vitals. `data` is { status: { crash, anr }, error }.
export function VitalsBlock({ data, hideError }) {
  if (!data) return null;
  const error = hideError ? null : data.error;
  if (!data.status && !error) return null;
  return (
    <Section title="Vitals" error={error}>
      {data.status && (
        <>
          <VitalRow label="Crash" metric={data.status.crash} />
          <VitalRow label="ANR" metric={data.status.anr} />
        </>
      )}
    </Section>
  );
}
