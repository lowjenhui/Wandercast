import { useState } from 'react';
import { formatDate } from '../lib/dates';
import { insurerReason, LEVEL_LABEL, LEVEL_RANK, mfaReason, pageUrl, type CoverageStatus, type MfaPage, type PageLevel } from '../lib/advisory';
import { agoLabel, alertsAt, KIND_LABEL, placesLabel, SOURCE_LABEL, type TravelAlert } from '../lib/alerts';
import { safetyAt, type AdvisoryContext, type PlaceSafety } from '../services/advisories';
import { useAlerts } from '../services/alerts';
import { Badge, type Tone } from './ui';

export const levelTone: Record<PageLevel, Tone> = { all: 'critical', nonEssential: 'critical', unknown: 'warning', caution: 'warning', none: 'good' };
export const coverageTone: Record<CoverageStatus, Tone> = {
  covered: 'good',
  'maybe-covered': 'warning',
  check: 'warning',
  'likely-not-covered': 'critical',
  'not-covered': 'critical',
};

type AlertPoint = { cc: string; lat: number; lon: number };

/** "Safety & insurance" summary card for the trip analysis. `places` are checked for recent
 *  unrest alerts (every stop of a booked trip); they never change the MFA or insurer chips.
 *  Active alerts show in an AlertStrip under the summary row; the card only says when there are none. */
