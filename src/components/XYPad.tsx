import React, { useCallback, useMemo, useRef } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';

import { aura } from '../theme/aura';

/** Structural type for a responder event: keeps this file free of RN type imports. */
type TouchLike = { nativeEvent: { locationX: number; locationY: number } };

export interface XYPadProps {
  /** x = 0..1 (left-right), y = 0..1 (bottom-top). */
  onChange: (x: number, y: number) => void;
  onRelease?: (x: number, y: number) => void;
  size?: number;
  label?: string;
  accent?: string;
}

/**
 * Two-parameter FX sweep surface.
 *
 * Reports continuously while a finger is down: filter sweeps need every frame,
 * not a value on release. `onRelease` is where a UI usually re-centres, which is
 * why it is separate.
 */
export function XYPad({ onChange, onRelease, size = 160, label = 'FX XY', accent }: XYPadProps) {
  const position = useRef({ x: 0.5, y: 0.5 });
  const sizeRef = useRef(size);
  sizeRef.current = size;

  const emit = useCallback(
    (locationX: number, locationY: number) => {
      const dimension = sizeRef.current;
      const x = Math.max(0, Math.min(1, locationX / dimension));
      const y = 1 - Math.max(0, Math.min(1, locationY / dimension));
      position.current = { x, y };
      onChange(x, y);
    },
    [onChange],
  );

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event: TouchLike) => emit(event.nativeEvent.locationX, event.nativeEvent.locationY),
        onPanResponderMove: (event: TouchLike) => emit(event.nativeEvent.locationX, event.nativeEvent.locationY),
        onPanResponderRelease: () => onRelease?.(position.current.x, position.current.y),
        onPanResponderTerminate: () => onRelease?.(position.current.x, position.current.y),
      }),
    [emit, onRelease],
  );

  const tint = accent ?? aura.color.pink;

  return (
    <View style={styles.wrap}>
      <View style={[styles.surface, { width: size, height: size }]} {...responder.panHandlers}>
        <View style={styles.crosshairH} pointerEvents="none" />
        <View style={styles.crosshairV} pointerEvents="none" />
        <View
          style={[
            styles.marker,
            {
              left: `${position.current.x * 100}%`,
              bottom: `${position.current.y * 100}%`,
              borderColor: tint,
              shadowColor: tint,
            },
          ]}
          pointerEvents="none"
        />
        <Text style={styles.axis} pointerEvents="none">
          Y
        </Text>
        <Text style={[styles.axis, styles.axisX]} pointerEvents="none">
          X
        </Text>
      </View>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: 6 },
  surface: {
    borderRadius: aura.radius.lg,
    backgroundColor: aura.color.surface,
    borderWidth: 1,
    borderColor: aura.color.border,
    overflow: 'hidden',
  },
  crosshairH: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '50%',
    height: 1,
    backgroundColor: aura.color.border,
  },
  crosshairV: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: '50%',
    width: 1,
    backgroundColor: aura.color.border,
  },
  marker: {
    position: 'absolute',
    width: 18,
    height: 18,
    marginLeft: -9,
    marginBottom: -9,
    borderRadius: 9,
    borderWidth: 2,
    backgroundColor: 'rgba(11,15,25,0.55)',
    shadowRadius: 12,
    shadowOpacity: 0.9,
    shadowOffset: { width: 0, height: 0 },
  },
  axis: { position: 'absolute', top: 4, left: 6, color: aura.color.textFaint, fontSize: 9 },
  axisX: { top: undefined, bottom: 4, left: undefined, right: 6 },
  label: { color: aura.color.textDim, fontSize: 10, fontFamily: aura.font.mono },
});
