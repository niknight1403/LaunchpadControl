import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { AgentStatus } from '../agent/AuraGridAgent';
import { AuraGridAgent } from '../agent/AuraGridAgent';
import type { AudioEngine } from '../engine/AudioEngine';
import { FxChain } from '../engine/fx/FxChain';
import {
  DECK_IDS,
  FxParam,
  GRID_SIZE,
  type DeckId,
  type EngineTelemetry,
  type StemId,
} from '../engine/types';
import type { LaunchpadMidiManager } from '../midi/LaunchpadMidiManager';
import { velocityBrightness } from '../midi/LaunchpadProfiles';
import { aura, type AuraPadState } from '../theme/aura';
import { MixerDrawer, type DeckStrip } from './MixerDrawer';
import { PadGrid } from './PadGrid';
import { WaveformView, syntheticPeaks } from './WaveformView';
import { XYPad } from './XYPad';
import { usePadHaptics } from './usePadHaptics';
import type { Studio } from '../app/Studio';

export interface AuraGridInterfaceProps {
  engine: AudioEngine;
  midi: LaunchpadMidiManager;
  agent: AuraGridAgent;
  layout: 'studio' | 'quick-deck';
  /**
   * The sprint wiring. Optional so the screen still renders without it (and in tests),
   * but when present a pad press goes through the beat grid instead of firing blind.
   */
  studio?: Studio | null;
}

function emptyGrid(): AuraPadState[][] {
  return Array.from({ length: GRID_SIZE }, () => Array.from({ length: GRID_SIZE }, () => 'idle' as AuraPadState));
}

const DECK_LABELS = ['DECK A', 'DECK B', 'DECK C', 'DECK D'] as const;

