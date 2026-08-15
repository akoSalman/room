// A small circular countdown showing how long a disappearing message has left.
//
// Drawn without react-native-svg, which is not a dependency here and would be
// a native addition for one 14px widget. The classic two-half-disc trick does
// it with plain views: each half of the circle is covered by a rotating panel,
// the right half sweeps the first 180° and the left half the rest.
import React, { useEffect, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { remainingFraction, tickInterval } from '../expiryRing';

export default function ExpiryRing({
  expiresAt, seconds, size = 14, color = '#f87171', track = 'rgba(148,163,184,0.35)',
}: {
  expiresAt: number;
  seconds: number;
  size?: number;
  color?: string;
  track?: string;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), tickInterval(seconds));
    return () => clearInterval(t);
  }, [seconds]);

  const frac = remainingFraction(expiresAt, seconds, now);
  const deg = frac * 360;
  const half = size / 2;

  // Right half sweeps 0–180°, then parks; left half handles the remainder.
  const rightRot = Math.min(180, deg);
  const leftRot = Math.max(0, deg - 180);

  const halfStyle = {
    position: 'absolute' as const,
    width: half,
    height: size,
    backgroundColor: color,
  };

  return (
    <View style={[s.wrap, { width: size, height: size, borderRadius: half, backgroundColor: track }]}>
      {/* Left half of the dial */}
      <View style={[s.clip, { width: half, height: size, left: 0, borderTopLeftRadius: half, borderBottomLeftRadius: half }]}>
        <View style={[halfStyle, {
          left: 0,
          borderTopLeftRadius: half, borderBottomLeftRadius: half,
          transform: [{ translateX: half / 2 }, { rotate: `${-leftRot}deg` }, { translateX: -half / 2 }],
          opacity: leftRot > 0 ? 1 : 0,
        }]} />
      </View>
      {/* Right half of the dial */}
      <View style={[s.clip, { width: half, height: size, left: half, borderTopRightRadius: half, borderBottomRightRadius: half }]}>
        <View style={[halfStyle, {
          left: 0,
          borderTopRightRadius: half, borderBottomRightRadius: half,
          transform: [{ translateX: -half / 2 }, { rotate: `${180 - rightRot}deg` }, { translateX: half / 2 }],
          opacity: rightRot > 0 ? 1 : 0,
        }]} />
      </View>
      {/* Hollow centre, so it reads as a ring rather than a pie. */}
      <View style={[s.hole, {
        width: size * 0.52, height: size * 0.52, borderRadius: size * 0.26,
      }]} />
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  clip: { position: 'absolute', top: 0, overflow: 'hidden' },
  hole: { backgroundColor: 'transparent', borderWidth: 0 },
});
