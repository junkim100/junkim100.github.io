import assert from 'node:assert/strict';
import { restoreTrackCenter, trackGeometry } from '../../core.mjs';
const failures = [];
let cases = 0;
let clampedCases = 0;
const start = '2024-01-01';
const end = '2026-09-08';
const startMs = Date.parse(start);
const span = Date.parse(end) - startMs;
for (const width of [360, 390, 768, 1280, 1920]) {
  for (const gutter of [128, 208]) {
    for (const zoom of [1, 1.5, 2, 2.5, 3, 4]) {
      for (const fraction of [0, .1, .25, .5, .75, .9, 1]) {
        for (const initialFraction of [0, .5, 1]) {
          cases++;
          const canvas = 2400 * zoom;
          const frame = { clientWidth: width, clientLeft: 1, scrollWidth: canvas, scrollLeft: (canvas - width) * initialFraction, getBoundingClientRect: () => ({ left: 10, width }) };
          const track = { getBoundingClientRect: () => ({ left: 11 + gutter - frame.scrollLeft, width: canvas - gutter - 20 }) };
          const label = { getBoundingClientRect: () => ({ right: 11 + gutter }) };
          const target = new Date(startMs + fraction * span).toISOString();
          const result = restoreTrackCenter(frame, track, label, target, start, end);
          const geometry = trackGeometry(frame, track, label);
          const error = Math.abs(Date.parse(result.displayedCenter) - Date.parse(target));
          assert.ok(frame.scrollLeft >= 0 && frame.scrollLeft <= frame.scrollWidth - frame.clientWidth);
          assert.equal(target, new Date(startMs + fraction * span).toISOString(), 'Authoritative input cannot be changed by clamp');
          if (result.clamped) clampedCases++;
          else if (error > span / geometry.trackWidth + 1) failures.push({ width, gutter, zoom, fraction, initialFraction, error });
        }
      }
    }
  }
}
console.log(JSON.stringify({ result: failures.length ? 'FAIL' : 'PASS', cases, clampedCases, failures, scope: 'Synthetic coordinate inversion only; not real browser geometry approval' }));
assert.deepEqual(failures, []);