export function SafetyCard({ ctx, safety, error, bookedOn, places = [] }: { ctx: AdvisoryContext | null; safety: PlaceSafety | null; error: string | null; bookedOn?: string; places?: AlertPoint[] }) {
  const alertCount = alertItems(useAlerts(), places).length;
  if (!ctx || !safety) {
    return (
      <div className="card verdict">
        <span className="label">Safety & insurance</span>
        <span className="value"><Badge tone="neutral">{error ? 'Unavailable' : 'Loading…'}</Badge></span>
        <p className="small secondary">{error ? `MFA travel advice couldn't be loaded: ${error}` : ''}</p>
      </div>
    );
  }
  const { advisory: adv, coverage } = safety;
  const top = adv.hits[0] ?? null;
  const page = top?.page ?? adv.countryPage;
  const ins = ctx.insurer;
  // Advice elsewhere in the country that doesn't reach this destination.
  const cur = adv.countryPage ? ctx.zones[adv.countryPage.slug] : null;
  const elsewhere =
    !top && adv.countryPage && cur && cur.asOf === adv.countryPage.mfaDate
      ? cur.zones.filter((z) => LEVEL_RANK[z.level] > LEVEL_RANK.caution).map((z) => z.label)
      : [];
  const checked = ctx.feed.checkedAt ? new Date(ctx.feed.checkedAt).toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' }) : null;

  return (
    <div className="card verdict safety-card">
      <span className="label">Safety & insurance</span>
      <span className="value" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Badge tone={levelTone[adv.level]}>{adv.level === 'none' ? 'No MFA advisory' : LEVEL_LABEL[adv.level]}</Badge>
        <Badge tone={coverageTone[coverage.status]}>{coverage.short}</Badge>
      </span>
      {top ? (
        <>
          <p className="small">
            <strong>{top.label}</strong>
            {top.page.mfaDate ? ` · MFA, ${formatDate(top.page.mfaDate)}` : ''}
          </p>
          {top.page.guidance[0] && <p className="small secondary">“{top.page.guidance[0]}”</p>}
          {adv.hits.length > 1 && (
            <p className="small secondary">Also: {adv.hits.slice(1).map((h) => `${h.label} (${LEVEL_LABEL[h.level].toLowerCase()})`).join('; ')}.</p>
          )}
          {top.approx && <p className="small muted">The area is our reading of MFA's wording (e.g. “border regions” as a band along the border). Check MFA's page if you're near its edge.</p>}
          {top.fallback && (
            <p className="small tone-warning">
              MFA {top.page.category === 'notice' ? 'posted or updated this notice' : 'updated this advisory'}
              {top.page.mfaDate ? ` on ${formatDate(top.page.mfaDate)}` : ''}. Until its areas are reviewed, the whole country is flagged at its strongest level.
            </p>
          )}
        </>
      ) : elsewhere.length ? (
        <p className="small secondary">
          MFA's advice for {adv.countryPage!.title} covers {elsewhere.join(' and ')}, not this destination.
        </p>
      ) : (
        <p className="small secondary">MFA has no travel advisory or notice for this destination.</p>
      )}
      {coverage.detail && <p className="small secondary">{coverage.detail}</p>}
      {!bookedOn && LEVEL_RANK[adv.level] >= LEVEL_RANK.nonEssential && (
        <p className="small muted">Already booked? Add the booking date in the search bar to check {ins.name}'s timing rule.</p>
      )}
      <p className="small muted">
        {page ? <a href={pageUrl(page.slug)} target="_blank" rel="noreferrer">MFA travel page</a> : <a href={pageUrl('')} target="_blank" rel="noreferrer">MFA travel advisories</a>}
        {' · '}
        <a href={ins.sources[0].url} target="_blank" rel="noreferrer">{ins.name} exclusions</a>
        {checked ? ` · checked ${checked}` : ''}
        {ctx.feed.error ? ' · last check failed, showing stored advice' : ''}
        . Not insurance advice: {ins.name}'s policy wording decides.
      </p>
      {places.length > 0 && alertCount === 0 && <p className="small muted">No US embassy or UK FCDO alerts here in the last 14 days.</p>}
    </div>
  );
}

/** Alerts near the places first (⚠), then country-wide ones (ℹ), each listed once. */
function alertItems(all: TravelAlert[], places: AlertPoint[]): { a: TravelAlert; near: boolean }[] {
  const near = new Map<string, TravelAlert>();
  const country = new Map<string, TravelAlert>();
  for (const p of places) {
    const at = alertsAt(all, p);
    for (const a of at.near) near.set(a.id, a);
    for (const a of at.country) country.set(a.id, a);
  }
  for (const id of near.keys()) country.delete(id);
  return [...[...near.values()].map((a) => ({ a, near: true })), ...[...country.values()].map((a) => ({ a, near: false }))];
}

/**
 * Recent alerts from US embassies and UK FCDO, as a slim full-width strip under a page's summary
 * row (so the Safety card stays the same height as its neighbours). Nothing when there are none.
 */
export function AlertStrip({ places }: { places: AlertPoint[] }) {
  const items = alertItems(useAlerts(), places);
  const [more, setMore] = useState(false);
  if (!items.length) return null;
  const shown = more ? items : items.slice(0, 3);
  return (
    <section className="alert-strip" aria-label="Recent alerts">
      <p className="small alert-strip-head">
        <strong>Recent alerts</strong> <Badge tone="warning">{items.length} active</Badge>
      </p>
      <ul className="alert-list">
        {shown.map(({ a, near: isNear }) => (
          <li key={a.id} className={isNear ? 'near' : undefined}>
            <span className="alert-icon" aria-hidden>{isNear ? '⚠' : 'ℹ'}</span>
            <span>
              <span className="small">
                {placesLabel(a) && <strong>{placesLabel(a)}</strong>}
                {a.summary}
              </span>
              <span className="small muted alert-meta">
                {SOURCE_LABEL[a.source]} · {KIND_LABEL[a.kind]} · {agoLabel(a.issued)} ·{' '}
                <a href={a.url} target="_blank" rel="noreferrer">Read ↗</a>
              </span>
            </span>
          </li>
        ))}
      </ul>
      {items.length > shown.length && (
        <button type="button" className="link-button small" onClick={() => setMore(true)}>
          Show all {items.length}
        </button>
      )}
      <p className="small muted alert-strip-note">From other governments' advice. It doesn't change MFA's level, insurance cover or the weather rating.</p>
    </section>
  );
}

/** "⚠ Recent alert" chip with the newest city-matched alert, for map popovers. */
export function AlertLine({ cc, lat, lon }: AlertPoint) {
  const all = useAlerts();
  const a = alertsAt(all, { cc, lat, lon }).near[0];
  if (!a) return null;
  return (
    <div className="popover-safety">
      <div className="chips">
        <Badge tone="warning">Recent alert</Badge>
      </div>
      <p className="small">
        {placesLabel(a) && <strong>{placesLabel(a)}</strong>}
        {a.summary} ({SOURCE_LABEL[a.source]}, {agoLabel(a.issued)}) ·{' '}
        <a href={a.url} target="_blank" rel="noreferrer">Read ↗</a>
      </p>
    </div>
  );
}

/**
 * The safety block at the top of a map popover: MFA and insurer chips, then why (MFA's reason
 * with its date and a link, and the insurer's rule) in a line each. A city or destination is
 * checked at its own location (with insurer cover); a country lists where its advice applies.
 */
export function AdvisoryLine({ ctx, cc, lat, lon, country = false }: { ctx: AdvisoryContext; cc: string; lat: number; lon: number; country?: boolean }) {
  if (country) {
    const page = ctx.feed.pages.find((p) => (p.cc ?? ctx.zones[p.slug]?.cc) === cc);
    if (!page) return null;
    const cur = ctx.zones[page.slug];
    const zones = cur && cur.asOf === page.mfaDate ? cur.zones : null;
    const top = zones ? [...zones].sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level])[0] : null;
    const level: PageLevel = top?.level ?? page.level;
    const where = zones ? (zones.some((z) => z.area.kind === 'country' && z.level === level) ? '' : zones.filter((z) => z.level === level).map((z) => z.label).join('; ')) : page.scope === 'regional' ? 'parts of the country' : '';
    // Insurer cover follows the advice: one verdict when it covers the whole country, otherwise
    // it depends on where in the country you go.
    const whole = !where;
    const cover = whole ? safetyAt(ctx, { cc, lat, lon }).coverage : null;
    const fwd = cover && cover.status !== 'covered' && cover.detail ? insurerReason(cover.detail, ctx.insurer.name) : null;
    return (
      <div className="popover-safety">
        <div className="chips">
          <Badge tone={levelTone[level]}>MFA: {LEVEL_LABEL[level].toLowerCase()}</Badge>
          {cover ? (
            <Badge tone={coverageTone[cover.status]}>{cover.short}</Badge>
          ) : (
            LEVEL_RANK[level] >= LEVEL_RANK.nonEssential && <Badge tone="warning">{ctx.insurer.name}: varies by area</Badge>
          )}
        </div>
        <ReasonLine page={page} where={where} />
        {fwd && <p className="small secondary">{fwd}</p>}
      </div>
    );
  }
  const { advisory, coverage } = safetyAt(ctx, { cc, lat, lon });
  if (advisory.level === 'none' && coverage.status === 'covered') return null;
  const hit = advisory.hits[0];
  const fwd = coverage.status !== 'covered' && coverage.detail ? insurerReason(coverage.detail, ctx.insurer.name) : null;
  return (
    <div className="popover-safety">
      <div className="chips">
        {advisory.level !== 'none' && <Badge tone={levelTone[advisory.level]}>MFA: {LEVEL_LABEL[advisory.level].toLowerCase()}</Badge>}
        <Badge tone={coverageTone[coverage.status]}>{coverage.short}</Badge>
      </div>
      {hit && <ReasonLine page={hit.page} where={hit.fallback || hit.label === hit.page.title ? '' : hit.label} />}
      {fwd && <p className="small secondary">{fwd}</p>}
    </div>
  );
}

/** "Continuing uncertain security situation (MFA, 10 Jun 2026) · Read MFA advice ↗". */
function ReasonLine({ page, where }: { page: MfaPage; where: string }) {
  const reason = mfaReason(page);
  return (
    <p className="small">
      {where && <strong>{where}: </strong>}
      {reason ?? 'See MFA’s advice'}
      {page.mfaDate ? ` (MFA, ${formatDate(page.mfaDate)})` : ''}
      {' · '}
      <a href={pageUrl(page.slug)} target="_blank" rel="noreferrer">Read MFA advice ↗</a>
    </p>
  );
}
