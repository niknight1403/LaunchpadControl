import { useCallback, useEffect, useRef } from 'react';
import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

/**
 * Velocity-graded haptics.
 *
 * Mapping is deliberately non-linear: light taps must stay silent-ish in the
 * hand, hard hits must be felt through a phone in a club. The throttle prevents
 * the Android vibrator from queueing up during a fast pad roll.
 */
export function usePadHaptics() {
  const lastFireAt = useRef(0);

  const fire = useCallback(async (velocity: number, kind: 'pad' | 'control' = 'pad') => {
    if (Platform.OS !== 'android') return;
    const now = Date.now();
    const minInterval = kind === 'pad' ? 18 : 40;
    if (now - lastFireAt.current < minInterval) return;
    lastFireAt.current = now;

    const style =
      velocity > 0.85
        ? Haptics.ImpactFeedbackStyle.Heavy
        : velocity > 0.55
          ? Haptics.ImpactFeedbackStyle.Medium
          : Haptics.ImpactFeedbackStyle.Light;

    try {
      await Haptics.impactAsync(style);
    } catch {
      // Haptics are a nicety; a missing vibrator must never break a set.
    }
  }, []);

  const notify = useCallback(async (type: 'success' | 'warning') => {
    if (Platform.OS !== 'android') return;
    try {
      if (type === 'success') await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      else await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    } catch {
      /* no-op */
    }
  }, []);

  return { fire, notify };
}

/** Keeps a ref in sync for use inside long-lived native listeners. */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
