import { geoArea, geoCircle, geoNaturalEarth1, geoPath } from 'd3-geo';
import { select } from 'd3-selection';
import 'd3-transition';
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import {
  aqiCategory,
  classifyCurrent,
  describeWeatherCode,
  detectPhenomena,
  type Classified,
  type ConditionClass,
  type Phenomenon,
} from '../lib/currentConditions';
import type { MonsoonRegime } from '../data/monsoons';
import { formatShortDate, monthName, monthsInRange, todayISO } from '../lib/dates';
import { loadRainfall, loadRainfallAsia, NestedRain, rainSourceLabel, tripMonthWeights, type RainField, type RainGrid } from '../lib/rainfall';
import { rateOutlook, RATING_CLASS } from '../lib/outlook';
import type { Suitability } from '../lib/weatherAnalysis';
import { services } from '../services';
import { loadCities, loadCountryPoints, type CityPoint, type CountryPoint } from '../services/currentWeather';
import { datedRouteNotes, destinationId, directAirlinesOn, ferryText, landOnly, landText, loadDestinations, viaText, loadDirectCities, loadFerryDestinations, type Destination, type DirectCity, type FerryDestination } from '../services/destinations';
import { haversineKm } from '../lib/geo';
import { searchPlaces, type SearchItem } from '../lib/placeSearch';
import { GDACS_SOURCE, type Hazard } from '../services/hazards';
import { RECENT_RAIN_LABEL, timesNormal, type RecentRain } from '../lib/recentRain';
import { getRecentRainAll, nearestRecentRain } from '../services/recentRain';
import { describePlan, getOutlookStore, type OutlookPlan, type TripOutlook } from '../services/tripOutlook';
import { PointStore, type PointData, type PointRequest } from '../services/weatherStore';
import type { Place, SeasonalRisk } from '../types';
import { CacheStatus } from './CacheStatus';
import { MapFinder, type FinderRow, type FoundPlace } from './MapFinder';
import { OutlookDetails } from './OutlookDetails';
import { MonsoonFootprints, MonsoonLabels, MonthControls, NearbyRain, RainDetails, RainLegend, useRainRaster, ZoneSides, type RasterView } from './RainLayer';
import { nearbyPlaces, type NearbyCandidate } from '../lib/nearbyRain';
import { Badge, Notice, type Tone } from './ui';
import { AdvisoryLine, AlertLine } from './SafetyCard';
import { onWanderList, useWanderList } from '../services/wander';
import { regionMatches, type PageLevel, type Zone } from '../lib/advisory';
import { useAdvisories } from '../services/advisories';
import { loadClimateZones, regimesForCountry, regimeWhere, zoneAt, zoneFor, type ClimateZone, type ClimateZones } from '../lib/climateZones';

const W = 960;
const H = 600;
const SINGAPORE: [number, number] = [103.82, 1.35];
const HOME_BOUNDS: [[number, number], [number, number]] = [[92, 23], [128, -11]]; // SE Asia
const MAX_CITY_DOTS = 260;
const DIRECT_DEDUPE_KM = 25;
const MIN_DOT_GAP = 16; // px in viewBox units

/** Marker outline for places reached only overland: dash-dot, distinct from ferry (dashed) and via (dotted). */
const LAND_DASH = '4 1.5 1 1.5';

const LABEL: Record<ConditionClass, string> = { good: 'Good', average: 'Average', bad: 'Bad' };
const TONE: Record<ConditionClass, Tone> = { good: 'good', average: 'warning', bad: 'critical' };

export type MapView = 'now' | 'dates';

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
/** Below this map width the pinned popover docks as a panel just under the map. */
const DOCK_BELOW_PX = 600;

/** A city on the live map; direct-flight cities from SIN come first and are always eligible. */
type MapCity = CityPoint & { direct?: DirectCity; ferry?: FerryDestination; via?: Destination; /** Overland from Singapore: the place itself when land-only, or the overland option of a flight, ferry or via place. */ land?: Destination; /** A plain city within 10 km of a gateway place (shown only when gateways are hidden). */ nearVia?: boolean };

interface StaticData {
  shapes: Feature<Geometry, { name: string }>[];
  countries: CountryPoint[];
  /** Direct-flight cities first, then GeoNames cities by weight (minus duplicates of direct ones). */
  cities: MapCity[];
  destinations: Destination[];
  directSource: string;
}

type Target =
  | { type: 'country'; point: CountryPoint }
  | { type: 'city'; point: CityPoint }
  | { type: 'dest'; dest: Destination }
  | { type: 'hazard'; hazard: Hazard }
  | { type: 'nodata'; name: string }
  /** A climate zone of a country with more than one rainy season (Sri Lanka's east…). */
  | { type: 'zone'; zone: ClimateZone; country: CountryPoint }
  /** A place picked in the finder (or carried over from another view), shown in the form each view needs. */
  | { type: 'place'; place: FoundPlace };

/** A pinned popover: what was clicked (none over open sea in rainfall mode) and where. */
interface Pin {
  target: Target | null;
  lat: number;
  lon: number;
  regime: MonsoonRegime | null;
}

interface Evaluated {
  data: PointData;
  cls: Classified;
}

interface DatesEval {
  outlook: TripOutlook | null | undefined;
  /** Set while the place's history isn't stored yet. */
  pending?: TripOutlook;
  suitability: Suitability | null;
  cls: ConditionClass | null;
  risks: SeasonalRisk[];
}

// Placeholder so hooks can subscribe before travel dates exist.
const EMPTY_STORE = new PointStore<TripOutlook>({ fetchBatch: async (p) => p.map(() => null), costPerPoint: 1, batchSize: 1, ttlMs: 1 });

type CountryShape = Feature<Geometry, { name: string }>;

/** A country outline at one resolution, with its projected bounding box for culling. */
interface ShapeEntry {
  f: CountryShape;
  id: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// Outline detail by zoom: 110m for the world view, 50m regionally (includes islands such as
// Batam, Bintan, Karimun and Langkawi), 10m for close-up coastlines. Detailed sets load lazily.
const DETAIL_50M_K = 2.5;
const DETAIL_10M_K = 16;

function toEntries(shapes: CountryShape[], path: ReturnType<typeof geoPath>): ShapeEntry[] {
  return shapes.map((f) => {
    const [[x0, y0], [x1, y1]] = path.bounds(f);
    return { f, id: String(f.id), x0, y0, x1, y1 };
  });
}

/**
 * d3 treats a polygon whose rings run the "wrong" way as covering the rest of the globe.
 * A few features in the detailed datasets (e.g. the Maldives at 10m) are wound that way and
 * would paint over the whole map, so any polygon larger than a hemisphere is reversed.
 */
export function fixWinding(f: CountryShape): CountryShape {
  const g = f.geometry;
  if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) return f;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  let changed = false;
  const fixed = polys.map((rings) => {
    if (geoArea({ type: 'Polygon', coordinates: rings }) <= 2 * Math.PI) return rings;
    changed = true;
    return rings.map((ring) => [...ring].reverse());
  });
  if (!changed) return f;
  return { ...f, geometry: g.type === 'Polygon' ? { type: 'Polygon', coordinates: fixed[0] } : { type: 'MultiPolygon', coordinates: fixed } };
}

async function loadShapes(res: '50m' | '10m'): Promise<CountryShape[]> {
  const mod = res === '50m' ? await import('world-atlas/countries-50m.json') : await import('world-atlas/countries-10m.json');
  const topo = mod.default as unknown as Topology<{ countries: GeometryCollection<{ name: string }> }>;
  return (feature(topo, topo.objects.countries) as FeatureCollection<Geometry, { name: string }>).features.map(fixWinding);
}

/** Minimum (weighted) population of cities shown at a zoom level (none when zoomed out). */
function minPopulation(k: number): number | null {
  if (k < 2) return null;
  if (k < 3.5) return 2_000_000;
  if (k < 6) return 700_000;
  if (k < 10) return 250_000;
  if (k < 18) return 80_000;
  return 0;
}

