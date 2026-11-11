import { STYLE_METRIC_IDS, STYLE_DEFAULT_METRIC_IDS } from '@line-crm/shared';
import {
  ACCOUNT_STYLES,
  DASHBOARD_CARD_GROUPS,
  type AccountStyle,
  type SetupAnswer,
  type StyleCard,
} from '@line-crm/shared';



export class StyleError extends Error {
  constructor(
    public code: string,
    public status: 400 | 403 | 404 | 409 | 422 = 400,
  ) {
    super(code);
  }
}
export const checkStyle = (style: unknown): AccountStyle => {
  if (!ACCOUNT_STYLES.includes(style as AccountStyle))
    throw new StyleError('invalid_style');
  return style as AccountStyle;
};
export const questionKeys = [
  'style',
  'image',
  'cancelDeadline',
  'seats',
  'hours',
  'partySize',
  'nomination',
  'assignment',
  'classCapacity',
  'booking',
  'approval',
  'payment',
  'reminders',
  'stamps',
  'coupons',
  'tickets',
  'outcome',
  'content',
] as const;
export const features: Record<string, string | null> = {
  style: '/getting-started',
  booking: '/booking/menus',
  approval: '/booking/menus?tab=rules',
  payment: '/booking/menus?tab=payments',
  reminders: '/reminders',
  stamps: '/visit-stamps',
  coupons: null,
  tickets: '/booking/menus?tab=passes',
  image: '/rich-menus',
  outcome: '/booking/menus',
  content: '/templates',
  cancelDeadline: '/booking/menus?tab=rules',
  seats: '/restaurant-test/tables',
  hours: '/settings/google-hours',
  partySize: '/booking/menus?tab=rules',
  nomination: '/booking/menus?tab=staff',
  assignment: '/booking/menus?tab=staff',
  classCapacity: '/events',
};
export const featureLink = (key: string) =>
  features[key] ? { href: features[key] } : {};
export function questionsForStyle(style: AccountStyle): string[] {
  const keys: Record<AccountStyle, string[]> = {
    restaurant: [
      'approval',
      'payment',
      'cancelDeadline',
      'reminders',
      'stamps',
      'coupons',
      'seats',
      'hours',
      'partySize',
    ],
    salon: [
      'approval',
      'payment',
      'cancelDeadline',
      'reminders',
      'tickets',
      'stamps',
      'coupons',
      'nomination',
      'hours',
    ],
    consult: [
      'approval',
      'payment',
      'cancelDeadline',
      'reminders',
      'outcome',
      'assignment',
      'hours',
    ],
    lesson: [
      'approval',
      'payment',
      'cancelDeadline',
      'reminders',
      'tickets',
      'coupons',
      'classCapacity',
      'hours',
    ],
    ec: ['coupons', 'content'],
    standard: ['content'],
  };
  return ['style', 'image', ...keys[style]];
}
export function readAnswers(input: unknown): Record<string, SetupAnswer> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new StyleError('invalid_answers');
  const out: Record<string, SetupAnswer> = {};
  for (const [key, value] of Object.entries(input)) {
    const answer = value as SetupAnswer;
    if (
      !questionKeys.includes(key as (typeof questionKeys)[number]) ||
      !answer ||
      !['configured', 'later', 'manual'].includes(answer.mode) ||
      (answer.value !== undefined &&
        typeof answer.value !== 'string' &&
        typeof answer.value !== 'boolean') ||
      (typeof answer.value === 'string' && answer.value.length > 500) ||
      (answer.resourceId !== undefined && typeof answer.resourceId !== 'string')
    )
      throw new StyleError('invalid_answers');
    out[key] = {
      mode: answer.mode,
      ...(answer.value !== undefined ? { value: answer.value } : {}),
      ...(answer.resourceId ? { resourceId: answer.resourceId } : {}),
    };
  }
  return out;
}
export function defaultCards(style: AccountStyle): StyleCard[] {
  const main: Record<AccountStyle, string[]> = {
    standard: ['getting-started', 'inbox', 'deliveries'],
    ec: ['getting-started', 'ec-orders', 'ec-repeat'],
    restaurant: ['today-seats', 'reservations', 'customers', 'analytics'],
    salon: ['ledger', 'reservations', 'customers', 'analytics'],
    consult: [
      'consultations',
      'results-pending',
      'customers',
      'staff',
      'analytics',
    ],
    lesson: ['classes', 'members', 'trials', 'analytics'],
  };
  return [
    { id: 'connection-alert', visible: true },
    ...(style === 'restaurant'
      ? [{ id: 'channel-close-alert', visible: true }]
      : []),
    ...main[style].map((id) => ({ id, visible: true })),
  ];
}
export function readCards(input: unknown, style: AccountStyle): StyleCard[] {
  if (!Array.isArray(input) || input.length > 50)
    throw new StyleError('invalid_cards');
  const allowed = new Set([
      ...defaultCards(style).map((c) => c.id),
      ...Object.values(DASHBOARD_CARD_GROUPS).flat(),
    ]),
    seen = new Set<string>(),
    out: StyleCard[] = [];
  for (const c of input) {
    if (
      !c ||
      !allowed.has(c.id) ||
      seen.has(c.id) ||
      typeof c.visible !== 'boolean'
    )
      throw new StyleError('invalid_cards');
    seen.add(c.id);
    if (c.id.endsWith('-alert') && !c.visible)
      throw new StyleError('mandatory_alert');
    out.push({ id: c.id, visible: c.visible });
  }
  for (const c of defaultCards(style))
    if (!seen.has(c.id)) out.push({ ...c, visible: c.id.endsWith('-alert') });
  return out;
}

export function readMetricIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > STYLE_METRIC_IDS.length ||
    new Set(value).size !== value.length ||
    value.some((v) => !STYLE_METRIC_IDS.includes(v))
  )
    throw new StyleError('invalid_metrics');
  return value;
}
export function dashboardPresentation(
  style: AccountStyle,
  cards: StyleCard[],
  metrics: string[] | null,
) {
  const tabCard: Partial<Record<string, string>> =
    style === 'standard' || style === 'ec'
      ? {}
      : {
          [style === 'restaurant'
            ? 'today-seats'
            : style === 'salon'
              ? 'ledger'
              : style === 'consult'
                ? 'consultations'
                : 'classes']: 'main',
          [style === 'consult'
            ? 'results-pending'
            : style === 'lesson'
              ? 'trials'
              : 'reservations']: 'bookings',
          [style === 'lesson' ? 'members' : 'customers']: 'people',
          analytics: 'analytics',
        };
  return {
    cards,
    visibleTabs: cards
      .filter((c) => c.visible && tabCard[c.id])
      .map((c) => tabCard[c.id]!),
    metricIds: metrics ?? [...STYLE_DEFAULT_METRIC_IDS[style]],
  };
}
