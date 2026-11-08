import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, Polygon, Rect, Stop } from 'react-native-svg';

import { aura } from '../theme/aura';

export interface WaveformViewProps {
  /** Normalised peaks 0..1, oldest sample first. */
  peaks: readonly number[];
  /** 0..1 playhead. */
  progress: number;
  height?: number;
  accent?: string;
  /** Milliseconds of audio the peaks cover, shown as a subtle grid. */
  bars?: number;
}

/**
 * Mirror waveform drawn as a single SVG polygon.
 *
 * One path for the whole shape, not 200 rectangles: a phone that is already
 * running a realtime audio callback has no cycles to spare on layout.
 */
export function WaveformView({ peaks, progress, height = 72, accent, bars = 4 }: WaveformViewProps) {
  const tint = accent ?? aura.color.cyan;
  const width = 320;

  const points = useMemo(() => {
    if (peaks.length === 0) return { outline: '', playX: 0 };
    const step = width / Math.max(1, peaks.length - 1);
    const mid = height / 2;
    const top: string[] = [];
    const bottom: string[] = [];
    peaks.forEach((peak, index) => {
      const amplitude = Math.max(0.02, Math.min(1, peak)) * (mid - 2);
      const x = index * step;
      top.push(`${x.toFixed(1)},${(mid - amplitude).toFixed(1)}`);
      bottom.push(`${x.toFixed(1)},${(mid + amplitude).toFixed(1)}`);
    });
    return {
      outline: [...top, ...bottom.reverse()].join(' '),
      playX: Math.max(0, Math.min(width, progress * width)),
    };
  }, [peaks, progress, height]);

  return (
    <View style={[styles.wrap, { height }]}>
      <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <Defs>
          <LinearGradient id="auraWave" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0%" stopColor={tint} stopOpacity={0.85} />
            <Stop offset="100%" stopColor={aura.color.pink} stopOpacity={0.7} />
          </LinearGradient>
        </Defs>
        {Array.from({ length: bars }).map((_, index) => (
          <Rect
            key={`bar-${index}`}
            x={(width / bars) * index}
            y={0}
            width={1}
            height={height}
            fill={aura.color.border}
          />
        ))}
        {points.outline ? <Polygon points={points.outline} fill="url(#auraWave)" /> : null}
        <Rect x={points.playX} y={0} width={2} height={height} fill={aura.color.green} opacity={0.9} />
      </Svg>
    </View>
  );
}

/** Cheap deterministic peaks generator: real analysis belongs in the core. */
export function syntheticPeaks(count = 96, seed = 7): number[] {
  const values: number[] = [];
  let state = seed;
  for (let i = 0; i < count; i += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const noise = state / 2147483648;
    const envelope = 0.55 + 0.45 * Math.sin((i / count) * Math.PI * 4);
    values.push(Math.max(0.05, Math.min(1, noise * envelope + 0.15)));
  }
  return values;
}

const styles = StyleSheet.create({
  wrap: {
    borderRadius: aura.radius.md,
    backgroundColor: aura.color.surface,
    borderWidth: 1,
    borderColor: aura.color.border,
    overflow: 'hidden',
    paddingHorizontal: 2,
  },
});
