// Saved view filters.
//
// A saved view is `{ name, filter }` and the filter is a text query, an author,
// a mentions-me flag and a has-thread flag. It references no message, no
// channel and no author identity — it is what THIS operator likes to look at.
//
// That is why it is not on `ChannelStore`. Reactions and stars are anchored to
// a message and must move wherever conversations move; a saved filter is
// preference, and requiring it of anyone writing a conversation backend would
// hand them somebody else's responsibility. An embedder redirects views for a
// different reason entirely — per-user settings — and can do so without
// touching where conversations live.

import { addView, listViews, removeView, type SavedView, type SavedViewInput } from './views.js';

export interface ChannelViews {
  list(): SavedView[];
  add(input: SavedViewInput): SavedView;
  /** `false` when no view by that name existed. */
  remove(name: string): boolean;
}

/** Saved views as one global `views.json` under the channels home. */
export class FileChannelViews implements ChannelViews {
  constructor(private readonly home: string) {}

  list(): SavedView[] {
    return listViews(this.home);
  }

  add(input: SavedViewInput): SavedView {
    return addView(this.home, input);
  }

  remove(name: string): boolean {
    return removeView(this.home, name);
  }
}
