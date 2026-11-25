export type TableOrientation = 'horizontal' | 'vertical';
export type ChairArrangement = 'both' | 'one' | 'all';
export type ChairSide = 'top' | 'right' | 'bottom' | 'left';
export type ChairPosition = { side: ChairSide; offset: number; angle?: number };

const opposite: Record<ChairSide, ChairSide> = {
  top: 'bottom', right: 'left', bottom: 'top', left: 'right',
};

const sideAngle: Record<ChairSide, number> = {
  top: 0, right: 90, bottom: 180, left: 270,
};

function normalizeAngle(deg: number): number {
  const normalized = ((deg % 360) + 360) % 360;
  return normalized === 360 ? 0 : normalized;
}

function sideFromAngle(deg: number): ChairSide {
  const normalized = normalizeAngle(deg);
  if (normalized >= 315 || normalized < 45) return 'top';
  if (normalized < 135) return 'right';
  if (normalized < 225) return 'bottom';
  return 'left';
}

function along(side: ChairSide, count: number): ChairPosition[] {
  return Array.from({ length: count }, (_, index) => ({
    side,
    offset: (index + 1) / (count + 1),
  }));
}

function alongArc(centerDeg: number, count: number, maxSpan: number): ChairPosition[] {
  if (count <= 0) return [];
  const step = count === 1 ? 0 : Math.min(34, maxSpan / (count - 1));
  const start = centerDeg - (step * (count - 1)) / 2;
  return Array.from({ length: count }, (_, index) => {
    const angle = normalizeAngle(start + step * index);
    return {
      side: sideFromAngle(angle),
      offset: (index + 1) / (count + 1),
      angle,
    };
  });
}

function roundChairPositions(count: number, arrangement: ChairArrangement, side?: ChairSide): ChairPosition[] {
  if (arrangement === 'one') {
    return alongArc(sideAngle[side ?? 'top'], count, 140);
  }
  if (arrangement === 'both') {
    const firstSide = side ?? 'left';
    const firstCount = Math.ceil(count / 2);
    const secondCount = Math.floor(count / 2);
    return [
      ...alongArc(sideAngle[firstSide], firstCount, 100),
      ...alongArc(sideAngle[opposite[firstSide]], secondCount, 100),
    ];
  }
  return Array.from({ length: count }, (_, index) => {
    const angle = normalizeAngle((360 / count) * index);
    return {
      side: sideFromAngle(angle),
      offset: 0.5,
      angle,
    };
  });
}

/** Penの最大人数と卓形状に合わせ、人数を変えるたびに椅子を再配置する。 */
export function restaurantChairPositions({
  capacity, shape, orientation = 'horizontal', arrangement, side,
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
    return roundChairPositions(count, arrangement ?? 'all', side);
  }
  const effectiveArrangement = arrangement ?? 'both';
  if (shape === 'counter') return along(side ?? (orientation === 'vertical' ? 'left' : 'bottom'), count);
  if (effectiveArrangement === 'one') return along(side ?? (orientation === 'vertical' ? 'left' : 'top'), count);
  if (effectiveArrangement === 'all') {
    const sides: ChairSide[] = ['top', 'right', 'bottom', 'left'];
    const totals = sides.map((_, index) => Math.floor(count / 4) + (index < count % 4 ? 1 : 0));
    return sides.flatMap((face, index) => along(face, totals[index]));
  }
  const first: ChairSide = side ?? (orientation === 'vertical' || (shape === 'rectangle' && count <= 2) ? 'left' : 'top');
  return [...along(first, Math.ceil(count / 2)), ...along(opposite[first], Math.floor(count / 2))];
}
