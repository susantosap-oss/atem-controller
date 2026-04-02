/** Audio mixer constants matching ATEM protocol values */

export const MixOption = {
  Off:  0,
  On:   1,
  AFV:  4,
} as const;

export type MixOptionValue = (typeof MixOption)[keyof typeof MixOption];

/** dB range for channel faders */
export const FADER_MIN_DB = -60;
export const FADER_MAX_DB =   6;
export const FADER_UNITY_DB = 0;

/** VU meter display range */
export const VU_FLOOR_DB = -60;
export const VU_CLIP_DB  =   0;  // 0 dB = clip warning

/** dB → linear position on fader (0=bottom, 1=top) */
export function dbToFaderPos(db: number): number {
  if (db <= FADER_MIN_DB) return 0;
  if (db >= FADER_MAX_DB) return 1;
  const range = FADER_MAX_DB - FADER_MIN_DB;
  return (db - FADER_MIN_DB) / range;
}

export function faderPosToDb(pos: number): number {
  const range = FADER_MAX_DB - FADER_MIN_DB;
  const db = pos * range + FADER_MIN_DB;
  return Math.round(db * 10) / 10;
}

/** dB → 0..1 scale for VU meter bar height */
export function dbToVuHeight(db: number): number {
  if (db <= VU_FLOOR_DB) return 0;
  if (db >= VU_CLIP_DB)  return 1;
  return (db - VU_FLOOR_DB) / (VU_CLIP_DB - VU_FLOOR_DB);
}

/** Format dB value for display */
export function formatDb(db: number): string {
  if (db <= FADER_MIN_DB) return '-∞';
  return (db >= 0 ? '+' : '') + db.toFixed(1);
}

export const DB_SCALE_MARKS = [-60, -40, -30, -20, -18, -12, -9, -6, -3, 0, 3, 6];

/** Level data shape (mirrors LevelData in useATEM) */
export interface LevelData {
  left: number;
  right: number;
  peakLeft: number;
  peakRight: number;
}
