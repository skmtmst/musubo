export type TableOrientation = 'horizontal' | 'vertical';
export type ChairArrangement = 'both' | 'one' | 'all';
export type ChairSide = 'top' | 'right' | 'bottom' | 'left';
export type ChairPosition = { side: ChairSide; offset: number; angle?: number; scale?: number };

const opposite: Record<ChairSide, ChairSide> = {
  top: 'bottom', right: 'left', bottom: 'top', left: 'right',
};

function along(side: ChairSide, count: number): ChairPosition[] {
  return Array.from({ length: count }, (_, index) => ({
    side,
    offset: (index + 1) / (count + 1),
  }));
}

/** Penの最大人数と卓形状に合わせ、人数を変えるたびに椅子を再配置する。 */
export function restaurantChairPositions({
  capacity, shape, orientation = 'horizontal', arrangement = 'both', side,
}: {
  capacity: number;
  shape: 'rectangle' | 'circle' | 'long' | 'counter' | 'sofa';
  orientation?: TableOrientation;
  arrangement?: ChairArrangement;
  side?: ChairSide;
}): ChairPosition[] {
  if (!Number.isInteger(capacity) || capacity < 1) return [];
  const count = Math.min(capacity, 100);
  if (shape === 'circle') {
    const centres: Record<ChairSide, number> = { top: -90, right: 0, bottom: 90, left: 180 };
    // 旧データの both・方向なしは従来の全周配置。明示された both は向かい合わせ。
    const spread = (center: number, n: number) => {
      const span = Math.min(150, Math.max(90, (n - 1) * 30));
      return Array.from({ length: n }, (_, i) => center + (n === 1 ? 0 : -span / 2 + span * i / (n - 1)));
    };
    const angles = arrangement === 'all' || (arrangement === 'both' && !side)
      ? Array.from({ length: count }, (_, i) => -90 + i * 360 / count)
      : arrangement === 'one' ? spread(centres[side ?? 'top'], count)
        : [...spread(centres[side ?? 'top'], Math.ceil(count / 2)), ...spread(centres[side ?? 'top'] + 180, Math.floor(count / 2))];
    const sorted = angles.map(a => ((a % 360) + 360) % 360).sort((a, b) => a - b);
    const separation = sorted.length < 2 ? 360 : Math.min(...sorted.map((a, i) => (sorted[(i + 1) % sorted.length] - a + 360) % 360));
    const scale = Math.min(1, 76 * Math.sin(separation * Math.PI / 360) / 20);
    return angles.map(angle => {
      const normalized = ((angle + 45) % 360 + 360) % 360;
      const face: ChairSide = normalized < 90 ? 'right' : normalized < 180 ? 'bottom' : normalized < 270 ? 'left' : 'top';
      return { side: face, offset: 0.5, angle, scale };
    });
  }
  if (shape === 'counter') return along(side ?? (orientation === 'vertical' ? 'left' : 'bottom'), count);
  if (arrangement === 'one') return along(side ?? (orientation === 'vertical' ? 'left' : 'top'), count);
  if (arrangement === 'all') {
    const sides: ChairSide[] = ['top', 'right', 'bottom', 'left'];
    const totals = sides.map((_, index) => Math.floor(count / 4) + (index < count % 4 ? 1 : 0));
    return sides.flatMap((face, index) => along(face, totals[index]));
  }
  const first: ChairSide = side ?? (orientation === 'vertical' || (shape === 'rectangle' && count <= 2) ? 'left' : 'top');
  return [...along(first, Math.ceil(count / 2)), ...along(opposite[first], Math.floor(count / 2))];
}