export function AuraGridInterface({ engine, midi, agent, layout, studio }: AuraGridInterfaceProps) {
  const haptics = usePadHaptics();
  const [telemetry, setTelemetry] = useState<EngineTelemetry>(engine.getTelemetry());
  const [status, setStatus] = useState<AgentStatus>(() => agent.getStatus());
  const [grid, setGrid] = useState<AuraPadState[][]>(emptyGrid);
  const [activeDeck, setActiveDeck] = useState<DeckId>(0);
  const [mixerOpen, setMixerOpen] = useState(false);
  const [masterGain, setMasterGain] = useState(0.85);
  const [deckGains, setDeckGains] = useState<Record<DeckId, number>>({ 0: 1, 1: 1, 2: 1, 3: 1 });
  const [stemGains, setStemGains] = useState<Record<DeckId, Record<StemId, number>>>({
    0: { drums: 1, bass: 1, synth: 1, vocals: 1 },
    1: { drums: 1, bass: 1, synth: 1, vocals: 1 },
    2: { drums: 1, bass: 1, synth: 1, vocals: 1 },
    3: { drums: 1, bass: 1, synth: 1, vocals: 1 },
  });
  const [filterModes, setFilterModes] = useState<Record<DeckId, 'lowpass' | 'highpass'>>({
    0: 'lowpass',
    1: 'lowpass',
    2: 'lowpass',
    3: 'lowpass',
  });

  const [motion, setMotion] = useState(false);
  // One FX chain per surface, retargeted when the active deck changes: the XY
  // pad and the LFO automation then address the same object.
  const fxChain = useMemo(() => new FxChain(engine, 0, { bpm: engine.currentBpm }), [engine]);

  const peaks = useMemo(() => syntheticPeaks(96, 11), []);
  const progress = telemetry.transportBeats % 4 / 4;
  const activeDeckRef = useRef(activeDeck);
  activeDeckRef.current = activeDeck;

  // ── subscriptions ────────────────────────────────────────────────────────
  useEffect(() => engine.onTelemetry(setTelemetry), [engine]);
  useEffect(() => agent.onStatus(setStatus), [agent]);

  // Hardware → app. The manager already flipped row/col into screen space.
  useEffect(
    () =>
      midi.onPad((hit) => {
        if (!hit.pressed) return;
        const deck = activeDeckRef.current;
        const index = hit.row * GRID_SIZE + hit.col;
        engine.triggerPad(deck, index, hit.velocity);
        void haptics.fire(hit.velocity);
        setGrid((previous) => patchCell(previous, hit.col, GRID_SIZE - 1 - hit.row, 'playing'));
        setTimeout(() => {
          setGrid((previous) => patchCell(previous, hit.col, GRID_SIZE - 1 - hit.row, 'loaded'));
        }, 220);
      }),
    [midi, engine, haptics],
  );

  // App → hardware: mirror the visible grid onto the LEDs, diffed by the manager.
  useEffect(() => {
    midi.paintFrame(grid.map((row) => row.map((state) => aura.pad[state])));
  }, [grid, midi]);

  useEffect(() => {
    fxChain.setDeck(activeDeck);
    fxChain.setBpm(engine.currentBpm);
  }, [fxChain, activeDeck, engine.currentBpm]);

  useEffect(() => () => fxChain.stop(), [fxChain]);

  // ── pad interaction ──────────────────────────────────────────────────────
  const handlePadPress = useCallback(
    (x: number, y: number) => {
      const deck = activeDeckRef.current;
      const velocity = 0.92;
      // With the grid wired, the press lands on the next division; without it the pad
      // fires immediately, which is what a phone without analysis needs.
      const quantized = studio?.commands.get('triggerQuantized');
      if (quantized) {
        (quantized as (deckId: number, pad: number, division?: number, velocity?: number) => unknown)(deck, y * GRID_SIZE + x, 1, velocity);
      } else {
        engine.triggerPad(deck, y * GRID_SIZE + x, velocity);
      }
      void haptics.fire(velocity);
      setGrid((previous) => patchCell(previous, x, y, 'playing'));
      midi.setPad(x, y, { ...aura.pad.playing, ...scale(velocityBrightness(velocity)) });
      midi.flush();
      setTimeout(() => setGrid((previous) => patchCell(previous, x, y, 'loaded')), 240);
    },
    [engine, haptics, midi, studio],
  );

  const handlePadRelease = useCallback((x: number, y: number) => {
    setGrid((previous) => patchCell(previous, x, y, 'loaded'));
  }, []);

  // ── mixing ───────────────────────────────────────────────────────────────
  const decks: DeckStrip[] = DECK_IDS.map((id) => ({
    id,
    label: DECK_LABELS[id] ?? `DECK ${id + 1}`,
    gain: deckGains[id],
    stems: stemGains[id],
    filterMode: filterModes[id],
    bpm: engine.currentBpm,
    keyLabel: status.key?.camelot,
  }));

  const handleDeckGain = useCallback(
    (deck: DeckId, gain: number) => {
      engine.setDeckGain(deck, gain);
      setDeckGains((previous) => ({ ...previous, [deck]: gain }));
    },
    [engine],
  );

  const handleStemGain = useCallback(
    (deck: DeckId, stem: StemId, gain: number) => {
      engine.setStemGain(deck, stem, gain);
      setStemGains((previous) => ({ ...previous, [deck]: { ...previous[deck], [stem]: gain } }));
    },
    [engine],
  );

  const handleMasterGain = useCallback(
    (gain: number) => {
      engine.setMasterGain(gain);
      setMasterGain(gain);
    },
    [engine],
  );

  const handleFx = useCallback(
    (x: number, y: number) => {
      // The macro moves cutoff across its whole range, resonance across a
      // musical window, and the delay send only in the last third.
      fxChain.setMacro([{ param: FxParam.FilterCutoff, from: 0.15, to: 1 }], x);
      fxChain.setParam(FxParam.FilterResonance, y);
      fxChain.setParam(FxParam.DelayMix, Math.max(0, x - 0.7) * 1.6);
    },
    [fxChain],
  );

  const toggleMotion = useCallback(() => {
    const next = !motion;
    setMotion(next);
    if (next) {
      fxChain.attachLfo(FxParam.FilterCutoff, { depth: 0.3, beats: 8, shape: 'sine' });
      fxChain.start();
    } else {
      fxChain.detachLfo(FxParam.FilterCutoff);
      fxChain.stop();
    }
  }, [fxChain, motion]);

  const handleFilterMode = useCallback(
    (deck: DeckId, mode: 'lowpass' | 'highpass') => {
      engine.setFilterMode(deck, mode);
      setFilterModes((previous) => ({ ...previous, [deck]: mode }));
    },
    [engine],
  );

  const handleTransition = useCallback(() => {
    if (status.transitionRunning) {
      agent.abortTransition();
    } else {
      agent.performTransition();
      void haptics.notify('success');
    }
  }, [agent, haptics, status.transitionRunning]);

  const cpuWarning = telemetry.cpuLoad > 0.8;

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View>
          <Text style={styles.brand}>AURAGRID</Text>
          <Text style={styles.subtitle}>
            {engine.isSilent ? 'SILENT BRIDGE' : 'REALTIME CORE'} · {midi.activeProfile.label}
          </Text>
        </View>
        <View style={styles.chips}>
          <Chip label="LAT" value={`${engine.roundTripMs} ms`} tone="cyan" />
          <Chip label="CPU" value={`${Math.round(telemetry.cpuLoad * 100)}%`} tone={cpuWarning ? 'pink' : 'dim'} />
          <Chip label="VOX" value={String(telemetry.activeVoices)} tone="dim" />
          <Chip label="XR" value={String(telemetry.xruns)} tone={telemetry.xruns > 0 ? 'pink' : 'dim'} />
        </View>
      </View>

      <View style={styles.ticker}>
        <Text style={styles.tickerText} numberOfLines={1}>
          {status.lastAction}
        </Text>
        <Text style={[styles.tickerMeta, status.coPilot ? styles.tickerMetaOn : null]}>
          {status.coPilot ? 'CO-PILOT' : 'MANUAL'}
          {status.meshSynced ? ` · MESH ${status.clockQualityMs.toFixed(1)}ms` : ''}
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <WaveformView peaks={peaks} progress={Number.isFinite(progress) ? progress : 0} />

        <View style={layout === 'studio' ? styles.studioRow : styles.quickRow}>
          <PadGrid
            grid={grid}
            compact={layout === 'quick-deck'}
            onPadPress={handlePadPress}
            onPadRelease={handlePadRelease}
          />

          <View style={styles.sideColumn}>
            <XYPad onChange={handleFx} label="FILTER / DELAY" size={layout === 'studio' ? 168 : 132} />
            <View style={styles.deckRow}>
              {DECK_IDS.map((id) => (
                <Pressable
                  key={id}
                  onPress={() => {
                    setActiveDeck(id);
                    engine.setCrossfader(id / 3);
                    void haptics.fire(0.4, 'control');
                  }}
                  style={[styles.deckChip, id === activeDeck ? styles.deckChipActive : null]}
                >
                  <Text style={[styles.deckChipText, id === activeDeck ? styles.deckChipTextActive : null]}>
                    {String.fromCharCode(65 + id)}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        </View>

        <View style={styles.agentCard}>
          <View style={styles.agentHead}>
            <Text style={styles.agentTitle}>NEXT UP</Text>
            <Text style={styles.agentMeta}>
              {status.key ? `${status.key.camelot} · ${Math.round(status.bpm)} BPM` : 'kein Track geladen'}
            </Text>
          </View>
          {status.suggestion ? (
            <>
              <Text style={styles.agentTrack} numberOfLines={1}>
                {status.suggestion.track.title}
              </Text>
              <Text style={styles.agentReason}>
                {status.suggestion.reason} · Score {status.suggestion.score.toFixed(2)} · Tempo{' '}
                {status.suggestion.tempoShift >= 0 ? '+' : ''}
                {(status.suggestion.tempoShift * 100).toFixed(1)}%
              </Text>
            </>
          ) : (
            <Text style={styles.agentReason}>Bibliothek laden, dann schlägt der Agent harmonisch passende Tracks vor.</Text>
          )}
          <View style={styles.agentActions}>
            <ActionButton
              label={status.transitionRunning ? 'ABBRECHEN' : 'TRANSITION'}
              tone="cyan"
              onPress={handleTransition}
            />
            <ActionButton
              label={status.coPilot ? 'CO-PILOT AN' : 'CO-PILOT AUS'}
              tone={status.coPilot ? 'green' : 'dim'}
              onPress={() => agent.setCoPilot(!status.coPilot)}
            />
            <ActionButton
              label={motion ? 'MOTION AN' : 'MOTION AUS'}
              tone={motion ? 'cyan' : 'dim'}
              onPress={toggleMotion}
            />
            <ActionButton label="MIXER" tone="dim" onPress={() => setMixerOpen((open) => !open)} />
          </View>
        </View>
      </ScrollView>

      {mixerOpen ? (
        <MixerDrawer
          decks={decks}
          activeDeck={activeDeck}
          masterGain={masterGain}
          onSelectDeck={setActiveDeck}
          onDeckGain={handleDeckGain}
          onStemGain={handleStemGain}
          onMasterGain={handleMasterGain}
          onFilterMode={handleFilterMode}
          onClose={() => setMixerOpen(false)}
        />
      ) : null}
    </View>
  );
}

// ── small presentational pieces ─────────────────────────────────────────────

function Chip({ label, value, tone }: { label: string; value: string; tone: 'cyan' | 'pink' | 'dim' }) {
  const color =
    tone === 'cyan' ? aura.color.cyan : tone === 'pink' ? aura.color.pink : aura.color.textDim;
  return (
    <View style={[styles.chip, { borderColor: color }]}>
      <Text style={[styles.chipLabel, { color }]}>{label}</Text>
      <Text style={[styles.chipValue, { color }]}>{value}</Text>
    </View>
  );
}

function ActionButton({
  label,
  tone,
  onPress,
}: {
  label: string;
  tone: 'cyan' | 'green' | 'dim';
  onPress: () => void;
}) {
  const color =
    tone === 'cyan' ? aura.color.cyan : tone === 'green' ? aura.color.green : aura.color.textDim;
  return (
    <Pressable onPress={onPress} style={[styles.action, { borderColor: color }]}>
      <Text style={[styles.actionText, { color }]}>{label}</Text>
    </Pressable>
  );
}

// ── helpers ────────────────────────────────────────────────────────────────

function patchCell(grid: AuraPadState[][], x: number, y: number, state: AuraPadState): AuraPadState[][] {
  const row = grid[y];
  if (!row) return grid;
  if (row[x] === state) return grid;
  const nextRow = [...row];
  nextRow[x] = state;
  const next = [...grid];
  next[y] = nextRow;
  return next;
}

function scale(factor: number) {
  return { r: Math.round(0 * factor), g: Math.round(242 * factor), b: Math.round(254 * factor) };
}


const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: aura.color.oled },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: aura.space.lg,
    paddingTop: aura.space.sm,
  },
  brand: { color: aura.color.text, fontSize: aura.font.sizes.title, fontWeight: '800', letterSpacing: 4 },
  subtitle: { color: aura.color.textFaint, fontSize: 10, fontFamily: aura.font.mono, marginTop: 2 },
  chips: { flexDirection: 'row', gap: 6 },
  chip: {
    borderWidth: 1,
    borderRadius: aura.radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 3,
    alignItems: 'center',
    minWidth: 46,
  },
  chipLabel: { fontSize: 8, fontFamily: aura.font.mono, letterSpacing: 1 },
  chipValue: { fontSize: 11, fontFamily: aura.font.mono, fontWeight: '700' },
  ticker: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: aura.space.lg,
    paddingVertical: 6,
    marginTop: aura.space.sm,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: aura.color.border,
  },
  tickerText: { color: aura.color.text, fontSize: 11, flex: 1 },
  tickerMeta: { color: aura.color.textFaint, fontSize: 9, fontFamily: aura.font.mono, marginLeft: 8 },
  tickerMetaOn: { color: aura.color.green },
  body: { padding: aura.space.lg, gap: aura.space.lg },
  studioRow: { flexDirection: 'row', alignItems: 'center', gap: aura.space.lg, justifyContent: 'space-between' },
  quickRow: { gap: aura.space.lg },
  sideColumn: { gap: aura.space.md, alignItems: 'center' },
  deckRow: { flexDirection: 'row', gap: 8 },
  deckChip: {
    width: 34,
    height: 34,
    borderRadius: aura.radius.sm,
    borderWidth: 1,
    borderColor: aura.color.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deckChipActive: { borderColor: aura.color.cyan, backgroundColor: aura.color.surfaceRaised },
  deckChipText: { color: aura.color.textDim, fontFamily: aura.font.mono, fontSize: 12 },
  deckChipTextActive: { color: aura.color.cyan, fontWeight: '700' },
  agentCard: {
    borderRadius: aura.radius.lg,
    borderWidth: 1,
    borderColor: aura.color.border,
    backgroundColor: aura.color.surface,
    padding: aura.space.md,
    gap: 6,
  },
  agentHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  agentTitle: { color: aura.color.green, fontFamily: aura.font.mono, fontSize: 10, letterSpacing: 2 },
  agentMeta: { color: aura.color.textFaint, fontSize: 10, fontFamily: aura.font.mono },
  agentTrack: { color: aura.color.text, fontSize: 15, fontWeight: '700' },
  agentReason: { color: aura.color.textDim, fontSize: 11 },
  agentActions: { flexDirection: 'row', gap: 8, marginTop: 4 },
  action: {
    flex: 1,
    borderWidth: 1,
    borderRadius: aura.radius.sm,
    paddingVertical: 8,
    alignItems: 'center',
  },
  actionText: { fontSize: 10, fontFamily: aura.font.mono, letterSpacing: 1 },
});
