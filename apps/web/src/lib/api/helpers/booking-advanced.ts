import { fetchApi } from '../../api';
import type { DepositRule, CancellationOptions, BookingGroupView, BookingRecurrence } from '@line-crm/shared';
type Result<T> = {
    success: true;
    data: T;
};
const e = encodeURIComponent;
const account = (path: string, id: string) => `${path}?account_id=${e(id)}`;
const query = (p: string, values: Record<string, string | number | undefined>) => { const q = new URLSearchParams(); for (const [k, v] of Object.entries(values))
    if (v !== undefined)
        q.set(k, String(v)); return `${p}${p.includes('?') ? '&' : '?'}${q}`; };
const json = (method: string, body: unknown, key?: string) => ({ method, body: JSON.stringify(body), ...(key ? { headers: { 'Idempotency-Key': key } } : {}) });
export const bookingAdvancedApi = {
    cancelBookingGroup: (a: string, id: string, reason: string) => fetchApi<Result<{
        cancelled: number;
    }>>(account(`/api/booking/admin/bookings/${e(id)}/group/cancel`, a), json('POST', { reason })),
    createGroup: (a: string, b: {
        friendId: string;
        members: Array<{
            menuId: string;
            staffId?: string;
            label?: string;
            addonIds?: string[];
        }>;
        starts_at: string;
        startMode: 'parallel' | 'sequential';
    }, key: string) => fetchApi<Result<{
        groupId: string;
        bookings: unknown[];
        total: number;
        replayed: boolean;
        notificationsAvailable: false;
    }>>(account('/api/booking/admin/groups', a), json('POST', b, key)),
    depositRule: (a: string) => fetchApi<Result<DepositRule>>(account('/api/booking/admin/deposit-rules', a)),
    saveDepositRule: (a: string, b: Omit<DepositRule, 'version'> & {
        expectedVersion: number;
    }) => fetchApi<Result<DepositRule>>(account('/api/booking/admin/deposit-rules', a), json('PUT', b)),
    menuDeposit: (a: string, id: string) => fetchApi<Result<DepositRule & {
        inherit: boolean;
    }>>(account(`/api/booking/admin/menus/${e(id)}/deposit`, a)),
    saveMenuDeposit: (a: string, id: string, b: Omit<DepositRule, 'version'> & {
        inherit: boolean;
        expectedVersion: number;
    }) => fetchApi<Result<DepositRule & {
        inherit: boolean;
    }>>(account(`/api/booking/admin/menus/${e(id)}/deposit`, a), json('PUT', b)),
    cancellationOptions: (a: string) => fetchApi<Result<CancellationOptions>>(account('/api/booking/admin/cancellation-options', a)),
    saveCancellationOptions: (a: string, b: {
        cardRequiredFor: CancellationOptions['cardRequiredFor'];
        chargeMode: CancellationOptions['chargeMode'];
        expectedVersion: number;
    }) => fetchApi<Result<CancellationOptions>>(account('/api/booking/admin/cancellation-options', a), json('PUT', b)),
    card: (a: string, id: string) => fetchApi<Result<{
        brand: string;
        last4: string;
        registeredAt: string;
    } | null>>(account(`/api/booking/admin/bookings/${e(id)}/payment-method`, a)),
    group: (a: string, id: string) => fetchApi<Result<BookingGroupView | null>>(account(`/api/booking/admin/bookings/${e(id)}/group`, a)),
    series: (a: string, id: string) => fetchApi<Result<unknown>>(account(`/api/booking/admin/bookings/${e(id)}/series`, a)),
    cancelGroup: (a: string, id: string, reason: string, expectedVersion: number, expectedMembers?: Array<{ bookingId: string; version: number; status: string }>) => fetchApi<Result<{
        cancelled: number;
        version: number;
    }>>(account(`/api/booking/admin/groups/${e(id)}/cancel`, a), json('POST', { reason, expectedVersion, expectedMembers })),
    impact: (a: string, id: string, b: {
        scope: 'this' | 'following';
        fromBookingId: string;
        expectedVersion?: number;
        change?: {
            startsAt?: string;
        };
    }) => fetchApi<Result<{
        items: Array<{
            bookingId: string;
            startsAt: string;
            after: string | null;
            blocked: boolean;
            fee: {
                amount: number;
                percent: number;
                reason: string;
            } | null;
        }>;
    }>>(account(`/api/booking/admin/series/${e(id)}/impact`, a), json('POST', b)),
    meetingCapabilities: (a: string) => fetchApi<Result<unknown>>(account('/api/booking/admin/meeting-capabilities', a)),
    costEstimate: (liffId: string, token: string, menuId: string, startsAt: string, partySize = 1) => fetchApi<Result<unknown>>(query('/api/liff/booking/cost-estimate', { liffId, menu_id: menuId, starts_at: startsAt, party_size: partySize }), { headers: { Authorization: `Bearer ${token}` } }),
    seriesPreview: (liffId: string, token: string, b: {
        menuId: string;
        staffId?: string;
        startsAt: string;
        rule: BookingRecurrence;
    }) => fetchApi<Result<unknown>>(query('/api/liff/booking/series/preview', { liffId }), { ...json('POST', b), headers: { Authorization: `Bearer ${token}` } }),
    groupAvailability: (liffId: string, token: string, members: unknown[], from: string, to = from, startMode = 'parallel') => fetchApi<Result<unknown>>(query('/api/liff/booking/group-availability', { liffId, members: JSON.stringify(members), from, to, startMode }), { headers: { Authorization: `Bearer ${token}` } }),
    request: (liffId: string, token: string, b: {
        menu_id?: string;
        starts_at: string;
        members?: Array<{
            menuId: string;
            staffId?: string;
            label?: string;
            addonIds?: string[];
        }>;
        staff_id?: string;
        startMode?: 'parallel' | 'sequential';
        recurrence?: BookingRecurrence;
        routing_token?: string;
        entitlement_id?: string;
    }, key: string) => fetchApi<Result<unknown>>(query('/api/liff/booking/requests', { liffId }), { ...json('POST', b), headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': key } }),
};
