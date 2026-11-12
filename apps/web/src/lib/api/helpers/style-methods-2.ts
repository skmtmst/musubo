import { fetchApi } from '../../api'
import { bookingApi } from '../../api'
import { restaurantTestApi } from '../../restaurant-test-api';
import { root, url, write, Result, StarterEnsureResult, StyleMember } from './styles-common';
export const methods2 = {
  /** 初期セットの入れ直し。足りない物だけを止めた状態で入れ、スタイルの版は上げない（版が違えば 409）。 */
  ensureStarterItems: (accountId: string, expectedVersion: number) =>
    fetchApi<Result<StarterEnsureResult>>(
      url(root + '/starter-items/ensure', accountId),
      write('POST', { expectedVersion }),
    ),

  saveMenu: (
    accountId: string,
    id: string,
    body: {
      expectedVersion: number;
      meetingMode: 'online' | 'in_person' | 'customer_choice';
      location?: string | null;
    },
  ) =>
    fetchApi<Result<{ version: number }>>(
      url(root + '/menus/' + encodeURIComponent(id), accountId),
      write('PATCH', body),
    ),

  saveBooking: (
    accountId: string,
    id: string,
    body: {
      expectedVersion: number;
      meetingMode?: 'online' | 'in_person' | null;
      meetingUrl?: string | null;
      location?: string | null;
      outcome?: 'considering' | 'won' | 'lost' | null;
      cancellationReason?: string | null;
      designation?: 'designated' | 'any' | 'unspecified';
      entryPoint?: string | null;
    },
  ) =>
    fetchApi<Result<{ id: string; version: number }>>(
      url(root + '/bookings/' + encodeURIComponent(id), accountId),
      write('PATCH', body),
    ),

  registerMeet: (body: {
    externalEventId: string;
    friendId: string;
    title: string;
    startsAt: string;
    endsAt: string;
    meetUrl: string;
    bookingId?: string;
    bookingVersion?: number;
  }) =>
    fetchApi<
      Result<{
        id: string;
        reminders: Array<{
          kind: 'day_before' | 'hour_before';
          scheduledAt: string;
        }>;
      }>
    >('/api/meet-consultations', write('POST', body)),

  cancelMeet: (externalEventId: string) =>
    fetchApi('/api/meet-consultations/' + encodeURIComponent(externalEventId), {
      method: 'DELETE',
    }),

  saveMeetResult: (
    accountId: string,
    id: string,
    body: {
      expectedUpdatedAt: string;
      staffId?: string | null;
      attendance?: 'visited' | 'late' | 'no_show' | null;
      outcome?: 'considering' | 'won' | 'lost' | null;
    },
  ) =>
    fetchApi<Result<{ id: string; updatedAt: string }>>(
      url(root + '/meet/' + encodeURIComponent(id), accountId),
      write('PATCH', body),
    ),

  saveClass: (
    accountId: string,
    id: string,
    body: {
      expectedVersion: number;
      classroomCapacity?: number | null;
      onlineCapacity?: number | null;
      instructorId?: string | null;
    },
  ) =>
    fetchApi<Result<{ id: string; version: number }>>(
      url(root + '/classes/' + encodeURIComponent(id), accountId),
      write('PATCH', body),
    ),

  saveTrial: (
    accountId: string,
    id: string,
    expectedVersion: number,
    isTrial: boolean,
  ) =>
    fetchApi(
      url(root + '/events/' + encodeURIComponent(id), accountId),
      write('PATCH', { expectedVersion, isTrial }),
    ),

  saveParticipation: (
    accountId: string,
    id: string,
    participationMode: 'classroom' | 'online',
  ) =>
    fetchApi(
      url(root + '/event-bookings/' + encodeURIComponent(id), accountId),
      write('PATCH', { participationMode }),
    ),

  saveWaitlistParticipation: (
    accountId: string,
    id: string,
    expectedVersion: number,
    participationMode: 'classroom' | 'online',
  ) =>
    fetchApi(
      url(root + '/event-waitlist/' + encodeURIComponent(id), accountId),
      write('PATCH', { expectedVersion, participationMode }),
    ),

  members: (accountId: string) =>
    fetchApi<Result<StyleMember[]>>(url(root + '/members', accountId)),

  saveMember: (
    accountId: string,
    friendId: string,
    body: {
      expectedVersion: number;
      joinedAt: string;
      endedAt?: string | null;
      withdrawalReason?: string | null;
      expiresAt?: string | null;
      planName?: string | null;
      remainingUses?: number | null;
    },
  ) =>
    fetchApi<Result<{ version: number }>>(
      url(root + '/members/' + encodeURIComponent(friendId), accountId),
      write('PUT', body),
    ),

  saveHoliday: (accountId: string, date: string, name: string) =>
    fetchApi(
      url(root + '/holidays/' + encodeURIComponent(date), accountId),
      write('PUT', { name }),
    ),

  saveTarget: (
    accountId: string,
    metric: 'bookings' | 'visits' | 'estimatedRevenue' | 'conversionRate',
    period: string,
    value: number,
  ) =>
    fetchApi(
      url(root + '/targets', accountId),
      write('PUT', { metric, period, value }),
    ),

  analyticsSettings: (accountId: string) =>
    fetchApi<
      Result<{
        holidays: Array<{ date: string; name: string }>;
        targets: Array<{ metric: string; period: string; value: number }>;
        pageViews: number;
      }>
    >(url(root + '/analytics-settings', accountId)),

  closeHours: (
    accountId: string,
    body: {
      date: string;
      target: 'store' | 'staff';
      staffId?: string;
      allDay: boolean;
      startTime?: string;
      endTime?: string;
      reason?: string;
    },
  ) => fetchApi(url(root + '/closures', accountId), write('POST', body)),

  closureConfirmation: (accountId: string, body: { date: string; target: 'store' | 'staff'; staffIds: string[]; allDay: boolean; startTime?: string; endTime?: string; reason?: string }) =>
    fetchApi<{ success: true; data: { snapshot: string; reservations: Array<{ id: string; name: string; startsAt: string; endsAt: string; partySize: number }> } }>(url(root + '/closures/confirmation', accountId), write('POST', body)),
  closeHoursConfirmed: (accountId: string, body: { date: string; target: 'store' | 'staff'; staffIds: string[]; allDay: boolean; startTime?: string; endTime?: string; reason?: string; expectedSnapshot: string }) =>
    fetchApi<{ success: true; data: { count: number } }>(url(root + '/closures/confirmed', accountId), write('POST', body)),

  // Existing restaurant closures include preview, table selection and affected reservations.
  closeRestaurant: restaurantTestApi.createClosure,

  previewRestaurantClosure: restaurantTestApi.previewClosure,

  existingExceptions: bookingApi.listExceptions,

  readiness: (liffId: string, idToken: string, feature: string) =>
    fetchApi<
      Result<{
        feature: string;
        ready: boolean;
        state: 'ready' | 'preparing';
        message: string | null;
        href?: string;
      }>
    >(
      `/api/liff/booking/style-readiness?${new URLSearchParams({ liffId, feature })}`,
      { headers: { Authorization: `Bearer ${idToken}` } },
    ),

  recordPageView: (
    liffId: string,
    idToken: string,
    body: { menuId?: string; entryPoint?: string },
  ) =>
    fetchApi(
      `/api/liff/booking/page-views?liffId=${encodeURIComponent(liffId)}`,
      {
        ...write('POST', body),
        headers: { Authorization: `Bearer ${idToken}` },
      },
    )
};
