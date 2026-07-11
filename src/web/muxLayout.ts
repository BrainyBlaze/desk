import type { DeskSessionView } from '../ui/model.js';

export type LayoutKind = '1x1' | '2x2' | '3x3' | '4x4' | 'custom' | 'linear';

export interface PanelCell {
  id: string;
  label: string;
  index: number;
  sessions: DeskSessionView[];
  activeSession?: DeskSessionView;
}
