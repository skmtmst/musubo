export const ACCOUNT_STYLES = [
  'standard',
  'ec',
  'restaurant',
  'salon',
  'consult',
  'lesson',
] as const;
export type AccountStyle = (typeof ACCOUNT_STYLES)[number];
export type IndustryStyle = Exclude<AccountStyle, 'standard' | 'ec'>;
export type StyleRange = 'today' | 'week' | 'month';
export type StyleDisplay = 'board' | 'list' | 'calendar';
export type StyleCalendarView = 'day' | 'week' | 'month';
export type StyleTemplateSample = {
  key: string;
  name: string;
  category: 'common' | IndustryStyle;
  text: string;
  placeholders: Array<{
    token: string;
    label: string;
    requiresConfiguration: boolean;
  }>;
  preparation: string;
  starterItem: { key: string; kind: 'template'; name: string; text: string };
  hqDefinition: MessageTemplateDefinition;
};
import type { MessageTemplateDefinition } from './template-definition.js';
export type SetupAnswer = {
  mode: 'configured' | 'later' | 'manual';
  value?: string | boolean;
  resourceId?: string;
};
/** スタイル固有の初回案内。既存の後回しを未選択へ読み替えない。 */
export type StyleSelectionStatus = {
  styleSelected: boolean;
  styleMode?: SetupAnswer['mode'];
  shouldPromptStyleSelection?: boolean;
};
export type StyleCard = { id: string; visible: boolean };
export type StyleMetric = {
  value: number | null;
  numerator?: number;
  denominator?: number;
  totalTables?: number;
  status: 'available' | 'insufficient_sample' | 'unconfigured';
  formula: string;
  unit: string;
};
export type StyleBooking = {
  id: string;
  version: number | null;
  confirmationRevision?: number | null;
  updatedAt: string | null;
  kind: 'booking' | 'restaurant' | 'meet' | 'event';
  friendId: string | null;
  personKey: string;
  name: string;
  startsAt: string;
  endsAt: string;
  requestedAt: string;
  status: string;
  staffId: string | null;
  menuId: string | null;
  menuName?: string | null;
  storeId: string | null;
  slotId: string | null;
  departedAt?: string | null;
  partySize: number;
  price: number;
  visited: boolean;
  attendance: string | null;
  held: boolean;
  meetingMode: string | null;
  meetingUrl: string | null;
  location: string | null;
  outcome: string | null;
  source: string;
  entryPoint: string | null;
  refCode: string | null;
  designation: string | null;
  cancelledAt: string | null;
  confirmedResponse: string | null;
  participationMode: string | null;
  payment?: {
    bookingId: string;
    status: 'paid' | 'pending' | 'refunded' | 'expired' | 'onsite';
    method: string | null;
    amount: number;
  } | null;
};
export type StyleDailyMetrics = { date: string; metrics: Record<string, StyleMetric> };
export type StyleAnalyticsData = Record<string, unknown> & {
  dailyComparison?: { current: StyleDailyMetrics[]; previous?: StyleDailyMetrics[] };
};
export type StyleSnapshot = {
  style: IndustryStyle;
  asOf: string;
  timeZone: string;
  from: string;
  to: string;
  dateBasis: 'visit';
  range: StyleRange;
  metrics: Record<string, StyleMetric>;
  previous: Record<string, StyleMetric>;
  items: StyleBooking[];
  newBookings: StyleBooking[];
  resultId: string;
  sidebar?: StyleDashboardSidebar;
  payments?: StyleDashboardPayments;
};

