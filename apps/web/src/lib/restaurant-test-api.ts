import type { RestaurantClosure, RestaurantClosureInput, RestaurantClosurePreview, RestaurantClosureSaveResult, RestaurantSeatAvailability } from '@line-crm/shared'
export type { RestaurantClosure, RestaurantClosureInput, RestaurantClosurePreview, RestaurantClosureSaveResult, RestaurantSeatAvailability } from '@line-crm/shared'
import type { RestaurantInventoryRules, RestaurantInventoryRulesInput, RestaurantChannelCloseTask } from '@line-crm/shared'
import type { RestaurantHoldInput, RestaurantHoldResult, RestaurantCustomer, RestaurantCustomerHistory, RestaurantOpeningHours, RestaurantAllocation, RestaurantLoginMember, RestaurantMenuChangeResult, RestaurantTableLayoutInput, RestaurantTablePosition, RestaurantApprovalDecision } from '@line-crm/shared'
import { fetchApi } from './api'

export type RestaurantStore = {
  id: string; organization_id: string; name: string; code: string; area: string | null;
  capacity: number; timezone: string; status: 'active' | 'paused' | 'archived';
  line_status: 'connected' | 'warning' | 'error' | 'unconfigured'; google_status: string;
  line_account_id: string | null; line_account_name: string | null; friend_count?: number | null
}
export type RestaurantMembership = {
  id: string; store_id: string | null; staff_name: string; email: string | null; role: 'super_admin' | 'store_manager' | 'staff';
  line_uid: string | null; google_email: string | null; status: string;
  staff_id?: string | null; loginName?: string | null; loginRole?: 'owner' | 'admin' | 'staff' | null;
  loginAccessLevel?: 'full' | 'read_only' | null; loginActive?: number | null; loginPolicyVersion?: number | null;
  loginAccountScope?: 'all' | 'accounts' | null; loginAccountIdsJson?: string | null
}
export type RestaurantStoreGroup = {
  id: string; organization_id: string; name: string;
  members: Array<{ group_id: string; store_id: string; referral_enabled: 0 | 1; max_distance: number; version: number }>
}
export type RestaurantApproval = {
  id: string; store_id: string | null; kind: 'gbp_post' | 'line_message' | 'menu_change'; title: string;
  status: string; requested_by: string | null; review_comment: string | null; created_at: string;
  payload_json: string | null
}
export type ReservationQuery = {
  from?: string; to?: string; status?: string; limit?: number; offset?: number
}
export type RestaurantReservation = {
  arrived_at?:string|null; departed_at?:string|null;
  id: string; store_id: string; store_name: string; source: string; external_id: string | null;
  customer_name: string; customer_phone: string | null; line_uid: string | null; guest_count: number;
  starts_at: string; ends_at: string; table_id: string | null; table_label: string | null;
  course_id: string | null; course_name: string | null; status: string; allergy_note: string | null; note: string | null;
  hold_expires_at?: string | null; customer_version?: number; confirmation_revision?: number; dining_snapshot_json?: string | null; table_ids_json?: string;
  sync_direction: 'inbound_only'
}
export type RestaurantTable = {
  id: string; store_id: string; code: string; label: string; seat_type: string; min_capacity: number;
  max_capacity: number; floor_id?:string; floor_version?:number; confirmation_revision?:number; floor_x: number; floor_y: number; join_group: string | null; is_active: number;
  shape?: 'rectangle'|'circle'|'long'|'counter'|'sofa'; width?:number; height?:number; rotation?:number;
  smoking_policy?:'non_smoking'|'smoking'|'heated_tobacco'; partition_type?:'open'|'semi_private'|'private'; shoes_allowed?:number;
  visible_on_map?:number; chair_arrangement?:'both'|'one'|'all'; chair_side?:'top'|'right'|'bottom'|'left'|null; seat_detail_type?:string|null
}
export type RestaurantRotation = {date:string;activeTables:number;departedGroups:number;turnover:number|null;utilization:number|null;averageStayMinutes:number|null;noShowRate:number|null;unmeasuredVisits:number};

