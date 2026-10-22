// Name search for the map finder: exact names first, then names starting with the query, then
// names with a word starting with it. Ties go to the item's rank (lower first).

export interface SearchItem<T> {
  name: string;
  /** Lower ranks first among equally good matches. */
  rank: number;
  value: T;
}

/** Lower-cased, accents removed ("Đà Nẵng" → "da nang"). */
export function normalise(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().trim();
}

/** 0 exact, 1 prefix, 2 word prefix, null no match; `q` must already be normalised. */
export function matchScore(name: string, q: string): number | null {
  const n = normalise(name);
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (n.split(/[\s\-'’(),/]+/).some((w) => w.startsWith(q))) return 2;
  return null;
}

export function searchPlaces<T>(items: SearchItem<T>[], query: string, limit: number): T[] {
  const q = normalise(query);
  if (q.length < 2) return [];
  const hits: { score: number; item: SearchItem<T> }[] = [];
  for (const item of items) {
    const score = matchScore(item.name, q);
    if (score !== null) hits.push({ score, item });
  }
  hits.sort((a, b) => a.score - b.score || a.item.rank - b.item.rank);
  return hits.slice(0, limit).map((h) => h.item.value);
}
