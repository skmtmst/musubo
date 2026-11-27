import { describe, expect, it } from 'vitest';
import { restaurantChairPositions } from './restaurant-chair-layout.js';

describe('restaurantChairPositions', () => {
  it('places five chairs as three and two on the square table', () => {
    const chairs = restaurantChairPositions({ capacity: 5, shape: 'rectangle' });
    expect(chairs.filter((chair) => chair.side === 'top')).toHaveLength(3);
    expect(chairs.filter((chair) => chair.side === 'bottom')).toHaveLength(2);
  });

  it('places two chairs opposite one another', () => {
    expect(restaurantChairPositions({ capacity: 2, shape: 'rectangle' }).map((chair) => chair.side)).toEqual(['left', 'right']);
  });

  it('rotates a six-seat rectangle to three chairs on each long side', () => {
    const chairs = restaurantChairPositions({ capacity: 6, shape: 'long', orientation: 'vertical' });
    expect(chairs.filter((chair) => chair.side === 'left')).toHaveLength(3);
    expect(chairs.filter((chair) => chair.side === 'right')).toHaveLength(3);
  });

  it('puts a single counter chair on the selected customer side', () => {
    expect(restaurantChairPositions({ capacity: 1, shape: 'counter', side: 'left' })).toEqual([{ side: 'left', offset: 0.5 }]);
  });

  it('spaces four chairs around a round table', () => {
    expect(restaurantChairPositions({ capacity: 4, shape: 'circle' }).map((chair) => chair.side)).toEqual(['top', 'right', 'bottom', 'left']);
  });
});

describe('丸い卓の配置', () => {
  it('全周は円の上で均等、古い方向なしの保存値も全周になる', () => {
    const all = restaurantChairPositions({ capacity: 5, shape: 'circle', arrangement: 'all' })
    expect(all.map(item => item.angle)).toEqual([-90, -18, 54, 126, 198])
    expect(restaurantChairPositions({ capacity: 5, shape: 'circle', arrangement: 'both' })).toEqual(all)
  })
  it('片側と向かい合わせは選んだ方向の円周に置く', () => {
    expect(restaurantChairPositions({ capacity: 3, shape: 'circle', arrangement: 'one', side: 'right' }).map(item => item.angle)).toEqual([-45, 0, 45])
    expect(restaurantChairPositions({ capacity: 4, shape: 'circle', arrangement: 'both', side: 'top' }).map(item => item.angle)).toEqual([-135, -45, 45, 135])
  })
})

it.each([['one', 6], ['both', 12], ['all', 100]] as const)('丸卓の%s・%i席は弧の間隔に合わせて椅子の幅を調整する', (arrangement, capacity) => {
  const chairs = restaurantChairPositions({ capacity, shape: 'circle', arrangement, side: 'right' })
  expect(chairs).toHaveLength(capacity)
  const angles = chairs.map(chair => ((chair.angle! % 360) + 360) % 360).sort((a, b) => a - b)
  const minGap = Math.min(...angles.map((angle, i) => (angles[(i + 1) % angles.length] - angle + 360) % 360))
  const chord = 2 * 38 * Math.sin(minGap * Math.PI / 360)
  expect(chord + 1e-8).toBeGreaterThanOrEqual(20 * chairs[0].scale!)
})

it.each([['one', 6], ['both', 12]] as const)('丸卓の%s %i席はほぼ通常の幅で置く', (arrangement, capacity) => {
  const chairs = restaurantChairPositions({ capacity, shape: 'circle', arrangement, side: 'top' })
  expect(chairs.every(chair => chair.scale! > 0.98)).toBe(true)
})