export type SeatVisitMark = {
  id?: string; kind: 'visited' | 'late' | 'no_show'; late_minutes: number | null;
  marked_by_name: string | null; marked_at: string
}
export type SeatWaitlistEntry = {
  id: string; store_id: string; starts_at: string; guest_count: number; customer_name: string;
  confirmation_revision?: number;
  status: 'waiting' | 'invited' | 'converted' | 'cancelled' | 'finished'; hold_minutes: number;
  table_id: string | null; table_label?: string | null;
  invited_at: string | null; hold_expires_at: string | null; notified_at: string | null; created_at: string
}
export type RestaurantInventory = {
  id: string; store_id: string; starts_at: string; slot_minutes: 15 | 30; total_capacity: number;
  ota_capacity: number; line_capacity: number; walk_in_capacity: number; same_day_capacity?: number; reserved_count: number; version?: number; updated_by?: string | null; updated_by_name?: string | null; updated_at?: string;
  guest_count?: number; occupied_seats?: number; occupiedTableIds?: string[]; closedTableIds?: string[]; freeSeats?: number
}
export type RestaurantMenuItem = {
  id: string; store_id: string; kind: 'course' | 'a_la_carte'; name: string; price: number;
  description?: string | null; image_media_id?: string | null; confirmation_revision: number;
  tax_mode: string; allergens_json: string; service_periods_json: string; duration_minutes: number | null; status: string; pendingPrice?: number | null; pendingEffectiveAt?: string | null; priceChangeStatus?: string | null
}
export type RestaurantConnector = {
  id: string; store_id: string; provider: string; mode: 'disabled' | 'inbound_only'; status: string;
  last_synced_at: string | null; last_error: string | null
}
export type RestaurantReview = {
  id: string; store_id: string; author_name: string | null; rating: number; comment: string | null;
  reviewed_at: string; reply_status: string; reply_draft: string | null; sentiment: string | null
}
export type RestaurantPost = {
  id: string; store_id: string; post_type: string; title: string; body: string; status: string; scheduled_at: string | null
}
export type RestaurantLineFlow = {
  id: string; store_id: string | null; flow_type: string; title: string; body: string;
  timing_minutes: number | null; is_enabled: number; delivery_mode: 'preview_only' | 'disabled'
}
export type RestaurantIntakeAddress = {
  id: string; storeId: string; localPart: string; address: string; status: 'active';
  createdAt: string; revokedAt: string | null
}
export type RestaurantTermsAgreement = {
  documentKey: string; agreedVersion: string | null; agreedAt: string | null
}

export type RestaurantSnapshot = {
  environment: 'staging_test'; integrationPolicy: 'inbound_only';
  organization: {
    id: string; account_id: string; tenant_id: string | null; tenant_name: string | null;
    name: string; status: string
  } | null;
  stores: RestaurantStore[]; memberships: RestaurantMembership[]; approvals: RestaurantApproval[];
  reservations: RestaurantReservation[]; reservationTotal: number; tables: RestaurantTable[]; inventory: RestaurantInventory[];
  menuItems: RestaurantMenuItem[]; connectors: RestaurantConnector[]; reviews: RestaurantReview[];
  posts: RestaurantPost[]; lineFlows: RestaurantLineFlow[]
}

const withAccount = (path: string, accountId: string) =>
  `${path}${path.includes('?') ? '&' : '?'}account_id=${encodeURIComponent(accountId)}`

const withOptionalAccount = (path: string, accountId: string | null) =>
  accountId ? withAccount(path, accountId) : path