export type StyleScheduleEntry = {
  id: string;
  kind: StyleBooking['kind'] | 'class';
  columnIds: string[];
  tableNames?: string[];
  startsAt: string;
  endsAt: string;
  title: string;
  booking: StyleBooking | null;
  classId?: string;
};
export type StyleSchedule = {
  style: IndustryStyle;
  asOf: string;
  timeZone: string;
  range: StyleRange;
  display: StyleDisplay;
  calendarView: StyleCalendarView;
  from: string;
  to: string;
  columns: Array<{
    id: string;
    kind: 'staff' | 'table' | 'unassigned';
    name: string;
    storeId?: string;
  }>;
  entries: StyleScheduleEntry[];
  days: Array<{
    date: string;
    entryIds: string[];
    bookings: number;
    people: number;
  }>;
  closures: Array<{
    id: string;
    target: 'store' | 'staff' | 'table' | 'resource';
    targetIds: string[];
    dateFrom: string;
    dateTo: string;
    kind: string;
    hours: Array<{ start: string; end: string }>;
    reason: string | null;
  }>;
  availability: {
    status: 'available' | 'unconfigured' | 'unavailable';
    reason: string | null;
    resources: Array<{ id: string; name: string; storeId?: string }>;
    slots: Array<{
      columnId: string;
      menuId: string | null;
      date: string;
      startsAt: string;
      endsAt: string;
      remaining: number | null;
      mode?: 'classroom' | 'online';
      resourceIds?: string[];
      entryId?: string;
    }>;
    closedDates: string[];
  };
};

export const STYLE_METRIC_IDS = [
  'bookings',
  'guests',
  'visits',
  'noShowRate',
  'cancelRate',
  'estimatedRevenue',
  'nextBookingRate',
  'secondVisitRate',
  'thirdVisitRate',
  'returnRate',
  'recall',
  'attention',
  'weekBookings',
  'resultPending',
  'conversionRate',
  'capacity',
  'freeTables',
  'classes',
  'inactiveMembers',
  'trialConversion',
  'attendancePending',
  'unseated',
  'firstTime',
  'regular',
  'paidAmount',
  'pendingCount',
  'newBookings',
  'classroomOccupancy',
  'onlineOccupancy',
  'unlimitedClasses',
  'mediaCloseTasks',
  'tableUtilization',
] as const;
export type StyleMetricId = (typeof STYLE_METRIC_IDS)[number];
export type StyleDashboardSidebar = {
  today: string;
  attention: Array<{
    id: string;
    name: string;
    friendId: string | null;
    startsAt: string;
    allergy: string | null;
    anniversary: boolean;
    noShowHistory: boolean;
  }>;
  waitlist: Array<{
    id: string;
    name: string;
    startsAt: string;
    partySize: number;
    status: string;
    storeId: string;
  }>;
  noNextBooking: Array<{
    personKey: string;
    friendId: string | null;
    name: string;
    visits: number;
    lastVisit: string;
    intervalDays: number | null;
    nextBooking: string | null;
    recall: boolean;
  }>;
};
export type StyleDashboardPayments =
  | {
      status: 'available';
      paidAmount: number;
      paidCount: number;
      refundedAmount: number;
      refundedCount: number;
      pendingCount: number;
      expiredCount: number;
      holdMinutes: number;
      source: string;
      /** Present when the values use the selected analytics window rather than today. */
      period?: { from: string; to: string; timeZone: string; dateBasis: 'payment' };
    }
  | { status: 'forbidden' | 'unavailable'; reason?: string };

export type StyleSampleMetadata = {
  isSample: boolean;
  sampleKey: string | null;
  starterSetId: string | null;
  starterSetVersion: number | null;
};

/** Initial KPI choices shared by the dashboard and its reset action. Free-table count and utilization are the day/period forms of the same restaurant card. */
export const STYLE_DEFAULT_METRIC_IDS: Record<
  AccountStyle,
  readonly StyleMetricId[]
> = {
  standard: [],
  ec: [],
  restaurant: [
    'bookings',
    'attention',
    'freeTables',
    'tableUtilization',
    'noShowRate',
    'newBookings',
  ],
  salon: [
    'bookings',
    'attention',
    'nextBookingRate',
    'paidAmount',
    'newBookings',
  ],
  consult: [
    'bookings',
    'resultPending',
    'weekBookings',
    'noShowRate',
    'newBookings',
  ],
  lesson: [
    'classes',
    'attendancePending',
    'classroomOccupancy',
    'paidAmount',
    'newBookings',
  ],
};

/** EC uses its existing order projection, outside the four industry booking dashboards. */
export type EcStyleSummary = {
  style: 'ec'; from: string; to: string; timeZone: string; range: StyleRange;
  asOf: string | null; computedAt: string; dateBasis: 'ordered_at';
  status: 'available' | 'unconfigured' | 'unavailable' | 'stale';
  orders: StyleMetric; repeatCustomers: StyleMetric;
  changeAt: string; ordersAt: string; autoLineAt: string;
};
