import React from 'react';
import { ExternalLink } from 'lucide-react';

// One console or store link. A link whose IDs are not configured renders disabled,
// with the missing setting as its tooltip.
export default function LinkButton({ link }) {
  const base = 'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors';

  if (!link.url) {
    return (
      <span
        title={link.reason || 'Not available'}
        aria-disabled="true"
        className={`${base} border-white/5 text-slate-500 bg-white/[0.02] cursor-not-allowed`}
      >
        {link.label}
      </span>
    );
  }

  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`${base} border-white/10 text-slate-200 bg-white/5 hover:bg-accent-blue/20 hover:border-accent-blue/40 hover:text-white`}
    >
      <span>{link.label}</span>
      <ExternalLink size={12} className="opacity-60" />
    </a>
  );
}
