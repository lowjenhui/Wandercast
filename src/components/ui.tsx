import type { ReactNode } from 'react';
import { Mascot } from './Brand';
import type { Confidence } from '../lib/weatherAnalysis';

export type Tone = 'good' | 'warning' | 'serious' | 'critical' | 'info' | 'neutral';

const ICON: Record<Tone, string> = { good: '✓', warning: '!', serious: '!', critical: '✕', info: 'i', neutral: '•' };

/** Status badge: colour always paired with an icon and a text label. */
export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`badge tone-${tone}`}>
      <span aria-hidden>{ICON[tone]}</span>
      {children}
    </span>
  );
}

export function ConfidenceBadge({ level }: { level: Confidence }) {
  const tone: Tone = level === 'high' ? 'good' : level === 'medium' ? 'warning' : 'critical';
  return <Badge tone={tone}>{level[0].toUpperCase() + level.slice(1)} confidence</Badge>;
}

export function Notice({ kind = 'info', title, children }: { kind?: 'info' | 'warn' | 'err'; title: string; children: ReactNode }) {
  return (
    <div className={`notice ${kind === 'info' ? '' : kind}`} role={kind === 'err' ? 'alert' : undefined}>
      <strong>{title}</strong>
      {children}
    </div>
  );
}

/** `mascot: false` where Puff is already on the page (Puff's Lookout shows one Puff only). */
export function SkeletonCard({ title, note, mascot = true }: { title: string; note: string; mascot?: boolean }) {
  return (
    <section className="card" aria-busy="true">
      <div className="mascot-row">
        {mascot && <Mascot mood="searching" size={64} />}
        <div>
          <h2>{title}</h2>
          <p className="small muted">{note}</p>
        </div>
      </div>
      <div className="skeleton" />
    </section>
  );
}