export const restaurantTestApi = {
  storeGroups: (accountId: string) => fetchApi<{ success: true; data: RestaurantStoreGroup[] }>(withAccount('/api/restaurant-test/store-groups', accountId)),
  updateStoreGroupMember: (accountId: string, groupId: string, storeId: string, body: { referralEnabled: boolean; maxDistance: number; expectedVersion?: number }) => fetchApi<{ success: true; data: { updated: true } }>(withAccount(`/api/restaurant-test/store-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(storeId)}`, accountId), { method: 'PATCH', body: JSON.stringify(body) }),
  closures: (accountId:string,storeId:string,month?:string)=>fetchApi<{success:true;data:RestaurantClosure[]}>(withAccount(`/api/restaurant-test/closures?${new URLSearchParams({storeId,...(month?{month}:{})})}`,accountId)),
  closureContactStatus:(accountId:string,id:string)=>fetchApi<{success:true;data:RestaurantClosurePreview}>(withAccount(`/api/restaurant-test/closures/${encodeURIComponent(id)}/contact-status`,accountId)),
  previewClosure: (accountId:string,body:RestaurantClosureInput & {excludeId?:string})=>fetchApi<{success:true;data:RestaurantClosurePreview}>(withAccount('/api/restaurant-test/closures/preview',accountId),{method:'POST',body:JSON.stringify(body)}),
  createClosure: (accountId:string,body:RestaurantClosureInput)=>fetchApi<{success:true;data:RestaurantClosureSaveResult}>(withAccount('/api/restaurant-test/closures',accountId),{method:'POST',body:JSON.stringify(body)}),
  updateClosure: (accountId:string,id:string,body:RestaurantClosureInput&{expectedVersion:number})=>fetchApi<{success:true;data:RestaurantClosureSaveResult}>(withAccount(`/api/restaurant-test/closures/${encodeURIComponent(id)}`,accountId),{method:'PATCH',body:JSON.stringify(body)}),
  deleteClosure: (accountId:string,id:string,expectedVersion:number)=>fetchApi<{success:true;data:{id:string;version:number;archived:true}}>(withAccount(`/api/restaurant-test/closures/${encodeURIComponent(id)}`,accountId),{method:'DELETE',body:JSON.stringify({expectedVersion})}),
  seatAvailability: (accountId:string,query:{storeId:string;startsAt:string;endsAt:string;guestCount:number})=>fetchApi<{success:true;data:RestaurantSeatAvailability}>(withAccount(`/api/restaurant-test/availability?${new URLSearchParams({...query,guestCount:String(query.guestCount)})}`,accountId)),
  closeNotificationSettings:(accountId:string,storeId:string)=>fetchApi<{success:true;data:import('@line-crm/shared').RestaurantCloseNotificationSettings}>(withAccount(`/api/restaurant-test/close-notification-settings?storeId=${encodeURIComponent(storeId)}`,accountId)),
  saveCloseNotificationSettings:(accountId:string,body:Omit<import('@line-crm/shared').RestaurantCloseNotificationSettings,'version'> & {expectedVersion:number})=>fetchApi<{success:true;data:import('@line-crm/shared').RestaurantCloseNotificationSettings}>(withAccount('/api/restaurant-test/close-notification-settings',accountId),{method:'PUT',body:JSON.stringify(body)}),
  inventoryRules: (accountId:string,storeId:string)=>fetchApi<{success:true;data:RestaurantInventoryRules}>(withAccount(`/api/restaurant-test/inventory-rules?storeId=${encodeURIComponent(storeId)}`,accountId)),
  inventoryRuleState: (accountId:string,storeId:string,date:string)=>fetchApi<{success:true;data:RestaurantInventoryRules;state:import('@line-crm/shared').RestaurantInventoryRuleState}>(withAccount(`/api/restaurant-test/inventory-rules?${new URLSearchParams({storeId,date})}`,accountId)),
  saveInventoryRules: (accountId:string,body:RestaurantInventoryRulesInput)=>fetchApi<{success:true;data:RestaurantInventoryRules}>(withAccount('/api/restaurant-test/inventory-rules',accountId),{method:'PUT',body:JSON.stringify(body)}),
  channelCloseTasks: (accountId:string,storeId:string,filters:{source?:string;channel?:string}={})=>fetchApi<{success:true;data:RestaurantChannelCloseTask[]}>(withAccount(`/api/restaurant-test/channel-close-tasks?${new URLSearchParams({storeId,...filters})}`,accountId)),
  markChannelOpened: (accountId:string,id:string,expectedGeneration:number)=>fetchApi<{success:true;data:{id:string;status:'reopen';opened:true;generation:number}}>(withAccount(`/api/restaurant-test/channel-close-tasks/${encodeURIComponent(id)}/opened`,accountId),{method:'POST',body:JSON.stringify({expectedGeneration})}),
  completeChannelCloseTask: (accountId:string,id:string)=>fetchApi<{success:true;data:{id:string;status:'done'}}>(withAccount(`/api/restaurant-test/channel-close-tasks/${encodeURIComponent(id)}/done`,accountId),{method:'POST'}),
  loginMembers: (accountId: string) => fetchApi<{ success: true; data: RestaurantLoginMember[] }>(withAccount('/api/restaurant-test/login-members', accountId)),
  linkMembershipLogin: (accountId: string, id: string, staffId: string | null) => fetchApi<{ success: true; data: { id: string; staffId: string | null } }>(withAccount(`/api/restaurant-test/memberships/${encodeURIComponent(id)}/login`, accountId), { method: 'PUT', body: JSON.stringify({ staffId }) }),
  openingHours: (accountId: string, storeId: string) => fetchApi<{ success: true; data: RestaurantOpeningHours }>(withAccount(`/api/restaurant-test/opening-hours?storeId=${encodeURIComponent(storeId)}`, accountId)),
  saveOpeningHours: (accountId: string, body: { storeId: string; hours: NonNullable<RestaurantOpeningHours['hours']>; expectedVersion: number; lateArrivalPolicy?: import('@line-crm/shared').RestaurantLateArrivalPolicy | null }) => fetchApi<{ success: true; data: { version: number } }>(withAccount('/api/restaurant-test/opening-hours', accountId), { method: 'PUT', body: JSON.stringify(body) }),
  inventoryDay: (accountId: string, storeId: string, date: string) => fetchApi<{ success: true; data: RestaurantInventory[]; closures: RestaurantClosure[] }>(withAccount(`/api/restaurant-test/inventory/day?storeId=${encodeURIComponent(storeId)}&date=${encodeURIComponent(date)}`, accountId)),
  generateInventory: (accountId: string, body: RestaurantAllocation & { storeId: string; date: string; expectedHoursVersion: number }) => fetchApi<{ success: true; data: { generated: number } }>(withAccount('/api/restaurant-test/inventory/generate', accountId), { method: 'POST', body: JSON.stringify(body) }),
  saveInventoryAllocation: (accountId: string, body: RestaurantAllocation & { storeId: string; slots: Array<{ id: string; expectedVersion: number }> }) => fetchApi<{ success: true; data: { updated: number } }>(withAccount('/api/restaurant-test/inventory/allocation', accountId), { method: 'PUT', body: JSON.stringify(body) }),
  holdReservation: (accountId: string, body: RestaurantHoldInput) => fetchApi<{ success: true; data: RestaurantHoldResult }>(withAccount('/api/restaurant-test/reservations/holds', accountId), { method: 'POST', body: JSON.stringify(body) }),
  reservationsDay: (accountId: string, storeId: string, date: string) => fetchApi<{ success: true; data: { date: string; reservations: RestaurantReservation[]; closures: RestaurantClosure[] } }>(withAccount(`/api/restaurant-test/reservations/day?storeId=${encodeURIComponent(storeId)}&date=${encodeURIComponent(date)}`, accountId)),
  customerSearch: (accountId: string, storeId: string, q: string) => fetchApi<{ success: true; data: RestaurantCustomer[] }>(withAccount(`/api/restaurant-test/customers/search?storeId=${encodeURIComponent(storeId)}&q=${encodeURIComponent(q)}`, accountId)),
  walkIn: (accountId: string, input: { storeId: string; guestCount: number; tableId: string; customerName?: string; customerPhone?: string; lineUid?: string }) => fetchApi<{ success: true; data: { id: string; tableId: string; status: 'visited'; source: 'walk_in'; startsAt: string; endsAt: string } }>(withAccount('/api/restaurant-test/reservations/walk-in', accountId), { method: 'POST', body: JSON.stringify(input) }),
  media: (accountId:string)=>fetchApi<{success:true;data:Array<{code:string;name:string;acceptsReservations:0|1}>}>(withAccount('/api/restaurant-test/media',accountId)),
  addGourmetMedia: (accountId:string,body:{code:string;name:string})=>fetchApi<{success:true;data:{code:string;name:string;acceptsReservations:false}}>(withAccount('/api/restaurant-test/media',accountId),{method:'POST',body:JSON.stringify(body)}),
  mediaLinks: (accountId:string,storeId:string)=>fetchApi<{success:true;data:Array<{code:string;name:string;acceptsReservations:0|1;pageUrl:string|null;loginUrl:string|null;closeOnBooking:0|1;version:number}>}>(withAccount(`/api/restaurant-test/media-links?storeId=${encodeURIComponent(storeId)}`,accountId)),
  saveMediaLink: (accountId:string,code:string,body:{storeId:string;pageUrl:string|null;loginUrl:string|null;closeOnBooking:boolean;expectedVersion:number})=>fetchApi<{success:true;data:{storeId:string;code:string;pageUrl:string|null;loginUrl:string|null;closeOnBooking:boolean;version:number}}>(withAccount(`/api/restaurant-test/media-links/${encodeURIComponent(code)}`,accountId),{method:'PUT',body:JSON.stringify(body)}),
  reservationLink: (accountId:string,storeId:string)=>fetchApi<{success:true;data:{url:string;html:string;available:true}}>(withAccount('/api/restaurant-test/reservation-link',accountId),{method:'POST',body:JSON.stringify({storeId})}),
  customerHistory: (accountId: string, storeId: string, contact: { phone?: string; lineUid?: string }) => fetchApi<{ success: true; data: RestaurantCustomerHistory }>(withAccount(`/api/restaurant-test/customers/history?${new URLSearchParams({ storeId, ...(contact.lineUid ? { lineUid: contact.lineUid } : { phone: contact.phone || '' }) })}`, accountId)),
  listStores: (accountId: string) => fetchApi<{ success: true; data: { organization: RestaurantSnapshot['organization']; stores: RestaurantStore[] } }>(withAccount('/api/restaurant-test/stores', accountId)),
  storeContext: (accountId: string) => fetchApi<{ success: true; data: { selectedStore: { id: string; name: string } | null } }>(withAccount('/api/restaurant-test/store-context', accountId)),
  selectStore: (accountId: string, storeId: string) => fetchApi<{ success: true; data: { selectedStore: { id: string; name: string } } }>(withAccount(`/api/restaurant-test/stores/${storeId}/select`, accountId), { method: 'POST', body: '{}' }),
  clearStoreSelection: (accountId: string) => fetchApi<{ success: true; data: { selectedStore: null } }>(withAccount('/api/restaurant-test/stores/selection/clear', accountId), { method: 'POST', body: '{}' }),
  connectStore: (accountId: string | null, body: { name: string; alias: string; channelId: string; channelSecret: string }) => fetchApi<{ success: true; data: { store: { id: string; name: string }; lineAccountName: string } }>(withOptionalAccount('/api/restaurant-test/stores/connect', accountId), { method: 'POST', body: JSON.stringify(body) }),
  termsAgreement: (accountId: string | null) => fetchApi<{ success: true; data: RestaurantTermsAgreement }>(withOptionalAccount('/api/restaurant-test/terms-agreement', accountId)),
  agreeToTerms: (accountId: string | null, documentKey: string, version: string) => fetchApi<{ success: true; data: RestaurantTermsAgreement }>(withOptionalAccount('/api/restaurant-test/terms-agreement', accountId), { method: 'POST', body: JSON.stringify({ documentKey, version }) }),
  setupProgress: (accountId: string, storeId: string) => fetchApi<{ success: true; data: import('@line-crm/shared').RestaurantSetupProgress }>(withAccount(`/api/restaurant-test/setup-progress?storeId=${encodeURIComponent(storeId)}`, accountId)),
  snapshot: (accountId: string, query?: ReservationQuery) => {
    const params = new URLSearchParams();
    if (query?.from) params.set('reservationFrom', query.from);
    if (query?.to) params.set('reservationTo', query.to);
    if (query?.status) params.set('reservationStatus', query.status);
    if (query?.limit) params.set('reservationLimit', String(query.limit));
    if (query?.offset) params.set('reservationOffset', String(query.offset));
    const suffix = params.size ? `&${params.toString()}` : '';
    return fetchApi<{ success: true; data: RestaurantSnapshot }>(`${withAccount('/api/restaurant-test/snapshot', accountId)}${suffix}`);
  },
  createStore: (accountId: string, body: { name: string; code: string; area: string; capacity: number; timezone: string; lineAccountId: string }) => fetchApi<{ success: true; data: { id: string } }>(withAccount('/api/restaurant-test/stores', accountId), { method: 'POST', body: JSON.stringify(body) }),
  updateStore: (accountId: string, id: string, body: { name: string; code: string; area: string; capacity: number; status: RestaurantStore['status']; lineAccountId: string }) => fetchApi<{ success: true; data: { id: string } }>(withAccount(`/api/restaurant-test/stores/${id}`, accountId), { method: 'PATCH', body: JSON.stringify(body) }),
  listIntakeAddresses: (accountId: string, storeId: string) => fetchApi<{ success: true; data: RestaurantIntakeAddress[] }>(withAccount(`/api/restaurant-test/intake-addresses?storeId=${encodeURIComponent(storeId)}`, accountId)),
  issueIntakeAddress: (accountId: string, storeId: string) => fetchApi<{ success: true; data: { id: string; storeId: string; localPart: string; address: string; graceDays: number } }>(withAccount('/api/restaurant-test/intake-addresses', accountId), { method: 'POST', body: JSON.stringify({ storeId }) }),
  decideApproval: (accountId: string, id: string, action: 'approve' | 'return', comment?: string) => fetchApi<{ success: true; data: RestaurantApprovalDecision }>(withAccount(`/api/restaurant-test/approvals/${id}`, accountId), { method: 'PATCH', body: JSON.stringify({ action, comment }) }),
  createReservation: (accountId: string, body: Record<string, unknown>) => fetchApi<{ success: true; data: { id: string; tableId: string | null; lineNotice: { sent: boolean; reason: string | null } } }>(withAccount('/api/restaurant-test/reservations/manual', accountId), { method: 'POST', body: JSON.stringify(body) }),
  updateReservation: (accountId: string, id: string, body: Record<string, unknown>) => fetchApi(withAccount(`/api/restaurant-test/reservations/${id}`, accountId), { method: 'PATCH', body: JSON.stringify(body) }),
  stopTable: (accountId: string, id: string, body: { storeId: string; expectedTableRevision: number; asOf: string; reservations: Array<{ id: string; expectedRevision: number; targetTableId: string | null }> }) => fetchApi(withAccount(`/api/restaurant-test/tables/${id}/stop`, accountId), { method: 'POST', body: JSON.stringify(body) }),
  attendance:(accountId:string,id:string,body:{action:'visited'|'depart'|'undo_departure'|'undo_visit'|'no_show';expectedVersion:number;requestId:string})=>fetchApi<{success:true;data:{stamp:{status:string;count:number}}}>(withAccount(`/api/restaurant-test/reservations/${encodeURIComponent(id)}/attendance`,accountId),{method:'POST',body:JSON.stringify(body)}),
  rotation:(accountId:string,storeId:string,date:string)=>fetchApi<{success:true;data:RestaurantRotation}>(withAccount(`/api/restaurant-test/rotation?storeId=${encodeURIComponent(storeId)}&date=${encodeURIComponent(date)}`,accountId)),
  /** 席の来店の印（booking-plus 6 の席対応）。 */
  postSeatVisitMark: (accountId: string, id: string, body: { kind: 'visited' | 'late' | 'no_show'; lateMinutes?: number;expectedVersion:number;requestId:string }) =>
    fetchApi<{ success: true; data: { stamp?:{status:string;count:number};status: string; visit_mark: SeatVisitMark } }>(
      withAccount(`/api/restaurant-test/reservations/${id}/visit`, accountId),
      { method: 'POST', body: JSON.stringify(body) },
    ),
  /** 席の来店の印を取り消す（元に戻す）。 */
  deleteSeatVisitMark: (accountId: string, id: string,expectedVersion:number,requestId:string) =>
    fetchApi<{ success: true; data: { status: string } }>(
      withAccount(`/api/restaurant-test/reservations/${id}/visit?expectedVersion=${expectedVersion}&requestId=${encodeURIComponent(requestId)}`, accountId),
      { method: 'DELETE' },
    ),
  /** 席の空き待ちの一覧。 */
  listSeatWaitlist: (accountId: string, params: { storeId: string; startsAt?: string; status?: string }) => {
    const query = new URLSearchParams({ storeId: params.storeId })
    if (params.startsAt) query.set('startsAt', params.startsAt)
    if (params.status) query.set('status', params.status)
    return fetchApi<{ success: true; data: { waitlist: SeatWaitlistEntry[] } }>(
      withAccount(`/api/restaurant-test/seat-waitlist?${query.toString()}`, accountId),
    )
  },
  /** 席の空き待ちを取り消す。 */
  cancelSeatWaitlist: (accountId: string, id: string, expectedConfirmationRevision?: number) =>
    fetchApi<{ success: true; data: { status: string } }>(
      withAccount(`/api/restaurant-test/seat-waitlist/${id}${expectedConfirmationRevision === undefined ? '' : `?expectedConfirmationRevision=${expectedConfirmationRevision}`}`, accountId),
      { method: 'DELETE' },
    ),
  importReservation: (accountId: string, body: Record<string, unknown>) => fetchApi(withAccount('/api/restaurant-test/inbound/reservations', accountId), { method: 'POST', body: JSON.stringify(body) }),
  saveTableLayout: (accountId: string, body: RestaurantTableLayoutInput) => fetchApi<{ success: true; data: { tables: RestaurantTablePosition[] } }>(withAccount('/api/restaurant-test/tables/layout', accountId), { method: 'PUT', body: JSON.stringify(body) }),
  createTable: (accountId: string, body: Record<string, unknown>) => fetchApi(withAccount('/api/restaurant-test/tables', accountId), { method: 'POST', body: JSON.stringify(body) }),
  deleteTable: (accountId: string, id: string) => fetchApi(withAccount(`/api/restaurant-test/tables/${encodeURIComponent(id)}`, accountId), { method: 'DELETE' }),
  updateTable: (accountId: string, id: string, body: Record<string, unknown>) => fetchApi(withAccount(`/api/restaurant-test/tables/${encodeURIComponent(id)}`, accountId), { method: 'PATCH', body: JSON.stringify(body) }),
  createMembership: (accountId: string, body: Record<string, unknown>) => fetchApi(withAccount('/api/restaurant-test/memberships', accountId), { method: 'POST', body: JSON.stringify(body) }),
  updateMembership: (accountId: string, id: string, body: Record<string, unknown>, stepUpToken?: string) => fetchApi(withAccount(`/api/restaurant-test/memberships/${encodeURIComponent(id)}`, accountId), { method: 'PATCH', headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined, body: JSON.stringify(body) }),
  updateInventory: (accountId: string, id: string, body: Record<string, unknown>) => fetchApi(withAccount(`/api/restaurant-test/inventory/${id}`, accountId), { method: 'PUT', body: JSON.stringify(body) }),
  createMenu: (accountId: string, body: Record<string, unknown>) => fetchApi(withAccount('/api/restaurant-test/menu', accountId), { method: 'POST', body: JSON.stringify(body) }),
  updateMenu: (accountId: string, id: string, body: Record<string, unknown>) => fetchApi<{success:true;data:RestaurantMenuChangeResult}>(withAccount(`/api/restaurant-test/menu/${encodeURIComponent(id)}`, accountId), { method: 'PATCH', body: JSON.stringify(body) }),
  createGbpPost: (accountId: string, body: Record<string, unknown>) => fetchApi(withAccount('/api/restaurant-test/gbp/posts', accountId), { method: 'POST', body: JSON.stringify(body) }),
  updateReviewDraft: (accountId: string, id: string, replyDraft: string) => fetchApi(withAccount(`/api/restaurant-test/gbp/reviews/${id}/draft`, accountId), { method: 'PUT', body: JSON.stringify({ replyDraft }) }),
  updateLineFlow: (accountId: string, id: string, body: Record<string, unknown>) => fetchApi(withAccount(`/api/restaurant-test/line-flows/${id}`, accountId), { method: 'PUT', body: JSON.stringify(body) }),
}
