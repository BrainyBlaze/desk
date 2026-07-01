import { describe, expect, it } from 'vitest';
import { createDeskBleepsSettings, readStoredMuted, MUTED_STORAGE_KEY } from '../src/web/arwes/bleeps.js';

describe('desk bleeps settings', () => {
  it('defines the five desk bleeps with webm+mp3 sources', () => {
    const settings = createDeskBleepsSettings(false);
    const names = Object.keys(settings.bleeps).sort();
    expect(names).toEqual(['alarm', 'attention', 'click', 'close', 'deploy', 'error', 'hover', 'open', 'slide']);
    for (const bleep of Object.values(settings.bleeps)) {
      expect(bleep.sources).toHaveLength(2);
      expect(bleep.sources[0]!.src).toMatch(/^\/assets\/sounds\/(click|type|info|error|hover|info-close|slide|alarm)\.webm$/);
      expect(bleep.sources[1]!.type).toBe('audio/mpeg');
    }
  });

  it('respects muted flag and master volume', () => {
    expect(createDeskBleepsSettings(true).common?.muted).toBe(true);
    expect(createDeskBleepsSettings(false).common?.muted).toBe(false);
    expect(createDeskBleepsSettings(false).master?.volume).toBe(0.45);
  });

  it('maps categories per the spec sound map', () => {
    const { bleeps } = createDeskBleepsSettings(false);
    expect(bleeps.hover.category).toBe('background');
    expect(bleeps.click.category).toBe('interaction');
    expect(bleeps.open.category).toBe('transition');
    expect(bleeps.close.category).toBe('transition');
    expect(bleeps.deploy.category).toBe('interaction');
    expect(bleeps.error.category).toBe('notification');
    expect(bleeps.attention.category).toBe('notification');
    expect(bleeps.slide.category).toBe('transition');
    expect(bleeps.alarm.category).toBe('notification');
  });

  it('parses stored mute preference', () => {
    expect(MUTED_STORAGE_KEY).toBe('desk.muted');
    expect(readStoredMuted('1')).toBe(true);
    expect(readStoredMuted('0')).toBe(false);
    expect(readStoredMuted(null)).toBe(false);
  });
});
