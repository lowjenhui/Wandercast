import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AdvisoryStore, parseMfaList, parseMfaPage } from './advisories';
import { openDb } from './db';
import { MFA_BASE } from '../src/lib/advisory';

// The list page embeds each country as escaped JSON in the Next.js payload.
const item = (slug: string, title: string, date: string | null, tag: string) =>
  `{\\"id\\":\\"/travelling-overseas/travel-advisories-notices-and-visa-information/${slug}\\",\\"date\\":\\"${date ? `$D${date}T00:00:00.000Z` : '$undefined'}\\",\\"plaintextTags\\":[{\\"id\\":\\"f73e\\",\\"category\\":\\"Category\\",\\"selected\\":[\\"${tag}\\"]}],\\"title\\":\\"${title}\\",\\"description\\":\\"…\\"}`;

function listHtml(items: string[]) {
  // The real list has 191 countries; pad with plain pages so the sanity check passes.
  const pad = Array.from({ length: 120 }, (_, i) => item(`place-${i}`, `Place ${i}`, null, 'Travel page'));
  return `<html><main>…</main><script>self.__next_f.push([1,"${[...items, ...pad].join(',')}"])</script></html>`;
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const pageHtml = (body: string) =>
  `<html><main><p>Travel page with travel advisory</p><p>Use our advice together with your own research from reputable sources to plan your trip.</p>${body}<h3>Entry and Exit</h3><p>Visa rules…</p></main><footer>15 MB of other things</footer></html>`;

describe('MFA parsing', () => {
  it('reads every country, its category and date from the list', () => {
    const list = parseMfaList(listHtml([item('saudi-arabia', 'Saudi Arabia', '2026-10-13', 'Travel page with travel advisory'), item('peru', 'Peru', '2026-09-21', 'Travel page with travel notice')]));
    expect(list.find((l) => l.slug === 'saudi-arabia')).toEqual({ slug: 'saudi-arabia', title: 'Saudi Arabia', date: '2026-10-13', category: 'advisory' });
    expect(list.find((l) => l.slug === 'peru')?.category).toBe('notice');
    expect(list.find((l) => l.slug === 'place-0')).toEqual({ slug: 'place-0', title: 'Place 0', date: null, category: 'page' });
  });

  it('keeps only the advisory block of a country page', () => {
    const p = parseMfaPage(pageHtml('<h2>Travel Advisory for India</h2><p>Last updated on 23 July 2026</p><p>Singaporeans are advised to defer non-essential travel to Manipur.</p>'));
    expect(p.heading).toBe('Travel Advisory for India');
    expect(p.text).toContain('defer non-essential travel to Manipur');
    expect(p.text).not.toContain('Visa rules');
    // The heading and date don't run into the first sentence.
    expect(p.text.startsWith('Singaporeans are advised')).toBe(true);
  });
});

describe('AdvisoryStore', () => {
  it('fetches flagged pages, re-reads only changed ones, and records history', async () => {
    const db = openDb(':memory:');
    let list = listHtml([item('saudi-arabia', 'Saudi Arabia', '2026-10-13', 'Travel page with travel advisory'), item('japan', 'Japan', null, 'Travel page')]);
    const fetched: string[] = [];
    const pages: Record<string, string> = {
      'saudi-arabia': pageHtml('<p>Singaporeans are advised to defer all travel to Saudi Arabia.</p>'),
      japan: pageHtml('<p>Nothing special.</p>'),
    };
    const fetchText = async (url: string) => {
      fetched.push(url);
      if (url === MFA_BASE) return list;
      return pages[url.slice(MFA_BASE.length, -1)] ?? '';
    };
    const store = new AdvisoryStore(db, ROOT, fetchText, 0);
    await store.ensure();
    const saudi = store.feed().pages.find((p) => p.slug === 'saudi-arabia')!;
    expect(saudi).toMatchObject({ level: 'all', scope: 'country', cc: 'SA', mfaDate: '2026-10-13' });
    expect(store.feed().pages.map((p) => p.slug)).toEqual(['saudi-arabia']); // plain pages aren't sent
    expect(fetched.filter((u) => u !== MFA_BASE)).toHaveLength(1); // Japan's plain page isn't read

    // Same date: not re-read.
    await store.ensure(true);
    expect(fetched.filter((u) => u !== MFA_BASE)).toHaveLength(1);

    // Japan gains a notice: read once, and its earlier "none" row stays in the history.
    list = listHtml([item('saudi-arabia', 'Saudi Arabia', '2026-10-13', 'Travel page with travel advisory'), item('japan', 'Japan', '2026-10-20', 'Travel page with travel notice')]);
    pages.japan = pageHtml('<p>Singaporeans are advised to exercise caution near Mount Fuji.</p>');
    await store.ensure(true);
    expect(store.feed().pages.find((p) => p.slug === 'japan')?.level).toBe('caution');
    expect(store.history().filter((h) => h.slug === 'japan').map((h) => h.level)).toEqual(['none', 'caution']);

    // Saudi Arabia drops off the advisory list: its advice is withdrawn.
    list = listHtml([item('saudi-arabia', 'Saudi Arabia', null, 'Travel page'), item('japan', 'Japan', '2026-10-20', 'Travel page with travel notice')]);
    await store.ensure(true);
    expect(store.feed().pages.map((p) => p.slug)).toEqual(['japan']);
    expect(store.history().filter((h) => h.slug === 'saudi-arabia').map((h) => h.level)).toEqual(['all', 'none']);
  });

  it('keeps serving stored advice when MFA is unreachable', async () => {
    const db = openDb(':memory:');
    let fail = false;
    const list = listHtml([item('myanmar', 'Myanmar', '2026-06-10', 'Travel page with travel advisory')]);
    const fetchText = async (url: string) => {
      if (fail) throw new Error('network down');
      return url === MFA_BASE ? list : pageHtml('<p>Singaporeans are strongly advised to defer all travel to Myanmar.</p>');
    };
    const store = new AdvisoryStore(db, ROOT, fetchText, 0);
    await store.ensure();
    fail = true;
    await store.ensure(true);
    expect(store.feed()).toMatchObject({ error: 'network down', pages: [{ slug: 'myanmar', level: 'all' }] });
  });
});
