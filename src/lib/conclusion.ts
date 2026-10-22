import type { PlaceSafety } from '../services/advisories';
import { LEVEL_LABEL } from './advisory';
import type { FareAssessment } from './fareAnalysis';
import type { WeatherAnalysis } from './weatherAnalysis';

export interface Conclusion {
  /** null when the evidence is insufficient for an overall verdict. */
  verdict: 'Favourable' | 'Mixed' | 'Unfavourable' | null;
  text: string;
}

export function concludeTrip(
  weather: WeatherAnalysis | null,
  fares: FareAssessment | null,
  safety: PlaceSafety | null = null,
  /** Reached by ferry or overland: there's no airfare to judge, so the weather decides. */
  noFlight: 'ferry' | 'land' | null = null,
): Conclusion {
  const base = concludeWeatherAndFare(weather, fares, noFlight);
  const level = safety?.advisory.level ?? 'none';
  const where = safety?.advisory.hits[0]?.label;
  const cover = safety ? ` ${safety.coverage.short}.` : '';
  // MFA's advice outranks weather and price: never recommend a trip MFA says to defer.
  if (level === 'all') return { verdict: 'Unfavourable', text: `MFA advises Singaporeans to defer all travel to ${where ?? 'this destination'}.${cover} Consider another destination or dates.` };
  if (level === 'nonEssential') {
    return { verdict: base.verdict === 'Favourable' ? 'Mixed' : base.verdict, text: `MFA advises deferring non-essential travel to ${where ?? 'this destination'}.${cover} ${base.text}` };
  }
  if (level === 'unknown') return { ...base, text: `MFA has updated its advice for this destination: ${LEVEL_LABEL.unknown.toLowerCase()} before booking. ${base.text}` };
  return base;
}

function concludeWeatherAndFare(weather: WeatherAnalysis | null, fares: FareAssessment | null, noFlight: 'ferry' | 'land' | null = null): Conclusion {
  const weatherOk = Boolean(weather?.suitability && weather.confidence !== 'low');
  const fareSignal = fares?.value ?? fares?.seasonal?.position ?? null;
  const fareOk = Boolean(fares?.benchmark.sufficient && fareSignal);

  const weatherGood = weather?.suitability && ['Pleasant', 'Generally pleasant'].includes(weather.suitability.rating);
  const weatherBad = weather?.suitability?.rating === 'Challenging';
  const fareGood = fareSignal === 'Good value' || fareSignal === 'Cheaper than usual';
  const fareBad = fareSignal === 'Expensive' || fareSignal === 'Pricier than usual';

  if (!weatherOk && !fareOk) {
    return { verdict: null, text: 'There is not enough reliable evidence for an overall conclusion. See the details below.' };
  }
  if (!fareOk && noFlight && weatherOk) {
    const rating = weather!.suitability!.rating;
    return {
      verdict: weatherGood ? 'Favourable' : weatherBad ? 'Unfavourable' : 'Mixed',
      text: `Weather: ${rating.toLowerCase()} for these dates. No flight is needed (${noFlight === 'land' ? 'reached overland' : 'reached by ferry'}), so the weather decides.`,
    };
  }
  if (!fareOk) {
    return {
      verdict: null,
      text: `Weather: ${weather!.suitability!.rating.toLowerCase()} for these dates. There is not enough airfare evidence to judge value, so no overall value conclusion is given.`,
    };
  }
  if (!weatherOk) {
    return {
      verdict: null,
      text: `Airfare: ${fareSignal!.toLowerCase()}. The weather evidence is too limited for an overall conclusion.`,
    };
  }

  const w = weather!.suitability!.rating.toLowerCase();
  const f = fareSignal!.toLowerCase();
  if (weatherGood && fareGood) return { verdict: 'Favourable', text: `A favourable period: weather is historically ${w} and the fare is ${f}.` };
  if (weatherBad && fareBad) return { verdict: 'Unfavourable', text: `An unfavourable period: weather is historically ${w} and the fare is ${f}. Other dates may offer better value.` };
  if (weatherBad && fareGood) return { verdict: 'Mixed', text: `The fare is ${f}, but the weather is historically ${w}. Low prices here may reflect the off-season.` };
  if (weatherGood && fareBad) return { verdict: 'Mixed', text: `The weather is historically ${w}, but the fare is ${f}. This is likely peak-season demand.` };
  return { verdict: 'Mixed', text: `A middling period: weather is historically ${w} and the fare is ${f}.` };
}
