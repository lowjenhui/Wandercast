// Wandercast brand pieces: the logo mark and "Puff", the little cloud mascot that keeps you
// company in empty and loading states.

import { useId } from 'react';

/** Logo: a pastel sky with a sun, a puffy cloud and a dotted wandering trail to a paper plane. */
export function Logo({ size = 40 }: { size?: number }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#7cc4f8" />
          <stop offset="0.65" stopColor="#bfe5ff" />
          <stop offset="1" stopColor="#ffe6c4" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="18" fill={`url(#${id}-sky)`} />
      {/* Sun with rays */}
      <g transform="translate(44 19)">
        <g stroke="#ffc94d" strokeWidth="2.6" strokeLinecap="round">
          <path d="M0 -12.5v-3.5M0 12.5v3.5M-12.5 0h-3.5M12.5 0h3.5M-8.8 -8.8l-2.5 -2.5M8.8 8.8l2.5 2.5M-8.8 8.8l-2.5 2.5M8.8 -8.8l2.5 -2.5" />
        </g>
        <circle r="8.5" fill="#ffd166" />
      </g>
      {/* Puffy cloud */}
      <path d="M18 36.5c0-5.2 4.2-9.4 9.4-9.4 3.6 0 6.7 2 8.3 5 1.2-.6 2.5-.9 3.9-.9 4.8 0 8.6 3.8 8.6 8.6v.6H20.4A3.6 3.6 0 0 1 18 36.5z" fill="#ffffff" />
      {/* Dotted wandering trail to a coral paper plane */}
      <path d="M9 55c5 0 7-5 12-5.5s7 3.5 12 2.5 7-5 11-6" fill="none" stroke="#ffffff" strokeWidth="2.8" strokeLinecap="round" strokeDasharray="0.1 5.4" />
      <circle cx="9" cy="55" r="2.6" fill="#ff7f6e" />
      <g transform="translate(46 45) rotate(-18)">
        <path d="M0 0l11 -4 -4 11 -2 -5z" fill="#ff7f6e" />
      </g>
    </svg>
  );
}

export type MascotMood = 'happy' | 'searching' | 'sleepy' | 'lookout';

/**
 * Puff: a small cloud with a sunhat and a backpack. Decorative (aria-hidden), so it never
 * carries meaning on its own; the text next to it says what's happening.
 */
export function Mascot({ mood = 'happy', size = 76, float = true }: { mood?: MascotMood; size?: number; float?: boolean }) {
  return (
    <svg className={`mascot${float ? ' mascot-float' : ''}`} width={size} height={size * 0.82} viewBox="0 0 100 82" aria-hidden>
      {/* soft ground shadow */}
      <ellipse cx="50" cy="78" rx="26" ry="3.2" fill="#24324a" opacity="0.08" />
      {/* backpack strap + pack */}
      <rect x="64" y="40" width="16" height="20" rx="5" fill="#ff7f6e" />
      <rect x="67" y="45" width="10" height="5" rx="2" fill="#ffd2c9" />
      {/* cloud body */}
      <path
        d="M20 56c-7.5 0-12-5-12-11 0-6.4 5.2-11.3 11.6-11 1.6-9.4 9.8-16.5 19.6-16.5 7.4 0 13.8 4 17.2 10 1.8-.7 3.7-1 5.7-1 9.1 0 16.4 7 16.4 15.7 0 7.9-6.2 13.8-14.6 13.8H20z"
        fill="#ffffff"
        stroke="#cfe0f5"
        strokeWidth="2"
      />
      {/* sunhat */}
      <ellipse cx="44" cy="20.5" rx="17" ry="4.2" fill="#ffc94d" />
      <path d="M34 20.5c0-6 4.5-10 10-10s10 4 10 10z" fill="#ffd166" />
      <rect x="34.3" y="17.2" width="19.4" height="3" rx="1.5" fill="#ff7f6e" />
      {/* face */}
      {mood === 'sleepy' ? (
        <g stroke="#24324a" strokeWidth="2.2" strokeLinecap="round" fill="none">
          <path d="M33 40c2 2 5 2 7 0" />
          <path d="M50 40c2 2 5 2 7 0" />
        </g>
      ) : mood === 'lookout' ? (
        // Binoculars, for Puff's Lookout.
        <g>
          <g fill="#24324a">
            <rect x="29" y="33" width="12" height="11" rx="4.5" />
            <rect x="47" y="33" width="12" height="11" rx="4.5" />
            <rect x="40" y="36" width="8" height="3.4" rx="1.2" />
          </g>
          <circle cx="35" cy="38.5" r="2.7" fill="#8ccaff" />
          <circle cx="53" cy="38.5" r="2.7" fill="#8ccaff" />
          <circle cx="34" cy="37.4" r="0.9" fill="#fff" />
          <circle cx="52" cy="37.4" r="0.9" fill="#fff" />
        </g>
      ) : (
        <g fill="#24324a">
          <ellipse cx={mood === 'searching' ? 38.5 : 36.5} cy="39" rx="2.6" ry="3.2" />
          <ellipse cx={mood === 'searching' ? 55.5 : 53.5} cy="39" rx="2.6" ry="3.2" />
          <circle cx={mood === 'searching' ? 39.4 : 37.4} cy="37.8" r="0.9" fill="#fff" />
          <circle cx={mood === 'searching' ? 56.4 : 54.4} cy="37.8" r="0.9" fill="#fff" />
        </g>
      )}
      <circle cx="30" cy="46" r="3.4" fill="#ffb3a7" opacity="0.7" />
      <circle cx="60" cy="46" r="3.4" fill="#ffb3a7" opacity="0.7" />
      {mood === 'sleepy' ? (
        <path d="M42 48c1.5 1 4.5 1 6 0" stroke="#24324a" strokeWidth="2" strokeLinecap="round" fill="none" />
      ) : (
        <path d="M40 46.5c2.5 3 7.5 3 10 0" stroke="#24324a" strokeWidth="2.2" strokeLinecap="round" fill="none" />
      )}
      {/* mood props */}
      {mood === 'happy' && <path d="M12 38c-4-3-5-8-3-11" stroke="#cfe0f5" strokeWidth="5" strokeLinecap="round" fill="none" />}
      {mood === 'searching' && (
        <g transform="translate(86 30)">
          <circle r="7" fill="#e8f4ff" stroke="#3b8fe6" strokeWidth="2.6" />
          <path d="M-5 5l-7 7" stroke="#3b8fe6" strokeWidth="3.2" strokeLinecap="round" />
        </g>
      )}
      {mood === 'sleepy' && (
        <g fill="#7d879a" fontFamily="Fredoka, sans-serif" fontWeight="600">
          <text x="76" y="22" fontSize="11">z</text>
          <text x="84" y="13" fontSize="8">z</text>
        </g>
      )}
    </svg>
  );
}
