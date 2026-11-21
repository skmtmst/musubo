import type { AccountStyle, SetupAnswer } from './style-api.js';

type MenuTarget = 'booking' | 'history' | 'menu' | 'access' | 'coupon' | 'stamp' | 'phone';
type MenuArea = { target: MenuTarget; x: number; y: number; width: number; height: number };

const halfHeight = 843;
const firstThird = 833;
const lastColumn = 1666;
const lastThird = 834;

const area = (target: MenuTarget, x: number, y: number, width: number, height = halfHeight): MenuArea => (
  { target, x, y, width, height }
);
const sixTiles = (lastRow: readonly MenuTarget[]) => (
  (['booking', 'history', 'menu', ...lastRow] as const).map((target, index) => (
    area(target, index % 3 * firstThird, index < 3 ? 0 : halfHeight, index % 3 === 2 ? lastThird : firstThird)
  ))
);

export const RESTAURANT_GUIDE_MENUS = {
  natural: {
    label: 'ナチュラル', detail: '緑・明朝・2×3', colors: ['#f8f5ea', '#1e4834', '#ebeee8', '#25362a'],
    areas: sixTiles(['coupon', 'stamp', 'access']),
  },
  modern: {
    label: 'モダン', detail: '白と黒・右縦1列+4', colors: ['#f9fafb', '#37373c', '#dcdce0', '#1D1D1F'],
    areas: [area('booking', lastColumn, 0, lastThird, 1686), area('history', 0, 0, firstThird),
      area('menu', firstThird, 0, firstThird), area('coupon', 0, halfHeight, firstThird), area('access', firstThird, halfHeight, firstThird)],
  },
  gentle: {
    label: 'やさしい', detail: '暖色・丸書体・バナー+3', colors: ['#faf5ed', '#a24d2b', '#f3eade', '#4a352b'],
    areas: [area('booking', 0, 0, 2500), area('menu', 0, halfHeight, firstThird),
      area('coupon', firstThird, halfHeight, firstThird), area('access', lastColumn, halfHeight, lastThird)],
  },
  night: {
    label: '夜（深い紺）', detail: '紺に金・2×3', colors: ['#121b2f', '#c2a45b', '#26375b', '#e5dcba'],
    areas: sixTiles(['coupon', 'phone', 'access']),
  },
  line: {
    label: 'LINEらしい', detail: 'LINE緑・4ボタン', colors: ['#ffffff', '#06c755', '#e7f3eb', '#1B1B1D'],
    areas: [area('booking', 0, 0, 1250), area('history', 1250, 0, 1250),
      area('coupon', 0, halfHeight, 1250), area('access', 1250, halfHeight, 1250)],
  },
} as const;

export type RestaurantGuideMenu = keyof typeof RESTAURANT_GUIDE_MENUS;
export const RESTAURANT_GUIDE_MENU_IDS = Object.keys(RESTAURANT_GUIDE_MENUS) as RestaurantGuideMenu[];

export function restaurantGuideMenu(style: AccountStyle, answer: SetupAnswer | undefined): RestaurantGuideMenu | undefined {
  if (style !== 'restaurant' || answer?.mode !== 'configured') return undefined;
  return RESTAURANT_GUIDE_MENU_IDS.find(id => id === answer.value);
}
