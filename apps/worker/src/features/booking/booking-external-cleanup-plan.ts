/**
 * 外部後片づけに渡すのは相手先を照合するための最小限の情報だけ。
 * この値には外部IDが含まれるため、永続化する前に必ず暗号化する。
 */
export type CleanupPlanItem = {
  provider: 'google_calendar' | 'google_meet' | 'zoom' | 'teams' | 'outlook';
  action: 'delete' | 'redact' | 'review';
  staffId: string;
  remoteId?: string;
  calendarId?: string;
  connectionId?: string;
  externalAccountId?: string;
  transactionId?: string;
  marker?: string;
  testRecipientProof?: string;
  uncertainty?: 'create'|'delete';
  startsAt?: string;
};
type Row = Record<string, unknown>;
const value = (x: unknown): string | undefined => typeof x === 'string' && x.length ? x : undefined;
function object(x: unknown): Row {
  if (typeof x === 'string') { try { return object(JSON.parse(x)); } catch { return {}; } }
  return x && typeof x === 'object' && !Array.isArray(x) ? x as Row : {};
}

/** 必要な列だけ選ぶ。顧客・予約の内容・会議 URL は出力しない。 */
export function planExternalCleanup(input: { booking: Row; meetings: Row[]; workflows: Row[]; now: number; calendarStaff?: Record<string, string> }): CleanupPlanItem[] {
  const { booking, meetings, workflows, now } = input;
  const staff = value(booking.staff_id) ?? '';
  const items: CleanupPlanItem[] = [];
  // `primary` などは接続ごとに別カレンダーを指すため、接続も一致しない限り同一予定と決めない。
  const sameGoogle = (item:CleanupPlanItem,id?:string,calendar?:string,connection?:string) => !!id && !!calendar && !!connection && item.provider==='google_calendar' && item.remoteId===id && item.calendarId===calendar && item.connectionId===connection;
  const calendarId = value(booking.external_calendar_id);
  const eventId = value(booking.external_event_id);
  const matchingRow = workflows.find(row => {const snapshot=object(object(row.input_json).snapshot);return row.process_kind==='booking_calendar_create' && value(object(snapshot.event).id)===eventId && value(snapshot.calendarId)===calendarId;});
  const match = object(object(matchingRow?.input_json).snapshot);
  const connectionId = value(match?.connectionId);
  const googleOwner = (connection?:string) => input.calendarStaff ? (connection && input.calendarStaff[connection]) || '' : staff;
  const calendarStart = Date.parse(value(object(match?.event).start) ?? '');
  if (eventId) items.push({provider:'google_calendar',action:matchingRow?.status!=='succeeded'||!Number.isFinite(calendarStart)||!googleOwner(connectionId)||!calendarId||!connectionId?'review':calendarStart>now?'delete':'redact',staffId:googleOwner(connectionId),remoteId:eventId,...(Number.isFinite(calendarStart)?{startsAt:new Date(calendarStart).toISOString()}:{}),...(calendarId?{calendarId}:{}),...(connectionId?{connectionId}:{}),...(['running','unknown'].includes(String(matchingRow?.status))?{uncertainty:'create' as const}:{})});
  for (const row of meetings) {
    if (!['active','pending','cancel_pending','failed'].includes(String(row.status))) continue;
    if ((row.status === 'pending' && row.attempt_count === 0 || row.status === 'failed') && !value(row.external_meeting_id)) continue;
    const meetingStart = Date.parse(value(row.starts_at) ?? '');
    if (Number.isFinite(meetingStart) && meetingStart <= now) continue;
    const provider = row.provider;
    if (provider !== 'google_meet' && provider !== 'zoom' && provider !== 'teams') continue;
    const remoteId = value(row.external_meeting_id), marker = value(row.idempotency_key);
    const meetingStaff=value(row.staff_id) ?? staff;
    const uncertain=row.status==='pending'||['delete_started','delete_unknown'].includes(String(row.last_error_code));
    items.push({provider,action:!uncertain && remoteId && meetingStaff && Number.isFinite(meetingStart)?'delete':'review',staffId:meetingStaff,...(Number.isFinite(meetingStart)?{startsAt:new Date(meetingStart).toISOString()}:{}),...(remoteId?{remoteId}:{}),...(!remoteId&&marker?{marker}:{}),...(uncertain?{uncertainty:row.status==='pending'?'create' as const:'delete' as const}:{})});
  }
  for (const row of workflows) {
    if (row.process_kind === 'booking_calendar_delete' && (['running','unknown','failed','exhausted'].includes(String(row.status)) || (row.status==='pending' && Number(row.attempt_count)>0))) {
      const stored=object(row.input_json), snap=object(stored.snapshot), scope=object(object(stored.identity).scope);
      const id=value(snap.eventId),calendar=value(snap.calendarId),connection=value(scope.connectionId);
      const source=id&&calendar&&connection?workflows.filter(step=>step.process_kind==='booking_calendar_create').map(step=>object(object(step.input_json).snapshot)).find(snapshot=>value(object(snapshot.event).id)===id&&value(snapshot.calendarId)===calendar&&value(snapshot.connectionId)===connection):undefined;
      const eventStart=Date.parse(value(object(source?.event).start)??'');
      const existing=items.find(item=>sameGoogle(item,id,calendar,connection));
      if(existing) { existing.action='review'; existing.uncertainty='delete'; }
      else items.push({provider:'google_calendar',action:'review',staffId:googleOwner(connection),uncertainty:'delete',...(Number.isFinite(eventStart)?{startsAt:new Date(eventStart).toISOString()}:{}),...(id?{remoteId:id}:{}),...(calendar?{calendarId:calendar}:{}),...(connection?{connectionId:connection}:{})});
    }
    if (row.process_kind === 'booking_calendar_create' && ['running','unknown'].includes(String(row.status))) {
      const snap = object(object(row.input_json).snapshot), event = object(snap.event);
      const id = value(event.id), calendar = value(snap.calendarId), connection = value(snap.connectionId);
      const eventStart=Date.parse(value(event.start)??'');
      if (!items.some(item => sameGoogle(item,id,calendar,connection)))
        items.push({provider:'google_calendar',action:'review',staffId:googleOwner(connection),uncertainty:'create',...(Number.isFinite(eventStart)?{startsAt:new Date(eventStart).toISOString()}:{}),...(id?{remoteId:id}:{}),...(calendar?{calendarId:calendar}:{}),...(connection?{connectionId:connection}:{})});
    }
    if (row.process_kind !== 'booking_outlook_sync') continue;
    const result = object(row.result_json), saved = object(row.input_json);
    const eventStart = Date.parse(value(result.startsAt) ?? value(object(saved.booking).starts_at) ?? '');
    if (Number.isFinite(eventStart) && eventStart <= now) continue;
    const id = value(result.eventId), owner = value(result.accountId) ?? value(saved.accountId), transaction = value(saved.transactionId);
    if (!id && !transaction && row.status !== 'running' && row.status !== 'unknown') continue;
    const eventStaff=value(result.staffId) ?? value(object(saved.booking).staff_id) ?? staff;
    items.push({provider:'outlook',action:id && owner && eventStaff && Number.isFinite(eventStart)?'delete':'review',staffId:eventStaff,...(Number.isFinite(eventStart)?{startsAt:new Date(eventStart).toISOString()}:{}),...(id?{remoteId:id}:{}),...(owner?{externalAccountId:owner}:{}),...(!id&&transaction?{transactionId:transaction}:{})});
  }
  // 現在の予約から外れた旧版も、外部に名前入りの予定が残っている可能性がある。
  for (const row of workflows.filter(row=>row.process_kind==='booking_calendar_create' && row.status==='succeeded')) {
    const snap=object(object(row.input_json).snapshot), event=object(snap.event);
    const id=value(event.id), calendar=value(snap.calendarId), connection=value(snap.connectionId), eventStart=Date.parse(value(event.start)??'');
    if (items.some(item=>sameGoogle(item,id,calendar,connection))) continue;
    const deleted=id && calendar && connection && workflows.some(step=>{const stored=object(step.input_json),saved=object(stored.snapshot),scope=object(object(stored.identity).scope);return step.process_kind==='booking_calendar_delete' && step.status==='succeeded' && value(saved.eventId)===id && value(saved.calendarId)===calendar && value(scope.connectionId)===connection;});
    const eventStaff=googleOwner(connection);
    // 旧削除の成功は 404 の照合でも記録されるため、アクセス権喪失と区別できない。
    items.push({provider:'google_calendar',action:deleted?'review':id && calendar && connection && eventStaff && Number.isFinite(eventStart)?eventStart>now?'delete':'redact':'review',staffId:eventStaff,...(deleted?{uncertainty:'delete' as const}:{}),...(Number.isFinite(eventStart)?{startsAt:new Date(eventStart).toISOString()}:{}),...(id?{remoteId:id}:{}),...(calendar?{calendarId:calendar}:{}),...(connection?{connectionId:connection}:{})});
  }
  return items;
}