const countryId = (p: CountryPoint) => `c:${p.ccn3}`;
/** Stable id for a found place with no marker of its own. */
const foundId = (p: { lat: number; lon: number }) => `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;

function evaluate(data: PointData | null | undefined, hazards: Hazard[], lat: number, lon: number): Evaluated | null {
  if (!data?.weather) return null;
  return { data, cls: classifyCurrent(data.weather, data.aq, hazards, { lat, lon }) };
}

function phenomenaFor(ev: Evaluated, hazards: Hazard[], lat: number, lon: number, cc: string): Phenomenon[] {
  const month = Number(ev.data.weather!.time.slice(5, 7));
  const place = { countryCode: cc, latitude: lat, longitude: lon } as Place;
  return detectPhenomena({
    weather: ev.data.weather!,
    aq: ev.data.aq,
    hazards,
    lat,
    lon,
    seasonal: services.risks.risksFor(place, [month]),
    cc,
  });
}

function evaluateDates(raw: TripOutlook | null | undefined, cc: string, lat: number, lon: number, months: number[]): DatesEval {
  const risks = services.risks.risksFor({ countryCode: cc, latitude: lat, longitude: lon } as Place, months);
  // Not stored yet (fewer than 3 of 5 years): shown as "no data" until the background fills it.
  const o = raw?.pending ? null : raw;
  const suitability = o ? rateOutlook(o, risks) : null;
  return { outlook: o, pending: raw?.pending ? raw : undefined, suitability, cls: suitability ? RATING_CLASS[suitability.rating] : null, risks };
}

function shortBasis(plan: OutlookPlan | undefined): string {
  if (!plan) return '';
  if (plan.basis === 'forecast') return plan.coveredDays < plan.tripDays ? `Forecast (${plan.coveredDays} of ${plan.tripDays} days)` : 'Forecast';
  if (plan.basis === 'typical') {
    const ys = plan.windows.map((w) => w.year);
    return `Typical, ${Math.min(...ys)}–${Math.max(...ys)}`;
  }
  return '';
}

export function WorldWeatherMap({
  start,
  end,
  initialView = 'now',
  focus,
  onAnalyse,
  onWhenToGo,
  onSelectDest,
  highlight,
  focusRequest,
  showVia = false,
  onShowViaChange,
  showAdvisories = true,
  onShowAdvisoriesChange,
  datesLabel,
}: {
  start?: string;
  end?: string;
  initialView?: MapView;
  /** A location to centre on and mark (e.g. the analysed destination). */
  focus?: { lat: number; lon: number; name: string };
  /** Analyse a destination for the map's dates. */
  onAnalyse?: (d: Destination, dates: { start: string; end: string }) => void;
  /** Opens Sunny windows (best dates over the next 12 months) for a destination. */
  onWhenToGo?: (d: Destination) => void;
  /** The destination pinned on the map changed (null when closed or not a destination). */
  onSelectDest?: (d: Destination | null) => void;
  /** A destination to ring on the map (e.g. hovered in the suggestions list). */
  highlight?: Destination | null;
  /** Zoom to and select this destination (e.g. clicked in the suggestions list). */
  focusRequest?: { dest: Destination; nonce: number } | null;
  /** Show places reached via a direct-flight city (Hoi An via Da Nang…). */
  showVia?: boolean;
  /** Name for the dates tab, e.g. a daydream date's label. */
  datesLabel?: string;
  onShowViaChange?: (v: boolean) => void;
  /** Hatch areas with an MFA travel advisory or notice (on by default). */
  showAdvisories?: boolean;
  onShowAdvisoriesChange?: (v: boolean) => void;
}) {
  const [stat, setStat] = useState<StaticData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hazards, setHazards] = useState<Hazard[]>([]);
  const wander = useWanderList();
  const [hazardError, setHazardError] = useState<string | null>(null);
  // Climate zones (Sri Lanka's two monsoon sides…); without them countries are coloured whole.
  const [climate, setClimate] = useState<ClimateZones | null>(null);
  const [t, setT] = useState<ZoomTransform>(zoomIdentity);
  const [hover, setHover] = useState<{ target: Target; x: number; y: number } | null>(null);
  // The clicked place, anchored where it was clicked; shown as a popover on the map.
  const [pin, setPin] = useState<Pin | null>(null);
  const [filter, setFilter] = useState<ConditionClass | null>(null);
  const datesValid = Boolean(start && end && start <= end);
  // Map type, and each type's own tab (remembered when switching back and forth).
  const [kind, setKind] = useState<'ratings' | 'rainfall'>('ratings');
  const [view, setView] = useState<MapView>(initialView === 'dates' && datesValid ? 'dates' : 'now');
  const [rainTab, setRainTab] = useState<'travel' | 'monthly'>('travel');
  const svgRef = useRef<SVGSVGElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const [zoomHint, setZoomHint] = useState(false);
  const zoomHintShown = useRef(false);
  // Rendered map size in px: the popover is placed in px and docks below DOCK_BELOW_PX.
  const [box, setBox] = useState({ w: 0, h: 0 });
  const docked = box.w > 0 && box.w < DOCK_BELOW_PX;
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: (e.contentRect.width * H) / W }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Follow the parent's preferred view (e.g. switch to travel dates once a search runs).
  useEffect(() => {
    setView(initialView === 'dates' && datesValid ? 'dates' : 'now');
  }, [initialView, datesValid, start, end]);

  const store = services.current;
  const version = useSyncExternalStore(store.subscribe, store.getVersion);
  // "Right now" shows what's stored; it only calls the weather API when the user presses Reload.
  const [reloadKey, setReloadKey] = useState(0);
  const reloadNow = () => {
    store.reload();
    setReloadKey((k) => k + 1);
  };
  const outlook = useMemo(() => (datesValid ? getOutlookStore(start!, end!) : null), [datesValid, start, end]);
  const oStore = outlook?.store ?? EMPTY_STORE;
  const oVersion = useSyncExternalStore(oStore.subscribe, oStore.getVersion);
  // Rainfall & monsoons: your travel months, or month by month. Bundled normals, no API.
  const rainMode = kind === 'rainfall';
  const monsoon = rainMode && (rainTab === 'monthly' || !datesValid);
  const dates = !rainMode && view === 'dates' && outlook !== null;
  const nowView = !rainMode && view === 'now';
  // The pinned place stays when switching views, in the form each view shows (a city, a
  // destination or a country); rainfall pins any spot, so it keeps the pin as it is.
  useEffect(() => {
    setPin((p) => {
      if (!p || rainMode) return p;
      const target = p.target && placeFor(p.target);
      return target ? { ...p, target, regime: null } : null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, view, rainTab, start, end]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => onSelectDest?.(pin?.target ? destFor(pin.target) : null), [pin, onSelectDest]);
  const [rain, setRain] = useState<RainGrid | null>(null);
  const [rainError, setRainError] = useState<string | null>(null);
  useEffect(() => {
    if (rainMode && !rain) loadRainfall().then(setRain, (e: Error) => setRainError(e.message));
  }, [rainMode, rain]);
  // The finer Asia grid loads after the global one; without it the global grid is used everywhere.
  const [rainAsia, setRainAsia] = useState<RainGrid | null>(null);
  useEffect(() => {
    if (rainMode && rain && !rainAsia) loadRainfallAsia().then(setRainAsia, () => undefined);
  }, [rainMode, rain, rainAsia]);
  const tripWeights = useMemo(() => (datesValid ? tripMonthWeights(start!, end!) : null), [datesValid, start, end]);
  const travelMonths = useMemo(() => (tripWeights ? [...tripWeights.keys()] : []), [tripWeights]);
  const [month, setMonth] = useState(() => Number(todayISO().slice(5, 7)));
  // Open on the travel month when dates are set or change.
  useEffect(() => {
    if (travelMonths.length) setMonth(travelMonths[0]);
  }, [travelMonths]);
  const rainWeights = useMemo(() => (monsoon ? new Map([[month, 1]]) : rainMode ? tripWeights : null), [monsoon, rainMode, month, tripWeights]);
  const rainMonths = monsoon ? [month] : travelMonths;
  const [rainHover, setRainHover] = useState<{ lat: number; lon: number; x: number; y: number } | null>(null);
  const [regimeHover, setRegimeHover] = useState<MonsoonRegime | null>(null);
  useEffect(() => setRainHover(null), [rainMode]);
  const tripMonths = useMemo(() => (datesValid ? monthsInRange(start!, end!) : []), [datesValid, start, end]);
  const status = dates ? oStore.getStatus() : store.getStatus();

  // Static geometry, countries, cities and destinations.
  useEffect(() => {
    let alive = true;
    Promise.all([import('world-atlas/countries-110m.json'), loadCountryPoints(), loadCities(), loadDestinations(), loadDirectCities(), loadFerryDestinations()])
      .then(([topoModule, countries, cities, destinations, direct, ferries]) => {
        const topo = topoModule.default as unknown as Topology<{ countries: GeometryCollection<{ name: string }> }>;
        const shapes = (feature(topo, topo.objects.countries) as FeatureCollection<Geometry, { name: string }>).features;
        const directCities: MapCity[] = direct.cities.map((c) => ({
          id: `dc:${c.code}`,
          name: c.name,
          cc: c.cc,
          lat: c.lat,
          lon: c.lon,
          population: 0,
          weight: Number.POSITIVE_INFINITY,
          direct: c,
        }));
        // Ferry destinations (Batam, Bintan, Desaru…) are always shown like direct-flight cities.
        const ferryCities: MapCity[] = ferries.destinations.map((f) => ({
          id: `fc:${f.code}`,
          name: f.name,
          cc: f.cc,
          lat: f.lat,
          lon: f.lon,
          population: 0,
          weight: Number.POSITIVE_INFINITY,
          ferry: f,
        }));
        // Places reached via a direct-flight city (Hoi An via Da Nang…) are also always shown;
        // they give way to the gateway when zoomed out and separate as you zoom in.
        const viaCities: MapCity[] = destinations
          .filter((d) => d.via)
          .map((d) => ({ id: destinationId(d), name: d.name, cc: d.cc, lat: d.lat, lon: d.lon, population: 0, weight: Number.POSITIVE_INFINITY, via: d }));
        // Overland places with no flight or ferry of their own (Johor Bahru, Muar…) are always
        // shown too; places that also have a flight keep their marker and gain the overland option.
        const landDests = destinations.filter((d) => d.land);
        const landCities: MapCity[] = landDests
          .filter(landOnly)
          .map((d) => ({ id: `lc:${d.code}`, name: d.name, cc: d.cc, lat: d.lat, lon: d.lon, population: 0, weight: Number.POSITIVE_INFINITY, land: d }));
        const withLand = (c: MapCity): MapCity => {
          const d = landDests.find((x) => !landOnly(x) && haversineKm(x.lat, x.lon, c.lat, c.lon) < 25);
          return d ? { ...c, land: d } : c;
        };
        const reachable = [...direct.cities, ...ferries.destinations, ...landCities];
        const others: MapCity[] = cities
          .filter((c) => !reachable.some((d) => haversineKm(d.lat, d.lon, c.lat, c.lon) < DIRECT_DEDUPE_KM))
          .map((c) => (viaCities.some((d) => haversineKm(d.lat, d.lon, c.lat, c.lon) < 10) ? { ...c, nearVia: true } : c));
        if (alive) setStat({ shapes, countries, cities: [...ferryCities.map(withLand), ...landCities, ...directCities.map(withLand), ...viaCities.map(withLand), ...others], destinations, directSource: direct.source });
      })
      .catch((e: Error) => alive && setLoadError(e.message));
    loadClimateZones().then((z) => alive && setClimate(z), () => undefined);
    services.hazards
      .getActive()
      .then((h) => alive && setHazards(h))
      .catch((e: Error) => alive && setHazardError(e.message));
    return () => {
      alive = false;
    };
  }, []);

  // Recent rain vs normal (stored data only): a blue ring on places that have been unusually wet.
  const [recent, setRecent] = useState<RecentRain[]>([]);
  useEffect(() => {
    if (!nowView) return;
    let alive = true;
    getRecentRainAll().then((r) => alive && setRecent(r), () => undefined);
    return () => {
      alive = false;
    };
  }, [nowView, reloadKey]);
  const recentOf = useMemo(() => {
    const cache = new Map<string, RecentRain | null>();
    return (id: string, lat: number, lon: number) => {
      if (!cache.has(id)) cache.set(id, nearestRecentRain(recent, lat, lon));
      return cache.get(id)!;
    };
  }, [recent]);

  const projection = useMemo(() => geoNaturalEarth1().fitExtent([[4, 4], [W - 4, H - 4]], { type: 'Sphere' }), []);
  // The rainfall raster covers the whole map when zoomed out. From regional zoom it covers the
  // view (plus a margin, updated once panning or zooming pauses) and uses the finer Asia grid.
  const [rainView, setRainView] = useState<RasterView>({ x0: 0, y0: 0, x1: W, y1: H });
  useEffect(() => {
    if (!rainMode) return;
    const id = window.setTimeout(() => {
      if (t.k < DETAIL_50M_K) return setRainView((v) => (v.x0 === 0 && v.x1 === W && v.y0 === 0 && v.y1 === H ? v : { x0: 0, y0: 0, x1: W, y1: H }));
      const [x0, y0] = t.invert([-W * 0.1, -H * 0.1]);
      const [x1, y1] = t.invert([W * 1.1, H * 1.1]);
      setRainView({ x0, y0, x1, y1 });
    }, 250);
    return () => window.clearTimeout(id);
  }, [t, rainMode]);
  const rainZoomed = rainView.x1 - rainView.x0 < W;
  const rainField: RainField | null = useMemo(() => (rain && rainAsia && rainZoomed ? new NestedRain(rain, rainAsia) : rain), [rain, rainAsia, rainZoomed]);
  const raster = useRainRaster(rainField, rainWeights, projection, rainView, Math.round(W / 2), Math.round(H / 2));
  const path = useMemo(() => geoPath(projection), [projection]);

  const homeTransform = useMemo(() => {
    const [x0, y0] = projection(HOME_BOUNDS[0])!;
    const [x1, y1] = projection(HOME_BOUNDS[1])!;
    const k = Math.min(W / (x1 - x0), H / (y1 - y0)) * 0.95;
    const [sx, sy] = projection(SINGAPORE)!;
    return zoomIdentity.translate(W / 2 - k * sx, H / 2 - k * sy).scale(k);
  }, [projection]);

  const focusTransform = useMemo(() => {
    if (!focus) return homeTransform;
    const [fx, fy] = projection([focus.lon, focus.lat])!;
    const k = homeTransform.k;
    return zoomIdentity.translate(W / 2 - k * fx, H / 2 - k * fy).scale(k);
  }, [focus, projection, homeTransform]);

  // Zoom & pan (wheel, drag, pinch) via d3-zoom.
  useEffect(() => {
    if (!stat || !svgRef.current) return;
    const z = zoom<SVGSVGElement, unknown>()
      // Plain wheel scrolling scrolls the page or pane; ⌘/Ctrl + wheel (and trackpad pinch, which
      // arrives as Ctrl + wheel) zooms. Dragging still pans; double-click and the buttons zoom.
      .filter((e: MouseEvent | WheelEvent) => (e.type === 'wheel' ? e.ctrlKey || e.metaKey : !e.ctrlKey && !e.button))
      .scaleExtent([1, 60])
      .translateExtent([[0, 0], [W, H]])
      .on('start', () => setHover(null))
      .on('zoom', (e: { transform: ZoomTransform }) => setT(e.transform));
    zoomRef.current = z;
    const sel = select(svgRef.current).call(z);
    // The first plain scroll over the map shows how to zoom instead.
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey || zoomHintShown.current) return;
      zoomHintShown.current = true;
      setZoomHint(true);
      window.setTimeout(() => setZoomHint(false), 1800);
    };
    svgRef.current.addEventListener('wheel', onWheel, { passive: true });
    const svgEl = svgRef.current;
    sel.call(z.transform, focusTransform);
    return () => {
      svgEl.removeEventListener('wheel', onWheel);
      sel.on('.zoom', null);
    };
  }, [stat, focusTransform]);

  const zoomTo = (target: ZoomTransform | number) => {
    if (!svgRef.current || !zoomRef.current) return;
    const sel = select(svgRef.current).transition().duration(450);
    if (typeof target === 'number') sel.call(zoomRef.current.scaleBy, target);
    else sel.call(zoomRef.current.transform, target);
  };

  /** Pans (optionally zooms) so a place sits in the middle of the map, and brings the map into view. */
  const centreOn = (lon: number, lat: number, k = t.k) => {
    const xy = projection([lon, lat]);
    if (!xy) return;
    zoomTo(zoomIdentity.translate(W / 2 - k * xy[0], H / 2 - k * xy[1]).scale(k));
    boxRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  // Zoom to a destination chosen outside the map (suggestion list) and show its details.
  useEffect(() => {
    if (!focusRequest || !stat || !svgRef.current || !zoomRef.current) return;
    centreOn(focusRequest.dest.lon, focusRequest.dest.lat, Math.max(t.k, 8));
    setPin({ target: { type: 'dest', dest: focusRequest.dest }, lat: focusRequest.dest.lat, lon: focusRequest.dest.lon, regime: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest, stat]);

  /** The destination behind a map target: a dated-view destination, or a direct, ferry or via city. */
  const destFor = (tg: Target): Destination | null => {
    if (tg.type === 'dest') return tg.dest;
    if (tg.type === 'place') return tg.place.dest ?? null;
    if (tg.type === 'zone') {
      const d = zonePoints.get(tg.zone.id)?.dest;
      return d && !d.code.startsWith('z:') ? d : null;
    }
    if (tg.type !== 'city' || !stat) return null;
    const c = tg.point as MapCity;
    if (c.land && landOnly(c.land)) return c.land;
    if (c.via) return c.via;
    const code = c.direct?.code ?? c.ferry?.code;
    if (!code) return null;
    return stat.destinations.find((d) => !d.via && (d.code === code || haversineKm(d.lat, d.lon, c.lat, c.lon) < 30)) ?? null;
  };

  const countryByCc = useMemo(() => new Map(stat?.countries.map((c) => [c.cc, c]) ?? []), [stat]);

  /** A destination's marker on the live map (its gateway entry for via places). */
  const cityForDest = (d: Destination): MapCity | undefined =>
    d.via ? stat?.cities.find((c) => c.via === d) : stat?.cities.find((c) => !c.via && (c.direct || c.ferry || c.land) && haversineKm(c.lat, c.lon, d.lat, d.lon) < DIRECT_DEDUPE_KM);

  /** Places "Rain around here" can compare: destinations (incl. via places), then map cities. */
  const nearbyCandidates = useMemo((): NearbyCandidate[] => {
    if (!stat) return [];
    return [
      ...stat.destinations.map((d) => ({ name: d.name, lat: d.lat, lon: d.lon, dest: true })),
      ...stat.cities.filter((c) => !c.direct && !c.ferry && !c.via && !c.land).map((c) => ({ name: c.name, lat: c.lat, lon: c.lon, dest: false })),
    ];
  }, [stat]);

  /** Where each climate zone is rated: its city as a destination (dates view) and as a map city ("Right now"). */
  const zonePoints = useMemo(() => {
    const m = new Map<string, { dest: Destination; city: CityPoint }>();
    if (!stat || !climate) return m;
    for (const z of climate.zones) {
      const dest = stat.destinations.find((d) => d.cc === z.cc && d.name === z.city.name) ?? { name: z.city.name, cc: z.cc, code: `z:${z.id}`, lat: z.city.lat, lon: z.city.lon };
      const city = cityForDest(dest) ?? { id: `z:${z.id}`, name: z.city.name, cc: z.cc, lat: z.city.lat, lon: z.city.lon, population: 0, weight: 0 };
      m.set(z.id, { dest, city });
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stat, climate]);

  /** A country with climate zones is shown as the zone holding its capital. */
  const asZone = (tg: Target): Target => {
    if (tg.type !== 'country' || !climate) return tg;
    const z = zoneFor(climate, tg.point.cc, tg.point.lat, tg.point.lon);
    return z ? { type: 'zone', zone: z, country: tg.point } : tg;
  };

  /** A clicked target as a place that survives a view change (null for hazards and empty areas). */
  const placeFor = (tg: Target): Target | null => {
    if (tg.type === 'country' || tg.type === 'place' || tg.type === 'zone') return tg;
    if (tg.type === 'city') {
      const c = tg.point;
      return { type: 'place', place: { name: c.name, cc: c.cc, countryName: countryByCc.get(c.cc)?.name, lat: c.lat, lon: c.lon, city: c, dest: destFor(tg) ?? undefined } };
    }
    if (tg.type === 'dest') {
      const d = tg.dest;
      return { type: 'place', place: { name: d.name, cc: d.cc, countryName: d.country, admin1: d.admin1, lat: d.lat, lon: d.lon, dest: d, city: cityForDest(d) } };
    }
    return null;
  };

  /** What a pinned place is in the current view: a country, a destination (dates) or a city. */
  const viewTarget = (tg: Target): Target => {
    if (tg.type === 'country') return asZone(tg);
    if (tg.type !== 'place') return tg;
    const p = tg.place;
    if (p.country) return asZone({ type: 'country', point: p.country });
    if (dates) return { type: 'dest', dest: p.dest ?? { name: p.name, cc: p.cc, code: `f:${foundId(p)}`, lat: p.lat, lon: p.lon, country: p.countryName, admin1: p.admin1 } };
    return { type: 'city', point: p.city ?? { id: `f:${foundId(p)}`, name: p.name, cc: p.cc, lat: p.lat, lon: p.lon, population: 0, weight: 0 } };
  };

  // Finder: destinations first (flight, ferry, overland), then countries, via places and other
  // cities by population. A plain city that duplicates a destination nearby is left out.
  const finderItems = useMemo((): SearchItem<FinderRow>[] => {
    if (!stat) return [];
    const today = todayISO();
    const countryName = (cc: string) => countryByCc.get(cc)?.name ?? cc;
    const items: SearchItem<FinderRow>[] = [];
    for (const d of stat.destinations) {
      const how = d.via ? `via ${d.via.name}` : directAirlinesOn(d, today) ? '✈ direct' : d.ferry ? '⛴ ferry' : d.land ? '🚌 overland' : '';
      items.push({
        name: d.name,
        rank: d.via ? 1.5 : 0,
        value: {
          key: `d:${destinationId(d)}`,
          label: d.name,
          sub: [d.country ?? countryName(d.cc), how].filter(Boolean).join(' · '),
          value: { name: d.name, cc: d.cc, countryName: d.country ?? countryName(d.cc), admin1: d.admin1, lat: d.lat, lon: d.lon, dest: d, city: cityForDest(d) },
        },
      });
    }
    for (const c of stat.countries) {
      items.push({
        name: c.name,
        rank: 1,
        value: { key: `c:${c.cc}`, label: c.name, sub: c.point === 'capital' ? `Country · capital ${c.capital}` : 'Country', value: { name: c.name, cc: c.cc, countryName: c.name, lat: c.lat, lon: c.lon, country: c } },
      });
    }
    const destNames = stat.destinations.map((d) => ({ d, n: d.name.toLowerCase() }));
    for (const c of stat.cities) {
      if (c.direct || c.ferry || c.via || c.land) continue;
      const n = c.name.toLowerCase();
      if (destNames.some((x) => x.n === n && haversineKm(x.d.lat, x.d.lon, c.lat, c.lon) < DIRECT_DEDUPE_KM)) continue;
      items.push({
        name: c.name,
        rank: 20 - Math.log10(c.population + 1),
        value: { key: c.id, label: c.name, sub: countryName(c.cc), value: { name: c.name, cc: c.cc, countryName: countryName(c.cc), lat: c.lat, lon: c.lon, city: c } },
      });
    }
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stat, countryByCc]);
  const findPlaces = useCallback((q: string) => searchPlaces(finderItems, q, 8), [finderItems]);
  const [finding, setFinding] = useState(false);
  const closeFinder = useCallback(() => setFinding(false), []);
  // "/" opens the finder while the map is on screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || el?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const r = boxRef.current?.getBoundingClientRect();
      if (!r || r.bottom < 0 || r.top > window.innerHeight) return;
      e.preventDefault();
      setFinding(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  /** The popover heading: the place with its country (the details below then skip their own title). */
  const popoverTitle = (tg: Target): string => {
    if (tg.type === 'dest') return `${tg.dest.name}${tg.dest.country ? `, ${tg.dest.country}` : ''}`;
    if (tg.type === 'zone') return `${tg.country.name}: ${tg.zone.name}`;
    if (tg.type === 'city') {
      const country = countryByCc.get(tg.point.cc)?.name;
      return country && country !== tg.point.name ? `${tg.point.name}, ${country}` : tg.point.name;
    }
    return targetName(tg);
  };
  const countryByCcn3 = useMemo(() => new Map(stat?.countries.map((c) => [c.ccn3, c]) ?? []), [stat]);
  // Level-of-detail outlines.
  const baseShapes = useMemo(() => (stat ? toEntries(stat.shapes, path) : []), [stat, path]);
  const [detail, setDetail] = useState<{ '50m'?: ShapeEntry[]; '10m'?: ShapeEntry[] }>({});
  const detailLoading = useRef<Set<string>>(new Set());
  const pathCache = useRef(new Map<string, string>());
  useEffect(() => {
    const want: ('50m' | '10m')[] = [];
    if (t.k >= DETAIL_50M_K) want.push('50m');
    if (t.k >= DETAIL_10M_K) want.push('10m');
    for (const res of want) {
      if (detail[res] || detailLoading.current.has(res)) continue;
      detailLoading.current.add(res);
      loadShapes(res)
        .then((shapes) => setDetail((d) => ({ ...d, [res]: toEntries(shapes, path) })))
        .catch(() => detailLoading.current.delete(res)); // fall back to coarser outlines
    }
  }, [t.k, detail, path]);
  const activeRes: '110m' | '50m' | '10m' = t.k >= DETAIL_10M_K && detail['10m'] ? '10m' : t.k >= DETAIL_50M_K && detail['50m'] ? '50m' : '110m';
  const activeShapes = activeRes === '110m' ? baseShapes : detail[activeRes]!;
  const loadingDetail = (t.k >= DETAIL_50M_K && !detail['50m']) || (t.k >= DETAIL_10M_K && !detail['10m']);

  // When zoomed in, only draw countries whose outline overlaps the view.
  const [vx0, vy0] = t.invert([0, 0]);
  const [vx1, vy1] = t.invert([W, H]);
  const visibleShapes =
    activeRes === '110m' ? activeShapes : activeShapes.filter((e) => e.x1 >= vx0 && e.x0 <= vx1 && e.y1 >= vy0 && e.y0 <= vy1);
  const visibleKey = activeRes === '110m' ? 'all' : visibleShapes.map((e) => e.id + e.f.properties.name).join('|');
  const shapePath = (e: ShapeEntry) => {
    const key = `${activeRes}:${e.id}:${e.f.properties.name}`;
    let d = pathCache.current.get(key);
    if (d === undefined) {
      d = path(e.f) ?? '';
      pathCache.current.set(key, d);
    }
    return d;
  };
  const shapeIds = useMemo(() => new Set(activeShapes.map((e) => e.id)), [activeShapes]);

  // MFA advisories: hatched areas (countries, regions, circles) and bands along borders, drawn
  // in map units so a 50 km band keeps its real width at every zoom.
  const { ctx: adv } = useAdvisories();
  const advisoryShapes = useMemo(() => {
    if (!adv || !showAdvisories) return [];
    const out: { key: string; level: PageLevel; d: string; band?: number }[] = [];
    for (const page of adv.feed.pages) {
      if (page.level === 'none') continue;
      const cur = adv.zones[page.slug];
      const cc = page.cc ?? cur?.cc;
      const zones: Zone[] =
        cur && cur.asOf === page.mfaDate ? cur.zones : [{ level: page.level === 'unknown' ? 'caution' : page.level, label: page.title, area: { kind: 'country' } }];
      const level = (z: Zone): PageLevel => (cur && cur.asOf === page.mfaDate ? z.level : page.level);
      zones.forEach((z, i) => {
        const key = `${page.slug}:${i}`;
        const a = z.area;
        if (a.kind === 'country') {
          const ccn3 = cc ? countryByCc.get(cc)?.ccn3 : undefined;
          activeShapes.filter((e) => e.id === ccn3).forEach((e, j) => out.push({ key: `${key}:${j}`, level: level(z), d: shapePath(e) }));
        } else if (a.kind === 'admin1') {
          adv.regions.filter((f) => regionMatches(a, f, cur!.cc)).forEach((f, j) => out.push({ key: `${key}:${j}`, level: level(z), d: path(f) ?? '' }));
        } else if (a.kind === 'circle') {
          out.push({ key, level: level(z), d: path(geoCircle().center([a.lon, a.lat]).radius(a.km / 111.2)()) ?? '' });
        } else {
          const lines = adv.borders.get([cur!.cc, a.with].sort().join('|'));
          const mid = lines?.coordinates[0]?.[Math.floor((lines.coordinates[0].length - 1) / 2)];
          if (!lines || !mid) return;
          const p1 = projection(mid as [number, number]);
          const p2 = projection([mid[0], mid[1] + 1]);
          const perKm = p1 && p2 ? Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 111.2 : 0;
          out.push({ key, level: level(z), d: path(lines) ?? '', band: 2 * a.km * perKm });
        }
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adv, showAdvisories, activeShapes, activeRes, countryByCc, path, projection]);
  const cityXY = useMemo(() => stat?.cities.map((c) => projection([c.lon, c.lat])) ?? [], [stat, projection]);
  const onScreen = (x: number, y: number, m = 8) => x >= -m && x <= W + m && y >= -m && y <= H + m;

  // Live view: cities visible at the current zoom, largest first, decluttered.
  const minPop = minPopulation(t.k);
  const visibleCities = useMemo(() => {
    if (!stat || dates) return [];
    const out: { city: MapCity; x: number; y: number }[] = [];
    // Direct-flight cities are shown at every zoom level; when zoomed out they only thin out
    // where they would overlap, and all of them separate as you zoom in.
    const directGap = t.k < 2 ? 7 : t.k < 4 ? 10 : 12;
    for (let i = 0; i < stat.cities.length && out.length < MAX_CITY_DOTS; i++) {
      const c = stat.cities[i];
      if (!c.direct && !c.ferry && !c.via && !c.land && (minPop === null || c.weight < minPop)) break; // others sorted by weight, descending
      // Gateway places only with "Via places" on; plain cities next to them only with it off.
      if (c.via ? !showVia : c.nearVia && showVia) continue;
      const xy = cityXY[i];
      if (!xy) continue;
      const [x, y] = t.apply(xy);
      if (!onScreen(x, y)) continue;
      const gap = c.direct || c.ferry || c.via || c.land ? directGap : MIN_DOT_GAP;
      if (out.some((o) => (o.x - x) ** 2 + (o.y - y) ** 2 < gap ** 2)) continue;
      out.push({ city: c, x, y });
    }
    return out;
  }, [stat, cityXY, t, minPop, dates, showVia]);

  // Dates view: curated destinations, decluttered.
  const visibleDests = useMemo(() => {
    if (!stat || !dates) return [];
    const out: { dest: Destination; x: number; y: number }[] = [];
    for (const d of stat.destinations) {
      if (d.via && !showVia) continue;
      const xy = projection([d.lon, d.lat]);
      if (!xy) continue;
      const [x, y] = t.apply(xy);
      if (!onScreen(x, y)) continue;
      if (out.some((o) => (o.x - x) ** 2 + (o.y - y) ** 2 < 10 ** 2)) continue;
      out.push({ dest: d, x, y });
    }
    return out;
  }, [stat, dates, projection, t, showVia]);

  // Fetch data for whatever is on screen (debounced); all countries load in the background.
  useEffect(() => {
    if (!stat || rainMode) return;
    const id = window.setTimeout(() => {
      const visibleCountries = stat.countries.filter((c) => {
        const xy = projection([c.lon, c.lat]);
        if (!xy) return false;
        const [x, y] = t.apply(xy);
        return onScreen(x, y, 0);
      });
      const all = stat.countries.map((c) => ({ id: countryId(c), lat: c.lat, lon: c.lon }));
      const vis = visibleCountries.map((c) => ({ id: countryId(c), lat: c.lat, lon: c.lon }));
      // Climate-zone cities colour whole regions, so all of them load with the countries.
      const zonePts = [...zonePoints.values()];
      if (dates) {
        if (outlook!.plan.basis === 'none') return;
        // History costs one call per year per place, so only what's on screen is fetched.
        oStore.request([...visibleDests.map(({ dest }) => ({ id: destinationId(dest), lat: dest.lat, lon: dest.lon })), ...vis, ...zonePts.map(({ dest }) => ({ id: destinationId(dest), lat: dest.lat, lon: dest.lon }))]);
      } else {
        store.request([...all, ...zonePts.map(({ city }) => ({ id: city.id, lat: city.lat, lon: city.lon }))]);
        store.request([...visibleCities.map(({ city }) => ({ id: city.id, lat: city.lat, lon: city.lon })), ...vis]);
      }
    }, 350);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stat, t, visibleCities, visibleDests, projection, store, oStore, dates, reloadKey, rainMode, zonePoints]);

  // Per-country evaluations for the active view.
  const nowEval = useMemo(() => {
    const m = new Map<string, Evaluated | null>();
    stat?.countries.forEach((c) => m.set(c.ccn3, evaluate(store.get(countryId(c)), hazards, c.lat, c.lon)));
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stat, version, hazards]);

  const datesEval = useMemo(() => {
    const m = new Map<string, DatesEval>();
    if (dates) stat?.countries.forEach((c) => m.set(c.ccn3, evaluateDates(oStore.get(countryId(c)), c.cc, c.lat, c.lon, tripMonths)));
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stat, oVersion, dates, oStore, tripMonths]);

  // Per-zone evaluations, from each zone's city.
  const nowZoneEval = useMemo(() => {
    const m = new Map<string, Evaluated | null>();
    zonePoints.forEach(({ city }, id) => m.set(id, evaluate(store.get(city.id), hazards, city.lat, city.lon)));
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zonePoints, version, hazards]);

  const datesZoneEval = useMemo(() => {
    const m = new Map<string, DatesEval>();
    if (dates) zonePoints.forEach(({ dest }, id) => m.set(id, evaluateDates(oStore.get(destinationId(dest)), dest.cc, dest.lat, dest.lon, tripMonths)));
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zonePoints, oVersion, dates, oStore, tripMonths]);

  const countryCat = (ccn3: string): ConditionClass | null =>
    (dates ? datesEval.get(ccn3)?.cls : nowEval.get(ccn3)?.cls.category) ?? null;
  /** A zone's own rating; never the capital's, so a zone not stored yet shows as no data. */
  const zoneCat = (id: string): ConditionClass | null =>
    (dates ? datesZoneEval.get(id)?.cls : nowZoneEval.get(id)?.cls.category) ?? null;

  // Countries with climate zones count once per zone.
  const counts = useMemo(() => {
    const c = { good: 0, average: 0, bad: 0 };
    stat?.countries.forEach((p) => {
      const zs = climate?.byCc.get(p.cc);
      const ks = zs ? zs.map((z) => zoneCat(z.id)) : [dates ? datesEval.get(p.ccn3)?.cls : nowEval.get(p.ccn3)?.cls.category];
      ks.forEach((k) => k && c[k]++);
    });
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stat, dates, datesEval, nowEval, climate, datesZoneEval, nowZoneEval]);

  const fill = (cat: ConditionClass | null | undefined) => (cat ? `var(--map-${cat})` : 'var(--map-nodata)');
  const dim = (cat: ConditionClass | null | undefined) => filter !== null && cat !== filter;

  const show = (e: React.PointerEvent, target: Target) => {
    const box = boxRef.current?.getBoundingClientRect();
    if (box) setHover({ target, x: e.clientX - box.left, y: e.clientY - box.top });
  };

  // Map a pointer position back to a latitude/longitude (null off the globe).
  const pointerLatLon = (e: { clientX: number; clientY: number }): [number, number] | null => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return null;
    const vx = ((e.clientX - r.left) * W) / r.width;
    const vy = ((e.clientY - r.top) * H) / r.height;
    const ll = projection.invert?.(t.invert([vx, vy]));
    const back = ll && projection(ll);
    const [px, py] = t.invert([vx, vy]);
    if (!ll || !back || Math.abs(back[0] - px) > 0.5 || Math.abs(back[1] - py) > 0.5) return null;
    return ll;
  };
  const rainMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = boxRef.current?.getBoundingClientRect();
    const ll = pointerLatLon(e);
    if (!box || !ll) return setRainHover(null);
    setRainHover({ lon: ll[0], lat: ll[1], x: e.clientX - box.left, y: e.clientY - box.top });
    // Over open sea there is no place name, and off a label there is no regime.
    const el = e.target as Element;
    if (!el.closest('.monsoon-labels g')) setRegimeHover(null);
    if (el === e.currentTarget || el.tagName === 'rect' || el.tagName === 'image') setHover(null);
  };
  /** Pins a popover where the pointer clicked (rainfall: any spot; ratings: a place). */
  const pinAt = (e: React.MouseEvent, target: Target | null) => {
    e.stopPropagation();
    const ll = pointerLatLon(e);
    if (!ll) return;
    if (!rainMode && !target) return setPin(null);
    setPin({ target, lat: ll[1], lon: ll[0], regime: rainMode ? regimeHover : null });
    // Centre the place so its popover has room on every side.
    centreOn(ll[0], ll[1]);
    setHover(null);
    setRainHover(null);
  };
  useEffect(() => {
    if (!pin) return;
    // Escape inside the finder only closes the finder.
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && setPin(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pin]);

  const hoverKey = hover ? targetKey(hover.target) : null;
  const pinnedKey = pin?.target ? targetKey(viewTarget(pin.target)) : null;

  // Country shapes don't depend on the zoom transform, so they are memoised separately.
  const countryPaths = useMemo(
    () =>
      visibleShapes.map((e) => {
        const f = e.f;
        const cp = countryByCcn3.get(String(f.id));
        // A country with climate zones acts as its capital's zone (only slivers along the coast
        // and tiny islands show through the zone layer above).
        const target: Target = cp ? asZone({ type: 'country', point: cp }) : { type: 'nodata', name: f.properties.name };
        const cat = target.type === 'zone' ? zoneCat(target.zone.id) : cp ? countryCat(cp.ccn3) : null;
        const key = targetKey(target);
        const active = key === hoverKey || key === pinnedKey;
        return (
          <path
            key={`${activeRes}:${String(f.id)}:${f.properties.name}`}
            d={shapePath(e)}
            fill={rainMode ? 'transparent' : fill(cat)}
            opacity={!rainMode && dim(cat) ? 0.18 : 1}
            stroke={active ? 'var(--text-primary)' : rainMode ? 'var(--map-rain-border)' : 'var(--map-border)'}
            strokeWidth={active ? 1.5 : rainMode ? 1.1 : 0.5}
            vectorEffect="non-scaling-stroke"
            onPointerMove={(e) => show(e, target)}
            onClick={(e) => pinAt(e, target)}
          />
        );
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleKey, activeRes, nowEval, datesEval, dates, filter, hoverKey, pinnedKey, path, rainMode, rainHover, climate, nowZoneEval, datesZoneEval],
  );

  // Climate zones: each zone in its own colour, clipped to the country outline being drawn so
  // coastlines follow the active level of detail. A dotted line marks where zones meet.
  const zonePaths = useMemo(() => {
    const m = new Map<string, string>();
    [...(climate?.zones ?? []), ...(climate?.areas ?? [])].forEach((z) => m.set(z.id, path(z.shape) ?? ''));
    climate?.edges.forEach((f, cc) => m.set(`edge:${cc}`, path(f) ?? ''));
    return m;
  }, [climate, path]);
  // Visible outlines of countries with climate zones, grouped by country: some countries come as
  // several features with the same id (Australia and its territories at 50m).
  const zonedShapes = useMemo(() => {
    const m = new Map<string, { cp: CountryPoint; zs: ClimateZone[]; shapes: ShapeEntry[] }>();
    if (!climate) return m;
    for (const e of visibleShapes) {
      const cp = countryByCcn3.get(e.id);
      const zs = cp && climate.byCc.get(cp.cc);
      if (!cp || !zs) continue;
      const g = m.get(e.id) ?? { cp, zs, shapes: [] };
      g.shapes.push(e);
      m.set(e.id, g);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [climate, visibleKey, activeRes, countryByCcn3]);
  const zoneLayer = useMemo(
    () =>
      climate && !rainMode
        ? [...zonedShapes].map(([id, { cp, zs, shapes }]) => {
            const clip = `zclip-${activeRes}-${id}`;
            const active = zs.filter((z) => `z:${z.id}` === hoverKey || `z:${z.id}` === pinnedKey);
            return (
              <g key={clip}>
                <clipPath id={clip}>
                  {shapes.map((e, i) => (
                    <path key={i} d={shapePath(e)} />
                  ))}
                </clipPath>
                <g clipPath={`url(#${clip})`}>
                  {zs.map((z) => {
                    const cat = zoneCat(z.id);
                    const target: Target = { type: 'zone', zone: z, country: cp };
                    // The stroke in the zone's own colour covers gaps left by the simplified shapes.
                    return (
                      <path
                        key={z.id}
                        d={zonePaths.get(z.id)}
                        fill={fill(cat)}
                        stroke={fill(cat)}
                        strokeWidth={3}
                        vectorEffect="non-scaling-stroke"
                        opacity={dim(cat) ? 0.18 : 1}
                        data-zone={z.id}
                        onPointerMove={(ev) => show(ev, target)}
                        onClick={(ev) => pinAt(ev, target)}
                      />
                    );
                  })}
                  <path d={zonePaths.get(`edge:${cp.cc}`)} className="zone-edge" fill="none" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" pointerEvents="none" />
                  {active.map((z) => (
                    <path key={z.id} d={zonePaths.get(z.id)} fill="none" stroke="var(--text-primary)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" pointerEvents="none" />
                  ))}
                </g>
                {shapes.map((e, i) => (
                  <path key={i} d={shapePath(e)} fill="none" stroke="var(--map-border)" strokeWidth={0.5} vectorEffect="non-scaling-stroke" pointerEvents="none" />
                ))}
              </g>
            );
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [climate, rainMode, zonedShapes, activeRes, nowZoneEval, datesZoneEval, dates, filter, hoverKey, pinnedKey, zonePaths],
  );

  // Monsoon footprints (rainfall map): the zones a regime rains on, clipped to each country drawn.
  const footprints = useMemo(() => {
    if (!climate || !rainMode) return null;
    const clips = new Map<string, string>();
    const defs = [...zonedShapes].map(([ccn3, { cp, shapes }]) => {
      const id = `fclip-${activeRes}-${ccn3}`;
      clips.set(cp.cc, id);
      return (
        <clipPath key={id} id={id}>
          {shapes.map((e, i) => (
            <path key={i} d={shapePath(e)} />
          ))}
        </clipPath>
      );
    });
    return (
      <>
        {defs}
        <MonsoonFootprints zones={[...climate.zones, ...climate.areas]} months={rainMonths} hoverId={regimeHover?.id ?? null} zonePath={(id) => zonePaths.get(id)} clipFor={(cc) => clips.get(cc) ?? null} />
      </>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [climate, rainMode, zonedShapes, activeRes, rainMonths.join(), regimeHover, zonePaths]);

  /** Zooms to a place picked in the finder (a country fits its outline) and pins it. */
  const pickPlace = (place: FoundPlace) => {
    setFinding(false);
    setHover(null);
    const shape = place.country && baseShapes.find((e) => e.id === place.country!.ccn3);
    if (shape) {
      const k = Math.min(20, Math.max(1, Math.min(W / (shape.x1 - shape.x0), H / (shape.y1 - shape.y0)) * 0.8));
      const cx = (shape.x0 + shape.x1) / 2;
      const cy = (shape.y0 + shape.y1) / 2;
      zoomTo(zoomIdentity.translate(W / 2 - k * cx, H / 2 - k * cy).scale(k));
      boxRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else {
      centreOn(place.lon, place.lat, Math.max(t.k, 8));
    }
    setPin({ target: { type: 'place', place }, lat: place.lat, lon: place.lon, regime: null });
  };

  // A pinned place without a marker of its own asks for its data like on-screen markers do
  // (stored data only; "Right now" loads from the API only on request).
  useEffect(() => {
    if (pin?.target?.type !== 'place') return;
    const vt = viewTarget(pin.target);
    if (dates && vt.type === 'dest' && outlook!.plan.basis !== 'none') oStore.request([{ id: destinationId(vt.dest), lat: vt.dest.lat, lon: vt.dest.lon }]);
    if (nowView && vt.type === 'city') store.request([{ id: vt.point.id, lat: vt.point.lat, lon: vt.point.lon }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin, dates, nowView, oStore, store]);

  if (loadError) {
    return (
      <section className="card">
        <h2>Where’s the sun shining?</h2>
        <Notice kind="err" title="The map could not be loaded"><p>{loadError}</p></Notice>
      </section>
    );
  }

  const smallCountries = stat?.countries.filter((c) => !shapeIds.has(c.ccn3)) ?? [];
  const labelBoxes: [number, number, number, number][] = [];
  const labelFor = (name: string, x: number, y: number) => {
    const w = name.length * 6.2 + 4;
    const box: [number, number, number, number] = [x + 6, y - 7, x + 6 + w, y + 7];
    if (box[2] > W || labelBoxes.some((b) => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) return null;
    labelBoxes.push(box);
    return <text x={x + 6} y={y + 4} className="map-label">{name}</text>;
  };
  // When the "Right now" data shown was loaded (newest and oldest across countries).
  const loaded = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    let snapshot = false;
    stat?.countries.forEach((c) => {
      const w = store.get(countryId(c))?.weather;
      if (!w?.loadedAt) return;
      min = Math.min(min, w.loadedAt);
      max = Math.max(max, w.loadedAt);
      snapshot ||= Boolean(w.snapshot);
    });
    return max > 0 ? { min, max, snapshot } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stat, version]);
  const fmtLoaded = (ms: number) =>
    new Date(ms).toLocaleString('en-SG', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const loadedLabel = loaded
    ? new Date(loaded.min).toDateString() === new Date(loaded.max).toDateString()
      ? `Loaded ${fmtLoaded(loaded.max)}`
      : `Loaded ${new Date(loaded.min).toLocaleDateString('en-SG', { day: 'numeric', month: 'short' })} – ${fmtLoaded(loaded.max)}`
    : 'Not loaded yet';
  const plan = outlook?.plan;
  const focusXY = focus ? projection([focus.lon, focus.lat]) : null;

  const advisoryFor = (target: Target) => {
    // Recent unrest alerts show only for a city they name (within 50 km), never country-wide.
    const at = target.type === 'city' ? target.point : target.type === 'dest' ? target.dest : null;
    const alert = (
      <>
        {at && onWanderList(wander, at.lat, at.lon) && <p className="small">🎈 On your wander list</p>}
        {at ? <AlertLine cc={at.cc} lat={at.lat} lon={at.lon} /> : null}
      </>
    );
    if (!adv) return alert;
    if (target.type === 'country') return <AdvisoryLine ctx={adv} cc={target.point.cc} lat={target.point.lat} lon={target.point.lon} country />;
    if (at) return (
      <>
        <AdvisoryLine ctx={adv} cc={at.cc} lat={at.lat} lon={at.lon} />
        {alert}
      </>
    );
    return null;
  };
  /** Table rows: one per country, or one per climate zone where a country has them. */
  const tableRows = <E,>(byCountry: Map<string, E>, byZone: Map<string, E>): TableRow<E>[] =>
    (stat?.countries ?? []).flatMap((c) => {
      const zs = climate?.byCc.get(c.cc);
      if (!zs) return [{ key: c.cc, name: c.name, cc: c.cc, lat: c.lat, lon: c.lon, ev: byCountry.get(c.ccn3) }];
      return zs.map((z) => ({ key: z.id, name: `${c.name}: ${z.name} (${z.city.name})`, cc: c.cc, lat: z.city.lat, lon: z.city.lon, ev: byZone.get(z.id) }));
    });

  /** One zone's rating, label and (in full) its key numbers, for the zone list. */
  const zoneSummary = (z: ClimateZone): { cat: ConditionClass | null; label: string; stats: string } => {
    const pts = zonePoints.get(z.id);
    if (dates) {
      const ev = datesZoneEval.get(z.id);
      const o = ev?.outlook;
      return {
        cat: ev?.cls ?? null,
        label: ev?.suitability?.rating ?? (ev?.pending ? 'Not stored yet' : 'No data'),
        stats: o ? `${Math.round(o.wetDays)} of ${o.tripDays} days wet · ${Math.round(o.totalRainMm)} mm · ${Math.round(o.tMaxC)}°` : '',
      };
    }
    const ev = nowZoneEval.get(z.id);
    const w = ev?.data.weather;
    return {
      cat: ev?.cls.category ?? null,
      label: ev ? LABEL[ev.cls.category] : pts && store.get(pts.city.id) === undefined ? 'Loading…' : 'No data',
      stats: w ? `${Math.round(w.tempC)} °C · ${describeWeatherCode(w.weatherCode)}` : '',
    };
  };

  /**
   * A climate zone: the country's advice, where it's rated, its city's details, the seasons now
   * under way, then every zone of the country side by side (click one to switch to it).
   */
  const zoneDetails = (target: Extract<Target, { type: 'zone' }>, compact: boolean) => {
    const { zone, country } = target;
    const pts = zonePoints.get(zone.id);
    if (!pts || !climate) return null;
    const siblings = climate.byCc.get(country.cc) ?? [];
    const months = dates ? tripMonths : [Number(todayISO().slice(5, 7))];
    const seasons = regimesForCountry(climate, country.cc, months);
    return (
      <>
        {adv && <AdvisoryLine ctx={adv} cc={country.cc} lat={zone.city.lat} lon={zone.city.lon} country />}
        <div className="small secondary">Climate zone rated at {zone.city.name} · {zone.places}</div>
        {dates ? (
          <DatesTargetDetails target={{ type: 'dest', dest: pts.dest }} store={oStore} months={tripMonths} plan={plan} compact={compact} start={start!} />
        ) : (
          <TargetDetails target={{ type: 'city', point: pts.city }} hazards={hazards} countryByCc={countryByCc} compact={compact} onLoadNow={compact ? undefined : (p) => store.loadFresh([p])} recent={recentOf(pts.city.id, pts.city.lat, pts.city.lon)} />
        )}
        {seasons.length > 0 && (
          <div className="small secondary">
            <strong>{seasons.length === 1 ? 'Season' : 'Seasons'}:</strong> {seasons.map((r) => `${r.name}, ${regimeWhere(climate, country.cc, r)}`).join('; ')}
          </div>
        )}
        <div className="zone-rows" role="list" aria-label={`Climate zones of ${country.name}`}>
          <div className="small" style={{ fontWeight: 700 }}>Across {country.name}</div>
          {siblings.map((z) => {
            const sum = zoneSummary(z);
            const row = (
              <>
                <i className="swatch" style={{ background: fill(sum.cat) }} aria-hidden />
                <span>
                  {z.name} <span className="zone-sub">{z.city.name}{!compact && sum.stats ? ` · ${sum.stats}` : ''}</span>
                </span>
                <span>{sum.label}</span>
              </>
            );
            return compact || z.id === zone.id ? (
              <div key={z.id} role="listitem" className={`zone-row${z.id === zone.id ? ' current' : ''}`} aria-current={z.id === zone.id || undefined}>{row}</div>
            ) : (
              <button
                key={z.id}
                type="button"
                role="listitem"
                className="zone-row link-row"
                onClick={() => setPin((p) => p && { ...p, target: { type: 'zone', zone: z, country }, lat: z.city.lat, lon: z.city.lon })}
              >
                {row}
              </button>
            );
          })}
        </div>
      </>
    );
  };

  // Safety first: MFA's advice outranks the weather, so it leads the popover.
  const details = (target: Target, compact: boolean) => target.type === 'zone' ? zoneDetails(target, compact) : (
    <>
      {advisoryFor(target)}
      {dates && (target.type === 'country' || target.type === 'dest') ? (
        <DatesTargetDetails target={target} store={oStore} months={tripMonths} plan={plan} compact={compact} start={start!} />
      ) : (
        <TargetDetails
          target={target}
          hazards={hazards}
          countryByCc={countryByCc}
          compact={compact}
          onLoadNow={compact ? undefined : (p) => store.loadFresh([p])}
          recent={target.type === 'city' ? recentOf(target.point.id, target.point.lat, target.point.lon) : target.type === 'country' ? recentOf(`c:${target.point.ccn3}`, target.point.lat, target.point.lon) : null}
        />
      )}
    </>
  );


  // Countries split into climate zones, named for the captions ("Sri Lanka, …, Taiwan and India").
  const zonedNames = (() => {
    const names = [...(climate?.byCc.keys() ?? [])].map((cc) => countryByCc.get(cc)?.name ?? cc);
    return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join('');
  })();
  const zonesNote = climate
    ? `Countries are coloured by conditions at their capital, except ${zonedNames}, whose regions get their rain in different seasons: each climate zone there (dotted lines) is rated at one city of its own.`
    : 'Countries are coloured by conditions at their capital.';

  // The map key: symbols other than the condition filters, in groups. Each item only shows when
  // it can appear on the map (as before); a group with nothing in it is left out.
  const keyItem = (title: string | undefined, icon: ReactNode, label: ReactNode, k: string) => (
    <span key={k} className="key-item" title={title}>
      {icon} {label}
    </span>
  );
  const ring = (dash?: string, width = 2) => (
    <svg width="14" height="14" aria-hidden><circle cx={7} cy={7} r={4.5} fill="var(--map-nodata)" stroke="var(--text-primary)" strokeWidth={width} strokeDasharray={dash} /></svg>
  );
  const keyGroups: { name: string; items: ReactNode[] }[] = [
    {
      name: 'Getting there',
      items: [
        keyItem(stat?.directSource, ring(), 'Direct flight from SIN', 'direct'),
        keyItem(undefined, ring('2.5 1.5'), 'Ferry from Singapore', 'ferry'),
        keyItem('Reached overland from Singapore by coach, bus or train (places you can also fly to keep their flight marker and list the coach option)', ring(LAND_DASH), '🚌 Overland from Singapore', 'land'),
        ...(showVia ? [keyItem('No direct flight of its own: fly to a nearby direct-flight city, then transfer by road, rail or ferry', ring('1 1.6', 1.6), 'Via a direct-flight city', 'via')] : []),
      ],
    },
    {
      name: 'Travel advice',
      items:
        showAdvisories && adv
          ? (['all', 'nonEssential', 'caution'] as const).map((lv) =>
              keyItem(
                'Singapore MFA travel advice',
                <svg width="14" height="14" aria-hidden><rect x={1} y={1} width={12} height={12} fill={`url(#adv-legend-${lv})`} stroke={`var(--adv-${lv})`} /><defs><pattern id={`adv-legend-${lv}`} patternUnits="userSpaceOnUse" width={4} height={4} patternTransform="rotate(45)"><line x1={0} y1={0} x2={0} y2={4} stroke={`var(--adv-${lv})`} strokeWidth={1.5} /></pattern></defs></svg>,
                `MFA: ${lv === 'all' ? 'defer all travel' : lv === 'nonEssential' ? 'defer non-essential' : 'caution'}`,
                lv,
              ),
            )
          : [],
    },
    {
      name: 'Climate zones',
      items: climate
        ? [
            keyItem(
              `${zonedNames} get their rain in different seasons in different regions, so each zone is rated at one city of its own instead of the capital.`,
              <svg width="16" height="14" aria-hidden><line x1={1} y1={7} x2={15} y2={7} className="zone-edge" strokeDasharray="2 3" /></svg>,
              'Zone edge (own rating each side)',
              'zone',
            ),
          ]
        : [],
    },
    {
      name: 'Right now',
      items: dates
        ? []
        : [
            keyItem(undefined, <svg width="14" height="14" aria-hidden><CycloneGlyph x={7} y={7} r={5} /></svg>, 'Tropical cyclone', 'cyclone'),
            keyItem(undefined, <svg width="12" height="12" aria-hidden><FireGlyph x={6} y={7} /></svg>, 'Active fire', 'fire'),
            keyItem(
              'Last 30 days at least 1.5× normal rain, or last 7 days at least 2× (a thicker ring: 2× or 3×). Compared with the same days in the past 10 years.',
              <svg width="14" height="14" aria-hidden><circle cx={7} cy={7} r={3} fill="var(--map-nodata)" /><circle cx={7} cy={7} r={5.5} fill="none" stroke="var(--info-ink)" strokeWidth={1.5} /></svg>,
              'Wet lately',
              'wet',
            ),
          ],
    },
  ].filter((g) => g.items.length > 0);

  return (
    <section className={`card map-card${rainMode ? ' rain-kind' : ''}`} aria-labelledby="map-h">
      <div className="map-head">
        <div className="map-title-row">
          <h2 id="map-h">{rainMode ? 'Where’s the rain falling?' : 'Where’s the sun shining?'}</h2>
          <div className="kind-switch" role="group" aria-label="Map type">
            <button type="button" aria-pressed={!rainMode} onClick={() => setKind('ratings')}>
              <span aria-hidden>☀</span> <span className="long">Weather ratings</span><span className="short">Ratings</span>
            </button>
            <button type="button" className="rain" aria-pressed={rainMode} onClick={() => setKind('rainfall')}>
              <span aria-hidden>🌧</span> <span className="long">Rainfall &amp; monsoons</span><span className="short">Rainfall</span>
            </button>
          </div>
        </div>
        {rainMode ? (
          <div className="tabs" role="tablist" aria-label="Rainfall view">
            <button
              type="button"
              role="tab"
              aria-selected={!monsoon}
              disabled={!datesValid}
              title={datesValid ? 'Average rainfall for the months of your dates' : 'Pick dates first'}
              onClick={() => setRainTab('travel')}
            >
              Your travel months{datesValid ? `: ${travelMonths.map(monthName).join(' & ')}` : ''}
            </button>
            <button type="button" role="tab" aria-selected={monsoon} onClick={() => setRainTab('monthly')}>
              Month by month
            </button>
          </div>
        ) : (
          <div className="tabs" role="tablist" aria-label="Map view">
            <button type="button" role="tab" aria-selected={view === 'now'} onClick={() => setView('now')}>Right now</button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'dates'}
              disabled={!datesValid}
              title={datesValid ? undefined : 'Search dates or pick a daydream date first'}
              onClick={() => setView('dates')}
            >
              {datesLabel ?? 'Your dates'}{datesValid ? `: ${formatShortDate(start!)} – ${formatShortDate(end!)}` : ''}
            </button>
          </div>
        )}
        <p className="small muted map-sub">
          <span>
            {monsoon
              ? `Average ${monthName(month)} rainfall · 1991–2020 climate normals, not a forecast`
              : rainMode
                ? `Average monthly rainfall for ${travelMonths.map(monthName).join(' & ')} · 1991–2020 climate normals`
                : dates
                  ? shortBasis(plan) || 'Your dates'
                  : loadedLabel}
          </span>
            <span
              className="info-dot"
              tabIndex={0}
              role="note"
              aria-label="About this view"
              title={
                rainMode
                  ? 'Colours show average rainfall per month for 1991–2020: GPCP v2.3 (satellite plus rain gauges, 2.5° grid) for the world view, and ERA5 (0.25° grid, about 28 km) for Asia and Australia once you zoom in, so coasts with opposite monsoons show apart. Pin a spot to compare rain at places around it. Labels mark monsoons and rainy seasons typically active then; dashed outlines show where a monsoon mainly rains, bolder while it is active. Bundled with the app: no weather API calls. Hover anywhere for that area’s rainfall through the year.'
                  : dates
                  ? `${describePlan(plan!)} ${zonesNote} Markers are destinations reachable from Singapore.`
                  : `${loaded?.snapshot ? 'Showing conditions at load time. ' : loaded ? 'Current hour from the saved hourly forecast. ' : ''}Shows the hourly forecast saved in the database when the map was last loaded; it is not updated automatically and makes no weather API calls. While the saved 48 hours cover the current hour, that hour is shown; after that, the hour it was loaded. Press Reload to load newer data (uses weather API budget). This is not the typical weather for your travel dates. ${zonesNote} Zoom in to see individual cities.`
              }
            >
              i
            </span>
          {nowView && (
            <>
              <span aria-hidden>·</span>
              <button
                type="button"
                className="link-button small"
                disabled={status.pending > 0 && store.isRefreshing()}
                onClick={reloadNow}
                title="Load the latest hourly forecast for the places on the map. Uses weather API budget (about 2 units per place; places loaded within the last hour are reused)."
              >
                {status.pending > 0 && store.isRefreshing() ? 'Reloading…' : '↻ Reload'}
              </button>
            </>
          )}
          {!rainMode && status.pending > 0 && <span>· Loading {status.pending} place{status.pending === 1 ? '' : 's'}…</span>}
          {loadingDetail && <span>· Loading detailed coastlines…</span>}
        </p>
      </div>

      {rainMode ? (
        <>
          <RainLegend grid={rain} caption={monsoon ? `Average rainfall, ${monthName(month)}` : `Average rainfall, ${travelMonths.map(monthName).join(' & ')}`} />
          {rainError && <Notice kind="err" title="Rainfall data could not be loaded"><p>{rainError}</p></Notice>}
          {monsoon && (
            <MonthControls month={month} months={ALL_MONTHS} onMonth={setMonth} travelMonths={travelMonths} />
          )}
        </>
      ) : (
      <div className="map-legend" role="group" aria-label="Filter by condition">
          {(['good', 'average', 'bad'] as const).map((k) => (
            <button key={k} type="button" className="legend-chip" aria-pressed={filter === k} onClick={() => setFilter((f) => (f === k ? null : k))}>
              <i className="swatch block" style={{ background: `var(--map-${k})` }} />
              {dates ? (k === 'good' ? 'Pleasant' : k === 'average' ? 'Mixed' : 'Challenging') : LABEL[k]}
              <span className="muted">{counts[k]}</span>
            </button>
          ))}
          <span className="legend-chip static"><i className="swatch block" style={{ background: 'var(--map-nodata)' }} /> {status.pending > 0 ? 'Loading / no data' : 'No data'}</span>
          {focus && <span className="legend-chip static"><svg width="14" height="14" aria-hidden><circle cx={7} cy={7} r={5} fill="none" stroke="var(--text-primary)" strokeWidth={2} /></svg> {focus.name}</span>}
        </div>
      )}

      {dates && !rainMode && plan?.basis === 'none' && <Notice kind="warn" title="No outlook available"><p>{plan.reason}</p></Notice>}
      {status.rateLimitedUntil && <p className="small tone-warning">The free weather service rate limit was reached. More places will load automatically in about a minute.</p>}

      <div className="map-box" ref={boxRef} onPointerLeave={() => setHover(null)}>
        {!stat ? (
          <div className="skeleton" style={{ aspectRatio: `${W} / ${H}`, height: 'auto' }} aria-busy="true" />
        ) : (
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label="Zoomable weather map. Use the zoom buttons, pinch, or ⌘/Ctrl + scroll to zoom, and drag to pan."
            onPointerMove={rainMode ? rainMove : undefined}
            onPointerLeave={() => setRainHover(null)}
            onClick={(e) => pinAt(e, null)}
          >
            <defs>
              {(['all', 'nonEssential', 'caution', 'unknown'] as const).map((lv) => (
                <pattern key={lv} id={`adv-hatch-${lv}`} patternUnits="userSpaceOnUse" width={6} height={6} patternTransform={`rotate(45) scale(${1 / t.k})`}>
                  <line x1={0} y1={0} x2={0} y2={6} stroke={`var(--adv-${lv})`} strokeWidth={lv === 'caution' ? 1.2 : 2} />
                </pattern>
              ))}
            </defs>
            <rect width={W} height={H} fill="var(--map-ocean)" />
            <g transform={t.toString()}>
              {rainMode && raster && <image href={raster} x={rainView.x0} y={rainView.y0} width={rainView.x1 - rainView.x0} height={rainView.y1 - rainView.y0} preserveAspectRatio="none" className="rain-raster" pointerEvents="none" />}
              {countryPaths}
              {zoneLayer}
              {footprints}
              {!rainMode && advisoryShapes.length > 0 && (
                <g className="advisory-layer" pointerEvents="none" aria-hidden>
                  {advisoryShapes.map((sh) =>
                    sh.band !== undefined ? (
                      <path key={sh.key} d={sh.d} fill="none" stroke={`var(--adv-${sh.level})`} strokeOpacity={0.45} strokeWidth={Math.max(sh.band, 3 / t.k)} strokeLinecap="round" strokeLinejoin="round" />
                    ) : (
                      <path key={sh.key} d={sh.d} fill={`url(#adv-hatch-${sh.level})`} stroke={`var(--adv-${sh.level})`} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
                    ),
                  )}
                </g>
              )}
            </g>

            {/* Overlays are drawn in screen space so they keep a constant size while zooming. */}
            {smallCountries.map((c) => {
              const xy = projection([c.lon, c.lat]);
              if (!xy) return null;
              const [x, y] = t.apply(xy);
              if (!onScreen(x, y, 10)) return null;
              if (rainMode) return null;
              if (!dates && minPop !== null && t.k >= 3.5) return null; // city layer covers them when zoomed in
              const cat = countryCat(c.ccn3);
              const target: Target = { type: 'country', point: c };
              const active = targetKey(target) === hoverKey;
              return (
                <g key={c.cc} opacity={dim(cat) ? 0.18 : 1} onPointerMove={(e) => show(e, target)} onClick={(e) => pinAt(e, target)}>
                  <circle cx={x} cy={y} r={9} fill="transparent" />
                  <circle cx={x} cy={y} r={active ? 5.5 : 4} fill={fill(cat)} stroke="var(--surface-1)" strokeWidth={1.5} pointerEvents="none" />
                </g>
              );
            })}

            {nowView && t.k >= 2 &&
              hazards
                .filter((h) => h.kind === 'fire')
                .map((h) => {
                  const xy = projection([h.lon, h.lat]);
                  if (!xy) return null;
                  const [x, y] = t.apply(xy);
                  if (!onScreen(x, y, 10)) return null;
                  const target: Target = { type: 'hazard', hazard: h };
                  return (
                    <g key={h.id} onPointerMove={(e) => show(e, target)} onClick={(e) => pinAt(e, target)}>
                      <circle cx={x} cy={y} r={8} fill="transparent" />
                      <FireGlyph x={x} y={y} />
                    </g>
                  );
                })}

            {visibleCities.map(({ city, x, y }) => {
              const cat = evaluate(store.get(city.id), hazards, city.lat, city.lon)?.cls.category;
              const target: Target = { type: 'city', point: city };
              const key = targetKey(target);
              const active = key === hoverKey || key === pinnedKey;
              const wet = nowView ? recentOf(city.id, city.lat, city.lon) : null;
              const dotR = city.via ? (active ? 6 : 4.5) : city.direct || city.ferry || city.land ? (active ? 6.5 : 5) : active ? 5.5 : 3.5;
              return (
                <g key={city.id} data-name={city.name} data-direct={city.direct || city.ferry || city.via || city.land ? '1' : undefined} opacity={!rainMode && dim(cat) ? 0.18 : 1} onPointerMove={(e) => show(e, target)} onClick={(e) => pinAt(e, target)}>
                  <circle cx={x} cy={y} r={9} fill="transparent" />
                  {wet && wet.level !== 'usual' && (
                    <circle cx={x} cy={y} r={dotR + (wet.level === 'much-wetter' ? 3.5 : 2.5)} fill="none" stroke="var(--info-ink)" strokeWidth={wet.level === 'much-wetter' ? 2.5 : 1.5} pointerEvents="none" data-wet={wet.level} />
                  )}
                  {city.land && landOnly(city.land) ? (
                    <circle cx={x} cy={y} r={active ? 6.5 : 5} fill={rainMode ? 'var(--surface-1)' : fill(cat)} stroke="var(--text-primary)" strokeWidth={2} strokeDasharray={LAND_DASH} pointerEvents="none" />
                  ) : city.ferry ? (
                    <circle cx={x} cy={y} r={active ? 6.5 : 5} fill={rainMode ? 'var(--surface-1)' : fill(cat)} stroke="var(--text-primary)" strokeWidth={2} strokeDasharray="2.5 1.5" pointerEvents="none" />
                  ) : city.via ? (
                    <circle cx={x} cy={y} r={active ? 6 : 4.5} fill={rainMode ? 'var(--surface-1)' : fill(cat)} stroke="var(--text-primary)" strokeWidth={1.6} strokeDasharray="1 1.6" pointerEvents="none" />
                  ) : city.direct ? (
                    <circle cx={x} cy={y} r={active ? 6.5 : 5} fill={rainMode ? 'var(--surface-1)' : fill(cat)} stroke="var(--text-primary)" strokeWidth={2} pointerEvents="none" />
                  ) : (
                    <circle cx={x} cy={y} r={active ? 5.5 : 3.5} fill={rainMode ? 'var(--surface-1)' : fill(cat)} stroke="var(--text-primary)" strokeOpacity={0.45} strokeWidth={1} pointerEvents="none" />
                  )}
                </g>
              );
            })}

            {visibleDests.map(({ dest, x, y }) => {
              const ev = evaluateDates(oStore.get(destinationId(dest)), dest.cc, dest.lat, dest.lon, tripMonths);
              const target: Target = { type: 'dest', dest };
              const key = targetKey(target);
              const active = key === hoverKey || key === pinnedKey;
              return (
                <g key={destinationId(dest)} data-name={dest.name} opacity={!rainMode && dim(ev.cls) ? 0.18 : 1} onPointerMove={(e) => show(e, target)} onClick={(e) => pinAt(e, target)}>
                  <circle cx={x} cy={y} r={10} fill="transparent" />
                  <rect x={x - (active ? 6 : 5)} y={y - (active ? 6 : 5)} width={active ? 12 : 10} height={active ? 12 : 10} rx={2} transform={`rotate(45 ${x} ${y})`} fill={rainMode ? 'var(--surface-1)' : fill(ev.cls)} stroke="var(--text-primary)" strokeOpacity={directAirlinesOn(dest, start ?? todayISO()) || dest.ferry || dest.land ? 1 : 0.5} strokeWidth={directAirlinesOn(dest, start ?? todayISO()) || dest.ferry || dest.land ? 2 : 1} strokeDasharray={landOnly(dest) ? LAND_DASH : dest.ferry ? '2.5 1.5' : undefined} pointerEvents="none" />
                </g>
              );
            })}

            <g pointerEvents="none">
              {/* 🎈 Wander list: a small balloon just above each place, at every zoom. */}
              {wander.map((w) => {
                const xy = projection([w.lon, w.lat]);
                if (!xy) return null;
                const [x, y] = t.apply(xy);
                if (!onScreen(x, y)) return null;
                return (
                  <text key={`w:${w.lat},${w.lon}`} x={x - 6} y={y - 8} className="map-wander" aria-hidden>
                    🎈
                  </text>
                );
              })}
              {!dates && t.k >= 2 && visibleCities.slice(0, 60).map(({ city, x, y }) => <g key={city.id}>{labelFor(city.name, x, y)}</g>)}
              {dates && t.k >= 2.5 && visibleDests.map(({ dest, x, y }) => <g key={destinationId(dest)}>{labelFor(dest.name, x, y)}</g>)}
            </g>

            {nowView &&
              hazards
                .filter((h) => h.kind === 'cyclone')
                .map((h) => {
                  const xy = projection([h.lon, h.lat]);
                  if (!xy) return null;
                  const [x, y] = t.apply(xy);
                  if (!onScreen(x, y, 20)) return null;
                  const target: Target = { type: 'hazard', hazard: h };
                  return (
                    <g key={h.id} data-name={h.name} onPointerMove={(e) => show(e, target)} onClick={(e) => pinAt(e, target)}>
                      <circle cx={x} cy={y} r={14} fill="transparent" />
                      <CycloneGlyph x={x} y={y} r={8} />
                      <text x={x + 12} y={y - 8} className="map-label strong">{h.name.replace('Tropical Cyclone ', '')}</text>
                    </g>
                  );
                })}

            {rainMode && (
              <MonsoonLabels
                months={rainMonths}
                hoverId={regimeHover?.id ?? null}
                project={(lon, lat) => {
                  const xy = projection([lon, lat]);
                  if (!xy) return null;
                  const p = t.apply(xy);
                  return onScreen(p[0], p[1], 0) ? p : null;
                }}
                onHover={(r) => setRegimeHover(r)}
              />
            )}

            {highlight && (() => {
              const xy = projection([highlight.lon, highlight.lat]);
              if (!xy) return null;
              const [x, y] = t.apply(xy);
              if (!onScreen(x, y, 0)) return null;
              return (
                <g pointerEvents="none" className="map-highlight">
                  <circle cx={x} cy={y} r={14} fill="var(--accent)" fillOpacity={0.15} stroke="var(--accent)" strokeWidth={2.5} />
                  <text x={x + 18} y={y + 4} className="map-label strong-ink">{highlight.name}</text>
                </g>
              );
            })()}

            {pin?.target?.type === 'place' && (() => {
              const xy = projection([pin.lon, pin.lat]);
              if (!xy) return null;
              const [x, y] = t.apply(xy);
              return (
                <g pointerEvents="none" className="map-found">
                  <circle cx={x} cy={y} r={12} fill="var(--accent)" fillOpacity={0.12} stroke="var(--surface-1)" strokeWidth={5} />
                  <circle cx={x} cy={y} r={12} fill="none" stroke="var(--accent)" strokeWidth={2.5} />
                </g>
              );
            })()}

            {focus && focusXY && (() => {
              const [x, y] = t.apply(focusXY);
              return (
                <g pointerEvents="none">
                  <circle cx={x} cy={y} r={11} fill="none" stroke="var(--surface-1)" strokeWidth={5} />
                  <circle cx={x} cy={y} r={11} fill="none" stroke="var(--text-primary)" strokeWidth={2} />
                  <text x={x + 15} y={y + 4} className="map-label strong-ink">{focus.name}</text>
                </g>
              );
            })()}
          </svg>
        )}

        {stat && finding && <MapFinder search={findPlaces} onPick={pickPlace} onClose={closeFinder} />}

        {zoomHint && (
          <div className="zoom-hint" role="status">
            {/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'} + scroll to zoom
          </div>
        )}

        {stat && !rainMode && keyGroups.length > 0 && <MapKey groups={keyGroups} />}
        {stat && (
          <div className="map-controls">
            {onShowViaChange && (
              <button
                type="button"
                className={`via-toggle${showVia ? ' on' : ''}`}
                aria-pressed={showVia}
                onClick={() => onShowViaChange(!showVia)}
                title="Places reached via a direct-flight city, e.g. Hoi An via Da Nang"
              >
                Via places <span aria-hidden>{showVia ? '●' : '○'}</span>
              </button>
            )}
            {onShowAdvisoriesChange && !rainMode && (
              <button
                type="button"
                className={`via-toggle${showAdvisories ? ' on' : ''}`}
                aria-pressed={showAdvisories}
                onClick={() => onShowAdvisoriesChange(!showAdvisories)}
                title="Singapore MFA travel advisories and notices"
              >
                Advisories <span aria-hidden>{showAdvisories ? '●' : '○'}</span>
              </button>
            )}
            <button
              type="button"
              className="map-find-btn"
              data-finder-toggle
              aria-label="Find a city on the map"
              aria-expanded={finding}
              title="Find a city or country (press /)"
              onClick={() => setFinding((f) => !f)}
            >
              🔍
            </button>
            <button type="button" aria-label="Zoom in" onClick={() => zoomTo(1.8)}>+</button>
            <button type="button" aria-label="Zoom out" onClick={() => zoomTo(1 / 1.8)}>−</button>
            <button type="button" onClick={() => zoomTo(homeTransform)} title="Centre on Singapore and Southeast Asia">SG</button>
            {focus && <button type="button" onClick={() => zoomTo(focusTransform)} title={`Centre on ${focus.name}`}>Dest</button>}
            <button type="button" onClick={() => zoomTo(zoomIdentity)} title="Show the whole world">World</button>
          </div>
        )}

        {rainMode && rainHover && rainField && (
          <div
            className="tooltip map-tooltip"
            style={{
              left: Math.min(Math.max(rainHover.x + 14, 4), (boxRef.current?.clientWidth ?? W) - 294),
              ...(rainHover.y > (boxRef.current?.clientHeight ?? H) / 2 ? { bottom: `calc(100% - ${rainHover.y - 10}px)` } : { top: rainHover.y + 14 }),
            }}
            role="status"
          >
            <RainDetails
              grid={rainField}
              lat={rainHover.lat}
              lon={rainHover.lon}
              name={hover ? targetName(hover.target) : undefined}
              months={rainMonths}
              label={monsoon ? `Average ${monthName(month)} rainfall` : 'Average monthly rainfall for your travel months'}
              regime={regimeHover}
            />
            <div className="small muted" style={{ marginTop: 4 }}>{hover && destFor(hover.target) && onWhenToGo ? 'Click for actions' : 'Click to keep this open'}</div>
          </div>
        )}

        {!rainMode && hover && stat && (
          <div
            className="tooltip map-tooltip"
            style={{
              left: Math.min(Math.max(hover.x + 14, 4), (boxRef.current?.clientWidth ?? W) - 294),
              ...(hover.y > (boxRef.current?.clientHeight ?? H) / 2 ? { bottom: `calc(100% - ${hover.y - 10}px)` } : { top: hover.y + 14 }),
            }}
            role="status"
          >
            {details(hover.target, true)}
            {hover.target.type !== 'nodata' && (
              <div className="small muted" style={{ marginTop: 4 }}>
                {destFor(hover.target) && (onAnalyse || onWhenToGo) ? 'Click for actions' : 'Click for details and sources'}
              </div>
            )}
          </div>
        )}

        {pin && stat && (() => {
          const xy = projection([pin.lon, pin.lat]);
          if (!xy) return null;
          const [x, y] = t.apply(xy);
          if (!docked && !onScreen(x, y, 0)) return null;
          const dest = pin.target ? destFor(pin.target) : null;
          const shown = pin.target && viewTarget(pin.target);
          // Rainfall: a country with climate zones gets its zones side by side.
          const pinZones = (() => {
            if (!rainMode || !climate) return null;
            const tg = pin.target;
            const cc = tg?.type === 'zone' ? tg.zone.cc : tg?.type === 'country' ? tg.point.cc : tg?.type === 'city' ? tg.point.cc : tg?.type === 'dest' ? tg.dest.cc : tg?.type === 'place' ? tg.place.cc : zoneAt(climate, pin.lat, pin.lon)?.cc;
            const zones = cc ? climate.byCc.get(cc) : undefined;
            return zones ? { zones, current: zoneFor(climate, cc!, pin.lat, pin.lon)?.id } : null;
          })();
          return (
            <MapPopover
              title={rainMode ? (pin.target ? targetName(pin.target) : 'Rainfall here') : popoverTitle(shown!)}
              anchor={docked ? null : { x: (x / W) * box.w, y: (y / H) * box.h }}
              box={box}
              onClose={() => setPin(null)}
              onPointerEnter={() => (setHover(null), setRainHover(null))}
              actions={
                dest && (onAnalyse || onWhenToGo) ? (
                  <>
                    {onAnalyse && datesValid && (
                      <button type="button" className="small primary" onClick={() => onAnalyse(dest, { start: start!, end: end! })}>
                        Analyse {formatShortDate(start!)} – {formatShortDate(end!)}
                      </button>
                    )}
                    {onWhenToGo && <button type="button" className="small" onClick={() => onWhenToGo(dest)}>☀ Sunny windows</button>}
                  </>
                ) : null
              }
            >
              {rainMode && rainField ? (
                <>
                  <RainDetails
                    grid={rainField}
                    lat={pin.lat}
                    lon={pin.lon}
                    months={rainMonths}
                    label={monsoon ? `Average ${monthName(month)} rainfall` : 'Average monthly rainfall for your travel months'}
                    regime={pin.regime}
                    hideName
                  />
                  {pinZones && <ZoneSides grid={rainField} zones={pinZones.zones} months={rainMonths} current={pinZones.current} />}
                  <NearbyRain grid={rainField} places={nearbyPlaces(nearbyCandidates, pin.lat, pin.lon)} months={rainMonths} />
                  <p className="small muted">
                    Source: <a href={rainField.metaAt(pin.lat, pin.lon).source.url} target="_blank" rel="noreferrer">{rainSourceLabel(rainField.metaAt(pin.lat, pin.lon)).name}</a>
                    {pin.regime && <> · <a href={pin.regime.source.url} target="_blank" rel="noreferrer">{pin.regime.source.name}</a></>}
                  </p>
                </>
              ) : shown ? (
                details(shown, false)
              ) : null}
            </MapPopover>
          );
        })()}
      </div>

      {nowView && hazardError && <p className="small muted">Active cyclone and fire data (GDACS) could not be loaded: {hazardError}</p>}
      {status.lastError && !status.rateLimitedUntil && <p className="small muted">{status.lastError}</p>}

      <details className="map-about">
        <summary>About this map &amp; data</summary>
        <div style={{ display: 'grid', gap: 10 }}>
      <p className="small muted">Pinch, double-click or ⌘/Ctrl + scroll to zoom (plain scrolling moves the page), and drag to pan. Use <strong>SG</strong> to return to Singapore and the region.</p>
      <CacheStatus />

      {stat && nowView && <CountryTable rows={tableRows(nowEval, nowZoneEval)} filter={filter} hazards={hazards} />}
      {stat && dates && !rainMode && <DatesTable rows={tableRows(datesEval, datesZoneEval)} filter={filter} />}

      {rain && rainMode && (
        <p className="small muted">
          Rainfall: average monthly precipitation for 1991–2020 from the{' '}
          <a href={rain.meta.source.url} target="_blank" rel="noreferrer">GPCP v2.3 monthly analysis</a> (satellite estimates merged with rain gauges, 2.5° grid, about 275 km) for the world view
          {rainAsia && (
            <>
              {' '}and, zoomed in over Asia and Australia, <a href={rainAsia.meta.source.url} target="_blank" rel="noreferrer">ERA5 monthly averages</a> (0.25° grid, about 28 km), which separate coasts with opposite monsoons such as Sri Lanka’s southwest and east
            </>
          )}
          , bundled with the app, so it uses no weather API calls. It shows the typical climate, smoothed over areas: mountains, coasts and small islands can be much wetter or drier,
          and any given year can differ. Monsoon labels and their dashed footprints are typical timings and areas from national met services. {rain.meta.source.citation}
          {rainAsia && <> {rainAsia.meta.source.citation}</>}
        </p>
      )}
      {monsoon ? null : dates ? (
        <p className="small muted">
          Ratings use the same scoring as the trip analysis (rain, temperature, humidity, seasonal risks): <strong>Pleasant</strong> or generally pleasant, <strong>Mixed</strong>, or <strong>Challenging</strong>.
          {' '}Data: <a href="https://open-meteo.com/en/docs" target="_blank" rel="noreferrer">Open-Meteo forecast</a> within 16 days, otherwise{' '}
          <a href="https://open-meteo.com/en/docs/historical-weather-api" target="_blank" rel="noreferrer">ERA5 reanalysis</a> for the same dates in recent years.
        </p>
      ) : (
        <p className="small muted">
          Ratings: <strong>Bad</strong> means a thunderstorm, heavy rain or snow, a feels-like temperature ≥38 °C or ≤0 °C, strong wind, unhealthy haze (PM2.5 ≥55 µg/m³) or a tropical cyclone within 300 km.
          {' '}<strong>Average</strong> means light rain, fog, a hot (&gt;31 °C) or cold (&lt;12 °C) feel, windy or muggy conditions, hazy air (PM2.5 ≥35 µg/m³) or elevated pollution (US AQI &gt;150). <strong>Good</strong> means none of these.
          {' '}Data: <a href="https://open-meteo.com/en/docs" target="_blank" rel="noreferrer">Open-Meteo</a> (weather; air quality from the CAMS model, which is not a ground-monitor reading and can overestimate. Check official readings such as <a href="https://www.haze.gov.sg/" target="_blank" rel="noreferrer">haze.gov.sg</a>),{' '}
          <a href={GDACS_SOURCE.url} target="_blank" rel="noreferrer">GDACS</a> (active cyclones and fires), <a href="https://www.geonames.org/" target="_blank" rel="noreferrer">GeoNames</a> (cities),{' '}
          <a href="https://en.wikipedia.org/wiki/Changi_Airport#Airlines_and_destinations" target="_blank" rel="noreferrer">Wikipedia</a> (direct routes from SIN).
        </p>
      )}
        </div>
      </details>
    </section>
  );
}

const POP_GAP = 14;
const POP_MARGIN = 8;
const POP_WIDTH = 300;

/**
 * The pinned popover. Beside the place horizontally (flipping to the side with more room);
 * vertically centred on it but kept inside the map, with an arrow pointing at the place. The
 * header holds the title and close button; only the details scroll, so the actions stay visible.
 * Without an anchor (narrow maps) it docks as a panel under the map.
 */
function MapPopover({
  title,
  anchor,
  box,
  onClose,
  onPointerEnter,
  actions,
  children,
}: {
  title: string;
  anchor: { x: number; y: number } | null;
  box: { w: number; h: number };
  onClose: () => void;
  onPointerEnter: () => void;
  actions: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setHeight(el.offsetHeight);
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  let style: React.CSSProperties | undefined;
  let arrow: { side: 'left' | 'right'; top: number } | null = null;
  if (anchor) {
    const maxH = box.h - POP_MARGIN * 2;
    const h = Math.min(height, maxH);
    const right = anchor.x + POP_GAP + POP_WIDTH <= box.w - POP_MARGIN || anchor.x < box.w / 2;
    const top = Math.max(POP_MARGIN, Math.min(anchor.y - h / 2, box.h - POP_MARGIN - h));
    const left = right ? anchor.x + POP_GAP : anchor.x - POP_GAP - POP_WIDTH;
    style = { left: Math.max(POP_MARGIN, Math.min(left, box.w - POP_MARGIN - POP_WIDTH)), top, maxHeight: maxH };
    arrow = { side: right ? 'left' : 'right', top: Math.max(14, Math.min(anchor.y - top, h - 14)) };
  }

  return (
    <div ref={ref} className={`map-popover${anchor ? '' : ' docked'}`} style={style} role="dialog" aria-label={title} onPointerEnter={onPointerEnter}>
      {arrow && <span className={`popover-arrow ${arrow.side}`} style={{ top: arrow.top }} aria-hidden />}
      <div className="popover-head">
        <strong>{title}</strong>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="popover-body">{children}</div>
      {actions && <div className="popover-actions">{actions}</div>}
    </div>
  );
}

function targetName(t: Target): string {
  return t.type === 'country' ? t.point.name
    : t.type === 'city' ? t.point.name
    : t.type === 'dest' ? t.dest.name
    : t.type === 'hazard' ? t.hazard.name
    : t.type === 'place' ? t.place.name
    : t.type === 'zone' ? `${t.country.name}: ${t.zone.name}`
    : t.name;
}

function targetKey(t: Target): string {
  return t.type === 'country' ? `c:${t.point.ccn3}`
    : t.type === 'city' ? t.point.id
    : t.type === 'dest' ? destinationId(t.dest)
    : t.type === 'hazard' ? t.hazard.id
    : t.type === 'place' ? `p:${foundId(t.place)}`
    : t.type === 'zone' ? `z:${t.zone.id}`
    : `n:${t.name}`;
}

function CycloneGlyph({ x, y, r }: { x: number; y: number; r: number }) {
  // Two opposing arcs around an eye.
  const a = r;
  return (
    <g pointerEvents="none">
      <circle cx={x} cy={y} r={a} fill="var(--surface-1)" fillOpacity={0.85} stroke="var(--critical)" strokeWidth={2} />
      <path d={`M ${x - a} ${y} A ${a} ${a} 0 0 1 ${x} ${y - a * 1.6}`} fill="none" stroke="var(--critical)" strokeWidth={2} strokeLinecap="round" />
      <path d={`M ${x + a} ${y} A ${a} ${a} 0 0 1 ${x} ${y + a * 1.6}`} fill="none" stroke="var(--critical)" strokeWidth={2} strokeLinecap="round" />
      <circle cx={x} cy={y} r={a * 0.3} fill="var(--critical)" />
    </g>
  );
}

function FireGlyph({ x, y }: { x: number; y: number }) {
  return <path d={`M ${x} ${y - 5} L ${x + 4} ${y + 3} L ${x - 4} ${y + 3} Z`} fill="var(--serious)" stroke="var(--text-primary)" strokeWidth={0.8} pointerEvents="none" />;
}

function DatesTargetDetails({
  target,
  store,
  months,
  plan,
  compact,
  start,
}: {
  target: Extract<Target, { type: 'country' | 'dest' }>;
  store: PointStore<TripOutlook>;
  months: number[];
  plan: OutlookPlan | undefined;
  compact: boolean;
  /** Trip start: routes that begin later don't count as direct. */
  start: string;
}) {
  const isDest = target.type === 'dest';
  const p = isDest ? target.dest : target.point;
  const id = isDest ? destinationId(target.dest) : `c:${target.point.ccn3}`;
  const ev = evaluateDates(store.get(id), p.cc, p.lat, p.lon, months);
  const title = isDest ? `${target.dest.name}${target.dest.country ? `, ${target.dest.country}` : ''}` : target.point.name;
  const airlines = isDest ? directAirlinesOn(target.dest, start) : undefined;
  const routeNotes = isDest ? datedRouteNotes(target.dest, start).map((n) => ` · ${n}`).join('') : '';
  const overland = isDest && target.dest.land ? `${landText(target.dest.land)} from ${target.dest.land.from}` : '';
  const subtitle = isDest && landOnly(target.dest)
    ? overland
    : isDest
    ? (target.dest.ferry
      ? `⛴ ${ferryText(target.dest.ferry)}`
      : target.dest.via
      ? `✈ ${viaText(target.dest.via)}`
      : airlines
      ? `✈ Direct: ${airlines.slice(0, 3).join(', ')}${airlines.length > 3 ? ` +${airlines.length - 3}` : ''}${routeNotes}`
      : target.dest.directAirlines
      ? `No direct flight on these dates${routeNotes}`
      : 'No direct flight from SIN') + (overland ? ` · ${overland}` : '')
    : target.point.point === 'capital'
      ? `Capital: ${target.point.capital}`
      : 'Country centre';
  return (
    <OutlookDetails
      title={title}
      subtitle={subtitle}
      outlook={ev.outlook}
      pending={ev.pending}
      suitability={ev.suitability}
      cls={ev.cls}
      risks={ev.risks}
      lat={p.lat}
      lon={p.lon}
      travel={isDest && landOnly(target.dest) ? overland : isDest && target.dest.ferry ? ferryText(target.dest.ferry) : isDest && target.dest.via ? viaText(target.dest.via) : undefined}
      basisLabel={shortBasis(plan)}
      compact={compact}
    />
  );
}

function TargetDetails({
  target,
  hazards,
  countryByCc,
  compact = false,
  onLoadNow,
  recent = null,
}: {
  target: Target;
  hazards: Hazard[];
  countryByCc: Map<string, CountryPoint>;
  compact?: boolean;
  /** Loads current weather from the API for a place with nothing stored. */
  onLoadNow?: (p: PointRequest) => void;
  /** Recent rain vs normal at this place, when stored. */
  recent?: RecentRain | null;
}) {
  if (target.type === 'nodata') {
    return (
      <>
        <div className="t">{target.name}</div>
        <div className="secondary small">No current data for this area</div>
      </>
    );
  }
  if (target.type === 'hazard') {
    const h = target.hazard;
    return (
      <div style={{ display: 'grid', gap: 4 }}>
        <div className="t">{h.name}</div>
        <div><Badge tone={h.alert === 'Red' ? 'critical' : h.alert === 'Orange' ? 'serious' : 'warning'}>GDACS {h.alert} alert</Badge></div>
        <div className="small secondary">{h.kind === 'cyclone' ? 'Active tropical cyclone' : h.kind === 'fire' ? 'Active forest fire, a common source of smoke haze' : 'Flood event'}{h.countries ? ` · ${h.countries}` : ''}</div>
        <div className="small secondary">Active since {h.from.slice(0, 10)}, last update {h.to.slice(0, 10)}</div>
        {!compact && h.url && <a className="small" href={h.url} target="_blank" rel="noreferrer">Open GDACS report</a>}
      </div>
    );
  }
  // Destinations are only shown in the dates view; places as a city or country; zones by the map.
  if (target.type === 'dest' || target.type === 'place' || target.type === 'zone') return null;

  const isCity = target.type === 'city';
  const p = target.point;
  const id = isCity ? (p as CityPoint).id : `c:${(p as CountryPoint).ccn3}`;
  const data = services.current.get(id);
  const countryName = countryByCc.get(p.cc)?.name ?? p.cc;
  const title = isCity && p.name !== countryName ? `${p.name}, ${countryName}` : p.name;
  const direct = isCity ? (p as MapCity).direct : undefined;
  const ferry = isCity ? (p as MapCity).ferry : undefined;
  const via = isCity ? (p as MapCity).via?.via : undefined;
  const land = isCity ? (p as MapCity).land : undefined;
  const overland = land?.land ? `${landText(land.land)} from ${land.land.from}` : '';
  const sub = land && landOnly(land)
    ? overland
    : ferry
    ? `⛴ ${ferryText(ferry)} (${ferry.ports})`
    : via
    ? `✈ No direct flight: ${viaText(via)}`
    : direct
    ? `Direct flights from SIN (${direct.airports.join(', ')})`
    : isCity
      ? (p as CityPoint).population ? `Population ${(p as CityPoint).population.toLocaleString('en-SG')}` : 'No direct flight or ferry from SIN'
      : (p as CountryPoint).point === 'capital'
        ? `Capital: ${(p as CountryPoint).capital}`
        : 'Country centre';
  const today = todayISO();
  const flyingNow = direct ? directAirlinesOn({ directAirlines: direct.airlines, directDated: direct.dated }, today) ?? [] : [];
  const routeNotes = direct ? datedRouteNotes({ directDated: direct.dated }, today) : [];
  const airlinesLine = direct ? (
    <div className="small secondary">
      ✈ {flyingNow.slice(0, 4).join(', ')}{flyingNow.length > 4 ? ` +${flyingNow.length - 4} more` : ''}
      {routeNotes.map((n, i) => <span key={n}>{flyingNow.length || i ? ' · ' : ''}{n}</span>)}
    </div>
  ) : null;

  // Loaded but nothing stored for the place (null, or a row without weather): offer to load it.
  const noData = data === null || (data !== undefined && !data.weather);
  if (!data?.weather) {
    return (
      <>
        <div className="t">{title}</div>
        <div className="secondary small">{sub}</div>
        {land && !landOnly(land) && <div className="secondary small">Or overland: {overland}</div>}
        <div className="secondary small">{noData ? 'No current data for this location.' : 'Loading current conditions…'}</div>
        {recent && <RecentRainLine r={recent} />}
        {noData && onLoadNow && (
          <div>
            <button type="button" className="small" onClick={() => onLoadNow({ id, lat: p.lat, lon: p.lon })}>Load current weather</button>{' '}
            <span className="small muted">about 2 weather API units</span>
          </div>
        )}
      </>
    );
  }
  const w = data.weather;
  const ev = evaluate(data, hazards, p.lat, p.lon)!;
  const phen = phenomenaFor(ev, hazards, p.lat, p.lon, p.cc);
  const now = phen.filter((x) => x.basis === 'now');
  const season = phen.filter((x) => x.basis === 'season');

  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <div className="t">{title}</div>
      <div className="secondary small">{sub} · local time {w.time.slice(11, 16)}{w.isDay ? '' : ' (night)'}</div>
      {airlinesLine}
      {land && !landOnly(land) && <div className="small secondary">Or overland: {overland}</div>}
      <div><Badge tone={TONE[ev.cls.category]}>{LABEL[ev.cls.category]}</Badge></div>
      <div style={{ fontSize: '1.2rem', fontWeight: 700 }}>
        {Math.round(w.tempC)} °C <span className="small secondary" style={{ fontWeight: 400 }}>feels {Math.round(w.feelsLikeC)} °C · {describeWeatherCode(w.weatherCode)}</span>
      </div>
      <div className="small secondary">
        Humidity {Math.round(w.humidityPct)}% · Wind {Math.round(w.windKmh)} km/h{w.gustKmh != null ? ` (gusts ${Math.round(w.gustKmh)})` : ''}
        {w.visibilityM != null && w.visibilityM < 10_000 ? ` · Visibility ${(w.visibilityM / 1000).toFixed(1)} km` : ''}
      </div>
      {data.aq && (
        <div className="small secondary">
          Air: {data.aq.usAqi != null ? `US AQI ${Math.round(data.aq.usAqi)} (${aqiCategory(data.aq.usAqi)})` : 'AQI n/a'} · PM2.5 {Math.round(data.aq.pm25)} µg/m³ <span className="muted">(modelled)</span>
        </div>
      )}
      {recent && <RecentRainLine r={recent} />}

      {(now.length > 0 || season.length > 0) && (
        <div className="phenomena">
          <div className="small" style={{ fontWeight: 700 }}>What's happening</div>
          {now.map((x) => (
            <div key={x.title} className="phen">
              <Badge tone={x.severity === 'high' ? 'critical' : x.severity === 'moderate' ? 'warning' : 'info'}>Now</Badge>
              <span className="small"><strong>{x.title}.</strong> {x.detail}</span>
            </div>
          ))}
          {season.map((x) => (
            <div key={x.title} className="phen">
              <Badge tone="info">Season</Badge>
              <span className="small"><strong>{x.title}.</strong> {compact ? firstSentence(x.detail) : x.detail}</span>
            </div>
          ))}
        </div>
      )}
      {now.length === 0 && season.length === 0 && <div className="small muted">No notable weather phenomena right now.</div>}

      {ev.cls.category !== 'good' && <div className="small secondary">Rating reason: {ev.cls.reasons.join('; ')}</div>}

      {!compact && (() => {
        // Folded by default: the list can run long (several met services for one country).
        const sources = [...new Map(phen.filter((x) => x.source).map((x) => [x.source!.url, x.source!])).values()];
        return (
          <details className="small muted popover-sources">
            <summary>Sources ({Math.max(1, sources.length)})</summary>
            {sources.map((s, i) => (
              <span key={s.url}>{i > 0 && ' · '}<a href={s.url} target="_blank" rel="noreferrer">{s.name}</a></span>
            ))}
            {sources.length === 0 && <a href="https://open-meteo.com/en/docs" target="_blank" rel="noreferrer">Open-Meteo</a>}
            . Seasonal entries describe typical patterns for this month, not a forecast.
          </details>
        );
      })()}
    </div>
  );
}

function firstSentence(s: string): string {
  const i = s.indexOf('. ');
  return i > 0 ? s.slice(0, i + 1) : s;
}

/** A row of the country tables: a country, or one climate zone of a country that has them. */
interface TableRow<E> {
  key: string;
  name: string;
  cc: string;
  lat: number;
  lon: number;
  ev: E | undefined;
}

/** Accessible table view of live country data, for keyboard and screen-reader users and touch devices. */
function CountryTable({ rows: all, filter, hazards }: { rows: TableRow<Evaluated | null>[]; filter: ConditionClass | null; hazards: Hazard[] }) {
  const rows = all
    .filter((r): r is TableRow<Evaluated> & { ev: Evaluated } => Boolean(r.ev) && (filter === null || r.ev!.cls.category === filter))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <details>
      <summary>Country list ({rows.length}{filter ? ` ${LABEL[filter].toLowerCase()}` : ''})</summary>
      <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
        <table>
          <thead>
            <tr><th>Country</th><th>Rating</th><th>Temp</th><th>Feels</th><th>Conditions</th><th>AQI</th><th>Wind</th><th>Phenomena now</th></tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const ev = c.ev;
              const w = ev.data.weather!;
              const now = phenomenaFor(ev, hazards, c.lat, c.lon, c.cc).filter((p) => p.basis === 'now').map((p) => p.title);
              return (
                <tr key={c.key}>
                  <td>{c.name}</td>
                  <td><Badge tone={TONE[ev.cls.category]}>{LABEL[ev.cls.category]}</Badge></td>
                  <td>{Math.round(w.tempC)} °C</td>
                  <td>{Math.round(w.feelsLikeC)} °C</td>
                  <td style={{ textAlign: 'left' }}>{describeWeatherCode(w.weatherCode)}</td>
                  <td>{ev.data.aq?.usAqi != null ? Math.round(ev.data.aq.usAqi) : '—'}</td>
                  <td>{Math.round(w.windKmh)} km/h</td>
                  <td style={{ textAlign: 'left' }}>{now.join(', ') || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Table view of the travel-dates outlook per country. */
function DatesTable({ rows: all, filter }: { rows: TableRow<DatesEval>[]; filter: ConditionClass | null }) {
  const rows = all
    .filter((r): r is TableRow<DatesEval> & { ev: DatesEval } => Boolean(r.ev?.outlook && r.ev.suitability) && (filter === null || r.ev!.cls === filter))
    .sort((a, b) => b.ev.suitability!.score - a.ev.suitability!.score);
  return (
    <details>
      <summary>Country list for your dates ({rows.length}, best first)</summary>
      <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
        <table>
          <thead>
            <tr><th>Country (capital or climate zone)</th><th>Rating</th><th>High / low</th><th>Wet days</th><th>Rain</th><th>Humidity</th><th style={{ textAlign: 'left' }}>Seasonal risks</th></tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const ev = c.ev;
              const o = ev.outlook!;
              return (
                <tr key={c.key}>
                  <td>{c.name}</td>
                  <td><Badge tone={TONE[ev.cls!]}>{ev.suitability!.rating}</Badge></td>
                  <td>{Math.round(o.tMaxC)}° / {Math.round(o.tMinC)}°</td>
                  <td>{o.wetDays.toFixed(1)} of {o.tripDays}</td>
                  <td>{Math.round(o.totalRainMm)} mm</td>
                  <td>{o.rhPct != null ? `${Math.round(o.rhPct)}%` : '—'}</td>
                  <td style={{ textAlign: 'left' }}>{ev.risks.filter((r) => r.severity !== 'info').map((r) => r.title).join('; ') || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Last 30 days' rain against normal, with a badge when it has been unusually wet. */
function RecentRainLine({ r }: { r: RecentRain }) {
  const x = timesNormal(r.mm30, r.normal30);
  return (
    <div style={{ display: 'grid', gap: 2 }}>
      {r.level !== 'usual' && <div><Badge tone="info">{RECENT_RAIN_LABEL[r.level]}</Badge></div>}
      <div className="small secondary">
        Last 30 days: {Math.round(r.mm30)} mm{x ? `, ${x} normal (${Math.round(r.normal30)} mm)` : ''} · rain on {r.wetDays30} of 30 days, usual {Math.round(r.usualWetDays30)}
      </div>
    </div>
  );
}

const MAP_KEY_PREF = 'wandercast.mapKeyOpen';

/**
 * The map key: closed, a small "Map key" pill in the map's bottom-left corner; open, a compact
 * card there with a column per group. On phones it sits under the map as a strip instead (CSS).
 * Open or closed is remembered in this browser.
 */
function MapKey({ groups }: { groups: { name: string; items: ReactNode[] }[] }) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(MAP_KEY_PREF) === '1';
    } catch {
      return false;
    }
  });
  const toggle = (v: boolean) => {
    setOpen(v);
    try {
      localStorage.setItem(MAP_KEY_PREF, v ? '1' : '0');
    } catch {
      /* storage unavailable: the choice lasts this visit */
    }
  };
  if (!open) {
    return (
      <button type="button" className="map-key-pill" aria-expanded={false} onClick={() => toggle(true)}>
        Map key
      </button>
    );
  }
  return (
    <div className="map-key" role="group" aria-label="Map key">
      {groups.map((g) => (
        <div key={g.name} className="map-key-col">
          <span className="map-key-head">{g.name}</span>
          {g.items}
        </div>
      ))}
      <button type="button" className="map-key-close" aria-label="Hide map key" aria-expanded onClick={() => toggle(false)}>
        ✕
      </button>
    </div>
  );
}
