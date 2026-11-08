import React, { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { aura, rgbHex, type AuraPadState } from '../theme/aura';

export interface PadGridProps {
  /** grid[y][x], y = 0 is the top visual row, exactly like the hardware flipped. */
  grid: AuraPadState[][];
  labels?: string[][];
  onPadPress?: (x: number, y: number) => void;
  onPadRelease?: (x: number, y: number) => void;
  compact?: boolean;
}

const SIZE = 8;

function PadGridInner({ grid, labels, onPadPress, onPadRelease, compact }: PadGridProps) {
  return (
    <View style={styles.wrap}>
      {Array.from({ length: SIZE }).map((_, y) => (
        <View key={`row-${y}`} style={styles.row}>
          {Array.from({ length: SIZE }).map((_, x) => {
            const state = grid[y]?.[x] ?? 'idle';
            const color = aura.pad[state];
            const isLit = state !== 'idle';
            return (
              <Pressable
                key={`pad-${x}-${y}`}
                onPressIn={() => onPadPress?.(x, y)}
                onPressOut={() => onPadRelease?.(x, y)}
                android_ripple={{ color: 'rgba(255,255,255,0.06)' }}
                style={[
                  styles.pad,
                  compact ? styles.padCompact : null,
                  {
                    backgroundColor: isLit ? rgbHex(color) : aura.color.surface,
                    borderColor: isLit ? rgbHex(color) : aura.color.border,
                    shadowColor: isLit ? rgbHex(color) : 'transparent',
                    shadowOpacity: isLit ? 0.55 : 0,
                  },
                ]}
              >
                <Text style={[styles.label, isLit ? styles.labelLit : null]} numberOfLines={1}>
                  {labels?.[y]?.[x] ?? ''}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

export const PadGrid = memo(PadGridInner);

const styles = StyleSheet.create({
  wrap: { gap: 6, alignSelf: 'center' },
  row: { flexDirection: 'row', gap: 6 },
  pad: {
    width: 44,
    height: 44,
    borderRadius: aura.radius.sm,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
    elevation: 3,
  },
  padCompact: { width: 36, height: 36 },
  label: { color: aura.color.textFaint, fontSize: 9, fontFamily: aura.font.mono },
  labelLit: { color: aura.color.oled, fontWeight: '700' },
});
