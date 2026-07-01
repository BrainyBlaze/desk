import type { BleepsProviderSettings } from '@arwes/react';

/** Desk bleep vocabulary. `hover`/`click`/`deploy` match the names already used in App.tsx. */
export type DeskBleepName = 'hover' | 'click' | 'open' | 'close' | 'deploy' | 'error' | 'attention' | 'slide' | 'alarm';

type SoundFile = 'click' | 'type' | 'info' | 'error' | 'hover' | 'info-close' | 'slide' | 'alarm';

const sources = (name: SoundFile): Array<{ src: string; type: string }> => [
  { src: `/assets/sounds/${name}.webm`, type: 'audio/webm' },
  { src: `/assets/sounds/${name}.mp3`, type: 'audio/mpeg' }
];

export const MUTED_STORAGE_KEY = 'desk.muted';

export function readStoredMuted(value: string | null): boolean {
  return value === '1';
}

export function createDeskBleepsSettings(muted: boolean): BleepsProviderSettings<DeskBleepName> {
  return {
    master: { volume: 0.45 },
    common: { muted, preload: false },
    categories: {
      background: { volume: 0.2 },
      transition: { volume: 0.5 },
      interaction: { volume: 0.55 },
      notification: { volume: 0.75 }
    },
    bleeps: {
      hover: { category: 'background', sources: sources('hover') },
      click: { category: 'interaction', sources: sources('click') },
      open: { category: 'transition', sources: sources('info') },
      close: { category: 'transition', volume: 0.45, sources: sources('info-close') },
      deploy: { category: 'interaction', volume: 0.6, sources: sources('info') },
      error: { category: 'notification', sources: sources('error') },
      attention: { category: 'notification', volume: 0.85, sources: sources('info') },
      slide: { category: 'transition', volume: 0.5, sources: sources('slide') },
      alarm: { category: 'notification', volume: 0.9, sources: sources('alarm') }
    }
  };
}
