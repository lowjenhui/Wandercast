// SGD exchange rates for page subtitles, from the local server (/api/fx, refreshed daily).

import { useEffect, useState } from 'react';
import { fxText, type FxResponse } from '../lib/fx';
import { getJson } from './http';

const cache = new Map<string, Promise<FxResponse>>();

export function getFx(ccs: string[]): Promise<FxResponse> {
  const key = [...new Set(ccs.map((c) => c.toUpperCase()))].sort().join(',');
  let p = cache.get(key);
  if (!p) {
    p = getJson<FxResponse>(`/api/fx?cc=${key}`, {}, 20_000);
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}

/** Subtitle text for each currency of these countries, e.g. ["S$1 = ฿25.9 today"]; [] for Singapore. */
export function useFxLines(ccs: string[]): string[] {
  const key = ccs.join(',');
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    setLines([]);
    if (!ccs.length) return;
    getFx(ccs)
      .then((r) => live && setLines(r.rates.map((x) => `${fxText(x)} today`)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return lines;
}
