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
    const chairs = restaurantChairPositions({ capacity: 4, shape: 'circle' });
    expect(chairs.map((chair) => chair.side)).toEqual(['top', 'right', 'bottom', 'left']);
    expect(chairs.map((chair) => chair.angle)).toEqual([0, 90, 180, 270]);
  });

  it('spaces chairs at equal angles around a round table by default (all)', () => {
    expect(restaurantChairPositions({ capacity: 2, shape: 'circle' }).map((chair) => chair.angle)).toEqual([0, 180]);
    expect(restaurantChairPositions({ capacity: 3, shape: 'circle' }).map((chair) => chair.angle)).toEqual([0, 120, 240]);
    expect(restaurantChairPositions({ capacity: 5, shape: 'circle' }).map((chair) => chair.angle)).toEqual([0, 72, 144, 216, 288]);
  });

  it('places round-table chairs along one side arc when arrangement is one', () => {
    const topChairs = restaurantChairPositions({ capacity: 3, shape: 'circle', arrangement: 'one', side: 'top' });
    expect(topChairs).toHaveLength(3);
    expect(topChairs.map((chair) => chair.angle)).toEqual([326, 0, 34]);
    expect(topChairs.every((chair) => chair.side === 'top')).toBe(true);

    const rightChairs = restaurantChairPositions({ capacity: 2, shape: 'circle', arrangement: 'one', side: 'right' });
    expect(rightChairs.map((chair) => chair.angle)).toEqual([73, 107]);
    expect(rightChairs.every((chair) => chair.side === 'right')).toBe(true);
  });

  it('places round-table chairs facing across opposite arcs when arrangement is both', () => {
    const twoChairs = restaurantChairPositions({ capacity: 2, shape: 'circle', arrangement: 'both' });
    expect(twoChairs.map((chair) => chair.angle)).toEqual([270, 90]);
    expect(twoChairs.map((chair) => chair.side)).toEqual(['left', 'right']);

    const fourChairs = restaurantChairPositions({ capacity: 4, shape: 'circle', arrangement: 'both' });
    expect(fourChairs).toHaveLength(4);
    expect(fourChairs.filter((chair) => chair.side === 'left').map((chair) => chair.angle)).toEqual([253, 287]);
    expect(fourChairs.filter((chair) => chair.side === 'right').map((chair) => chair.angle)).toEqual([73, 107]);
  });
});
