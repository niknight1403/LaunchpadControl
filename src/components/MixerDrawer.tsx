import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { DeckId, StemId } from '../engine/types';
import { STEM_IDS } from '../engine/types';
import { aura } from '../theme/aura';
import { VerticalFader } from './VerticalFader';

export interface DeckStrip {
  id: DeckId;
  label: string;
  gain: number;
  stems: Record<StemId, number>;
  filterMode: 'lowpass' | 'highpass';
  keyLabel?: string;
  bpm?: number;
}

export interface MixerDrawerProps {
  decks: readonly DeckStrip[];
  activeDeck: DeckId;
  masterGain: number;
  onSelectDeck: (deck: DeckId) => void;
  onDeckGain: (deck: DeckId, gain: number) => void;
  onStemGain: (deck: DeckId, stem: StemId, gain: number) => void;
  onMasterGain: (gain: number) => void;
  onFilterMode: (deck: DeckId, mode: 'lowpass' | 'highpass') => void;
  onClose: () => void;
}

const STEM_LABEL: Record<StemId, string> = {
  drums: 'DRM',
  bass: 'BAS',
  synth: 'SYN',
  vocals: 'VOX',
};

/**
 * Mixer drawer: four deck strips plus master.
 *
 * Horizontal scroll rather than shrinking everything to fit: a fader shorter
 * than a thumb is not a fader. The active deck is pinned by accent colour, so a
 * glance from a metre away is enough.
 */
export function MixerDrawer({
  decks,
  activeDeck,
  masterGain,
  onSelectDeck,
  onDeckGain,
  onStemGain,
  onMasterGain,
  onFilterMode,
  onClose,
}: MixerDrawerProps) {
  return (
    <View style={styles.drawer}>
      <View style={styles.header}>
        <Text style={styles.title}>MIXER</Text>
        <Pressable onPress={onClose} style={styles.close} hitSlop={12}>
          <Text style={styles.closeText}>schließen</Text>
        </Pressable>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strips}>
        {decks.map((deck) => {
          const isActive = deck.id === activeDeck;
          return (
            <Pressable
              key={deck.id}
              onPress={() => onSelectDeck(deck.id)}
              style={[styles.strip, isActive ? styles.stripActive : null]}
            >
              <Text style={[styles.deckLabel, isActive ? styles.deckLabelActive : null]}>{deck.label}</Text>
              <Text style={styles.deckMeta}>
                {deck.bpm ? `${Math.round(deck.bpm)} BPM` : '—'} {deck.keyLabel ?? ''}
              </Text>

              <VerticalFader
                label="GAIN"
                value={deck.gain}
                onChange={(value) => onDeckGain(deck.id, value)}
                color={isActive ? aura.color.cyan : aura.color.textDim}
                height={96}
              />

              <View style={styles.stems}>
                {STEM_IDS.map((stem) => (
                  <VerticalFader
                    key={stem}
                    label={STEM_LABEL[stem]}
                    value={deck.stems[stem]}
                    onChange={(value) => onStemGain(deck.id, stem, value)}
                    color={stem === 'vocals' ? aura.color.pink : aura.color.green}
                    height={64}
                  />
                ))}
              </View>

              <Pressable
                onPress={() => onFilterMode(deck.id, deck.filterMode === 'lowpass' ? 'highpass' : 'lowpass')}
                style={styles.filterToggle}
              >
                <Text style={styles.filterText}>{deck.filterMode === 'lowpass' ? 'LP' : 'HP'}</Text>
              </Pressable>
            </Pressable>
          );
        })}

        <View style={[styles.strip, styles.master]}>
          <Text style={styles.deckLabel}>MASTER</Text>
          <Text style={styles.deckMeta}>Limiter aktiv</Text>
          <VerticalFader
            label="OUT"
            value={masterGain}
            onChange={onMasterGain}
            color={aura.color.amber}
            height={176}
          />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  drawer: {
    backgroundColor: aura.color.glass,
    borderTopWidth: 1,
    borderColor: aura.color.border,
    paddingTop: aura.space.md,
    paddingBottom: aura.space.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: aura.space.lg,
    marginBottom: aura.space.sm,
  },
  title: { color: aura.color.cyan, fontFamily: aura.font.mono, letterSpacing: 3, fontSize: 12 },
  close: { paddingVertical: 2 },
  closeText: { color: aura.color.textDim, fontSize: 12 },
  strips: { paddingHorizontal: aura.space.lg, gap: aura.space.md },
  strip: {
    width: 132,
    padding: aura.space.md,
    borderRadius: aura.radius.lg,
    borderWidth: 1,
    borderColor: aura.color.border,
    backgroundColor: aura.color.surface,
    alignItems: 'center',
    gap: aura.space.sm,
  },
  stripActive: { borderColor: aura.color.cyan, backgroundColor: aura.color.surfaceRaised },
  master: { borderColor: aura.color.amber },
  deckLabel: { color: aura.color.text, fontFamily: aura.font.mono, fontSize: 12, letterSpacing: 2 },
  deckLabelActive: { color: aura.color.cyan },
  deckMeta: { color: aura.color.textFaint, fontSize: 10 },
  stems: { flexDirection: 'row', gap: 4 },
  filterToggle: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: aura.radius.sm,
    borderWidth: 1,
    borderColor: aura.color.borderStrong,
  },
  filterText: { color: aura.color.cyan, fontFamily: aura.font.mono, fontSize: 11 },
});
