import type {
  AccountStyle,
  StyleSelectionStatus,
  SetupAnswer,
  StyleCard,
  StyleSnapshot,
  StyleAnalyticsData,
  StyleDisplay,
  StyleCalendarView,
  StyleSchedule,
  StyleTemplateSample,
} from '@line-crm/shared';
import { fetchApi } from '../../api';

import {
  root,
  url,
  write,
  Result,
  StyleQuery,
  StyleSelection,
  StarterSetItem,
  StyleBookingDetails,
  StyleClassDetails,
} from './styles-common';
export const methods1 = {
  ecSummary: (accountId: string, query: { range?: 'today' | 'week' | 'month'; date?: string; from?: string; to?: string } = {}) =>
    fetchApi<Result<import('@line-crm/shared').EcStyleSummary>>(url(root + '/ec-summary', accountId, query)),
  get: (accountId: string, registration = false) =>
    fetchApi<
      Result<StyleSelectionStatus & {
        style: AccountStyle;
        styleSelected: boolean;
        styleMode: SetupAnswer['mode'];
        version: number;
        answers: Record<string, SetupAnswer>;
        settings: Record<string, number>;
        cards: StyleCard[];
        metricIds: string[];
        /** Older Workers omit provenance; never infer it from the selected list. */
        metricsCustomized?: boolean;
        visibleTabs: string[];
        questions: Array<{
          key: string;
          changeAt?: string;
          canChangeLater: boolean;
          recommended: string | boolean;
          modes: Array<SetupAnswer['mode']>;
        }>;
      }>
    >(url(root, accountId, { registration: registration ? '1' : undefined }), registration ? { cache: 'no-store' } : undefined),

  save: (accountId: string, body: StyleSelection, registration = false) =>
    fetchApi<
      Result<StyleSelectionStatus & {
        style: AccountStyle;
        styleMode: SetupAnswer['mode'];
        styleSelected: boolean;
        version: number;
        catalogApplication?: import('@line-crm/shared').StarterCatalogApplyResult;
        changedAnswers: Record<string, SetupAnswer>;
        bookingSettingsChanges: Array<{ key: string; answer: SetupAnswer }>;
        inserted: Array<{
          key: string;
          name: string;
          setId: string;
          setVersion: number;
          kind: string;
          id: string;
          isSample: boolean;
          requiresActivation: boolean;
        }>;
      }>
    >(url(root, accountId, { registration: registration ? '1' : undefined }), write('PUT', body)),

  warnings: (accountId: string) =>
    fetchApi<
      Result<{
        count: number;
        items: Array<{
          feature: string;
          areaId: string;
          groupId: string;
          href?: string;
          customerState: 'preparing';
        }>;
        pending: Array<{ key: string; href?: string; mode: string }>;
        manual: Array<{ key: string; href?: string }>;
      }>
    >(url(root + '/warnings', accountId)),

  starterSet: (accountId: string, style: AccountStyle, initialMenu = false) =>
    fetchApi<
      Result<{
        id: string;
        version: number;
        autoInsert: boolean;
        definition: { items: StarterSetItem[] };
      }>
    >(url(root + '/starter-set', accountId, { style, ...(initialMenu ? { initialMenu:'true' } : {}) })),

  templateSamples: (accountId: string, style: AccountStyle) =>
    fetchApi<Result<{ style: AccountStyle; items: StyleTemplateSample[] }>>(
      url(root + '/template-samples', accountId, { style }),
    ),

  starterItems: (accountId: string) =>
    fetchApi<
      Result<{
        items: Array<{
          target_id: string;
          key: string;
          name: string | null;
          isSample: boolean;
          /** 本文と配布情報は、編集できるオーナー・管理者にだけ返る。 */
          setId?: string | null;
          setVersion?: number;
          pendingUpdate?: {
            setId: string;
            setVersion: number;
            item: StarterSetItem;
          } | null;
          currentSnapshot?: string | null;
          activationAllowed: boolean;
          requiresActivation: boolean;
          definition?: {
            buttons?: Array<{
              label: string;
              actionType: string;
              actionData: string;
            }>;
            steps?: Array<{
              offsetMinutes: number;
              offsetDays: number | null;
              sendAtTime: string | null;
              text: string;
            }>;
          } | null;
          kind: string;
          is_sample: number;
          status: string | null;
          draftRevision: string | null;
        }>;
      }>
    >(url(root + '/starter-items', accountId)),

  acceptStarterUpdate: (
    accountId: string,
    key: string,
    body: {
      confirmed: true;
      expectedSetVersion: number;
      expectedSnapshot: string | null;
    },
  ) =>
    fetchApi<{ success: true }>(
      url(
        root + '/starter-items/' + encodeURIComponent(key) + '/accept-update',
        accountId,
      ),
      write('POST', body),
    ),

  activate: (
    accountId: string,
    items: Array<{
      id: string;
      kind: 'automation' | 'reminder' | 'booking_menu';
      expectedDraftVersionId?: string;
      expectedVersion?: number;
    }>,
  ) =>
    fetchApi<
      Result<{
        complete: boolean;
        items: Array<{
          id: string;
          success: boolean;
          status?: string;
          code?: string;
        }>;
      }>
    >(
      url(root + '/activate', accountId),
      write('POST', { confirmed: true, items }),
    ),

  resources: (accountId: string) =>
    fetchApi<
      Result<{
        items: Array<{
          id: string;
          name: string;
          kind: string;
          isSample?: boolean;
          key?: string | null;
          setId?: string | null;
          setVersion?: number | null;
        }>;
      }>
    >(url(root + '/resources', accountId)),

  summary: (accountId: string, query: StyleQuery) =>
    fetchApi<Result<StyleSnapshot>>(url(root + '/summary', accountId, query)),

  schedule: (
    accountId: string,
    query: Pick<
      StyleQuery,
      'style' | 'range' | 'date' | 'staff_id' | 'store_id' | 'menu_id'
    > & {
      display?: StyleDisplay;
      calendar_view?: StyleCalendarView;
      axis?: 'staff' | 'table';
      sort?: 'time' | 'name';
      guest_count?: string;
      duration_minutes?: string;
    },
  ) =>
    fetchApi<Result<StyleSchedule>>(url(root + '/schedule', accountId, query)),

  analytics: (accountId: string, query: StyleQuery) =>
    fetchApi<Result<StyleSnapshot & { analytics: StyleAnalyticsData }>>(
      url(root + '/analytics', accountId, query),
    ),

  bookings: (accountId: string, query: StyleQuery) =>
    fetchApi<Result<StyleSnapshot>>(url(root + '/bookings', accountId, query)),

  people: (accountId: string, query: StyleQuery) =>
    fetchApi<
      Result<
        StyleSnapshot & {
          people: Array<{
            personKey: string;
            friendId: string | null;
            name: string;
            visits: number;
            lastVisit: string;
            intervalDays: number | null;
            nextBooking: string | null;
            recall: boolean;
          }>;
        }
      >
    >(url(root + '/people', accountId, query)),

  createAudience: (accountId: string, resultId: string, friendIds?: string[]) =>
    fetchApi<
      Result<{
        id: string;
        memberCount: number;
        unreachableCount: number;
        expiresAt: string;
      }>
    >(
      url(
        `/api/analytics/results/${encodeURIComponent(resultId)}/audiences`,
        accountId,
      ),
      write('POST', { sourceKind: 'booking', friendIds }),
    ),

  saveCards: (
    accountId: string,
    expectedVersion: number,
    cards: StyleCard[],
    metricIds?: string[],
  ) =>
    fetchApi<
      Result<{
        cards: StyleCard[];
        version: number;
        metricIds: string[];
        /** Older Workers omit provenance; never infer it from the selected list. */
        metricsCustomized?: boolean;
        visibleTabs: string[];
      }>
    >(
      url(root + '/cards', accountId),
      write('PUT', {
        expectedVersion,
        cards,
        ...(metricIds === undefined ? {} : { metricIds }),
      }),
    ),

  resetCards: (accountId: string, expectedVersion: number) =>
    fetchApi<
      Result<{
        cards: StyleCard[];
        version: number;
        metricIds: string[];
        /** Older Workers omit provenance; never infer it from the selected list. */
        metricsCustomized?: boolean;
        visibleTabs: string[];
      }>
    >(url(root + '/cards', accountId), write('DELETE', { expectedVersion })),

  menu: (accountId: string, id: string) =>
    fetchApi<
      Result<{
        id: string;
        name: string;
        version: number;
        meetingMode: string;
        location: string | null;
      }>
    >(url(root + '/menus/' + encodeURIComponent(id), accountId)),

  booking: (accountId: string, id: string) =>
    fetchApi<Result<StyleBookingDetails>>(
      url(root + '/bookings/' + encodeURIComponent(id), accountId),
    ),

  class: (accountId: string, id: string) =>
    fetchApi<Result<StyleClassDetails>>(
      url(root + '/classes/' + encodeURIComponent(id), accountId),
    ),

  saveRestaurantStaff: (
    accountId: string,
    id: string,
    expectedVersion: number,
    staffId: string | null,
  ) =>
    fetchApi(
      url(
        root + '/restaurant-reservations/' + encodeURIComponent(id),
        accountId,
      ),
      write('PATCH', { expectedVersion, staffId }),
    ),
};
