import { runningPeak, weeklyMrrChange, type Timeline } from '../data/types.ts';
import type { Moment } from './events.ts';
import type { Weather } from './layout.ts';

/** Rain starts when MRR is down more than this over a week… */
export const RAIN_STARTS = -0.01;
/** …and clears once the trailing week is back to flat or better. */
export const RAIN_CLEARS = 0;

export function momentsOf(timeline: Timeline): Moment[] {
  const peaks = runningPeak(timeline.snapshots);
  let weather: Weather = 'clear';
  return timeline.snapshots.map((snapshot, i) => {
    const weeklyChange = weeklyMrrChange(timeline.snapshots, i);
    if (weather === 'clear' && weeklyChange < RAIN_STARTS) weather = 'rain';
    else if (weather === 'rain' && weeklyChange >= RAIN_CLEARS) weather = 'clear';
    return { snapshot, peakMrr: peaks[i]!, weeklyChange, weather };
  });
}
