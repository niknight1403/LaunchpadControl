import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as FileSystem from 'expo-file-system';

import { AudioEngine } from './src/engine/AudioEngine';
import { LaunchpadMidiManager } from './src/midi/LaunchpadMidiManager';
import { createMidiTransport } from './src/midi/NativeUsbMidiTransport';
import { AuraGridAgent } from './src/agent/AuraGridAgent';
import { AuraGridInterface } from './src/components/AuraGridInterface';
import { aura } from './src/theme/aura';
import { HydratedStudioStorage, type PersistAdapter } from './src/app/HydratedStudioStorage';
import { bootStudio } from './src/app/studioBoot';
import type { Studio, StudioMidi } from './src/app/Studio';
import { Translator } from './src/i18n/strings';

const STUDIO_DOC = 'auragrid-studio.json';

/** The studio document lives next to the app's own files, written through a debounce. */
function documentAdapter(): PersistAdapter {
  const directory = (FileSystem as unknown as { documentDirectory?: string }).documentDirectory ?? '';
  const path = `${directory}${STUDIO_DOC}`;
  return {
    async read() {
      try {
        return await (FileSystem as unknown as { readAsStringAsync: (p: string) => Promise<string> }).readAsStringAsync(path);
      } catch {
        return null;
      }
    },
    async write(text: string) {
      await (FileSystem as unknown as { writeAsStringAsync: (p: string, t: string) => Promise<void> }).writeAsStringAsync(path, text);
    },
  };
}

/** The manager speaks pads and controls; the studio speaks one normalised message. */
function midiAdapter(midi: LaunchpadMidiManager): StudioMidi {
  return {
    subscribe(listener) {
      const offPad = midi.onPad((hit) =>
        listener({ type: 'note', channel: 0, number: hit.note, value: hit.velocity || (hit.pressed ? 1 : 0) }),
      );
      const offControl = midi.onControl((hit) => listener({ type: 'cc', channel: 0, number: hit.cc, value: hit.pressed ? 1 : 0 }));
      return () => {
        offPad();
        offControl();
      };
    },
    setPad: (row, col, color, mode) => midi.setPad(col, row, { r: color.r, g: color.g, b: color.b, mode }),
    flush: () => midi.flush(),
  };
}

export default function App() {
  const { width, height } = useWindowDimensions();

  // One engine, one MIDI manager, one agent for the whole app lifetime.
  const engine = useMemo(() => new AudioEngine({ sampleRate: 48000, framesPerBuffer: 128 }), []);
  const midi = useMemo(() => new LaunchpadMidiManager(createMidiTransport()), []);
  const agent = useMemo(() => new AuraGridAgent(engine, midi), [engine, midi]);
  const translator = useMemo(() => new Translator(), []);

  const [bootError, setBootError] = useState<string | null>(null);
  const [studio, setStudio] = useState<Studio | null>(null);
  const [studioLine, setStudioLine] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    let booted: Studio | null = null;
    let storage: HydratedStudioStorage | null = null;

    (async () => {
      try {
        await engine.start();
        if (cancelled) return;
        await midi.open();
        agent.start();

        // The ten sprints come up after the engine, because every one of them calls it.
        storage = await HydratedStudioStorage.open(documentAdapter());
        const session = await bootStudio({
          engine,
          midi: midiAdapter(midi),
          storage,
          translator,
          deckCount: 4,
          backup: { app: 'auragrid' },
        });
        if (cancelled) {
          await session.studio.shutdown();
          return;
        }
        booted = session.studio;
        setStudio(session.studio);
        const describe = () => {
          const state = session.studio.ctx.state;
          const a11y = state.a11y ? ` · ${state.a11y.failures} Kontrastfehler` : '';
          return `${session.sprints.length} Sprints aktiv · ${state.language.toUpperCase()}${a11y}`;
        };
        setStudioLine(describe());
        session.studio.subscribe(() => setStudioLine(describe()));
      } catch (error) {
        if (!cancelled) setBootError(error instanceof Error ? error.message : String(error));
      }
    })();

    return () => {
      cancelled = true;
      void (async () => {
        if (booted) await booted.shutdown();
        if (storage) await storage.flush();
      })();
      agent.stop();
      midi.close();
      engine.stop();
    };
  }, [engine, midi, agent, translator]);

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
          {studioLine && !bootError ? (
            <Text style={styles.status} numberOfLines={1}>
              {studioLine}
            </Text>
          ) : null}
          <AuraGridInterface engine={engine} midi={midi} agent={agent} layout={layout} studio={studio} />
        </SafeAreaView>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: aura.color.oled },
  status: {
    color: aura.color.textDim,
    fontSize: 11,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
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
