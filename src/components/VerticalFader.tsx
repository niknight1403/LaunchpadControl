import React, { useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';

import { aura } from '../theme/aura';

/** Structural type for a responder event: keeps this file free of RN type imports. */
type TouchLike = { nativeEvent: { locationX: number; locationY: number } };

export interface VerticalFaderProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  color?: string;
  height?: number;
}

/**
 * Vertical fader with a PanResponder, not a gesture library: this control sits
 * under a thumb during a set and must not fight with a scroll view for the
 * gesture. Values are clamped and quantised to 0.01.
 */
export function VerticalFader({ label, value, onChange, onCommit, color, height = 120 }: VerticalFaderProps) {
  const [dragging, setDragging] = useState(false);
  const heightRef = useRef(height);
  heightRef.current = height;

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event: TouchLike) => {
          setDragging(true);
          emit(event.nativeEvent.locationY);
        },
        onPanResponderMove: (event: TouchLike) => emit(event.nativeEvent.locationY),
        onPanResponderRelease: () => {
          setDragging(false);
          onCommit?.(value);
        },
        onPanResponderTerminate: () => setDragging(false),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [value],
  );

  function emit(locationY: number) {
    const ratio = 1 - Math.max(0, Math.min(heightRef.current, locationY)) / heightRef.current;
    onChange(Math.round(ratio * 100) / 100);
  }

  const tint = color ?? aura.color.cyan;
  const filled = Math.round(value * 100);

  return (
    <View style={styles.wrap}>
      <View style={[styles.track, { height }]} {...responder.panHandlers}>
        <View style={[styles.fill, { height: `${filled}%`, backgroundColor: tint, opacity: dragging ? 0.9 : 0.65 }]} />
        <View style={[styles.thumb, { bottom: `${filled}%`, borderColor: tint }]} />
      </View>
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[styles.value, { color: tint }]}>{Math.round(value * 100)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: 6 },
  track: {
    width: 26,
    borderRadius: aura.radius.sm,
    backgroundColor: aura.color.surface,
    borderWidth: 1,
    borderColor: aura.color.border,
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  fill: { width: '100%' },
  thumb: {
    position: 'absolute',
    left: 1,
    right: 1,
    height: 4,
    borderRadius: 2,
    borderWidth: 1,
    backgroundColor: aura.color.oled,
  },
  label: { color: aura.color.textDim, fontSize: 10, maxWidth: 48, textAlign: 'center' },
  value: { fontSize: 11, fontFamily: aura.font.mono },
});
