import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import { AudioEngine } from './src/engine/AudioEngine';
import { LaunchpadMidiManager } from './src/midi/LaunchpadMidiManager';
import { createMidiTransport } from './src/midi/NativeUsbMidiTransport';
import { AuraGridAgent } from './src/agent/AuraGridAgent';
import { AuraGridInterface } from './src/components/AuraGridInterface';
import { aura } from './src/theme/aura';

export default function App() {
  const { width, height } = useWindowDimensions();

  // One engine, one MIDI manager, one agent for the whole app lifetime.
  const engine = useMemo(() => new AudioEngine({ sampleRate: 48000, framesPerBuffer: 128 }), []);
  const midi = useMemo(() => new LaunchpadMidiManager(createMidiTransport()), []);
  const agent = useMemo(() => new AuraGridAgent(engine, midi), [engine, midi]);

  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await engine.start();
        if (cancelled) return;
        await midi.open();
        agent.start();
      } catch (error) {
        if (!cancelled) setBootError(error instanceof Error ? error.message : String(error));
      }
    })();

    return () => {
      cancelled = true;
      agent.stop();
      midi.close();
      engine.stop();
    };
  }, [engine, midi, agent]);

  const layout = width > height ? 'studio' : 'quick-deck';

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <StatusBar style="light" backgroundColor={aura.color.oled} />
        <SafeAreaView style={styles.root} edges={['top', 'bottom', 'left', 'right']}>
          {bootError ? (
            <View style={styles.error}>
              <Text style={styles.errorTitle}>Audio-Core nicht gestartet</Text>
              <Text style={styles.errorBody}>{bootError}</Text>
              <Text style={styles.errorHint}>
                Ohne Native-Build läuft die stille Bridge: UI, MIDI-Logik und Agent bleiben bedienbar.
              </Text>
            </View>
          ) : null}
          <AuraGridInterface engine={engine} midi={midi} agent={agent} layout={layout} />
        </SafeAreaView>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: aura.color.oled },
  error: {
    margin: 12,
    padding: 12,
    borderRadius: aura.radius.md,
    borderWidth: 1,
    borderColor: aura.color.pink,
    backgroundColor: aura.color.surface,
  },
  errorTitle: { color: aura.color.pink, fontWeight: '700', marginBottom: 4 },
  errorBody: { color: aura.color.text, fontSize: 12 },
  errorHint: { color: aura.color.textDim, fontSize: 11, marginTop: 6 },
});
