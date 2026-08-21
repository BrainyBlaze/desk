// A failed pulse measures nothing; the sparklines must break at that tick
// rather than freeze on the last line, so every ring takes a gap.
import { describe, expect, it } from 'vitest';
import { markTelemetryGap, type TelemetryHistory } from '../../src/web/usePulse.js';

describe('markTelemetryGap', () => {
  it('appends an unmeasured gap to every telemetry ring', () => {
    const history: TelemetryHistory = { cpu: [10], ram: [20], gpu: [30], net: [40], disk: [50] };

    markTelemetryGap(history);

    for (const ring of [history.cpu, history.ram, history.gpu, history.net, history.disk]) {
      expect(ring.at(-1)).toBeUndefined();
      expect(ring).toHaveLength(2);
    }
  });
});
