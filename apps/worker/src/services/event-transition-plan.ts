/** 変更先の予約と回復の意図は、同じ batch で確定する。 */
export function replacementEventTransition(db:D1Database,oldId:string,newId:string) {
 return db.prepare(`INSERT INTO event_booking_transition_runs
  (id,line_account_id,event_id,booking_id,booking_id_history,expected_booking_version,booking_version,event_version,
   operation_key,action,input_snapshot,before_json,after_json,created_at,updated_at)
  SELECT ?,b.line_account_id,b.event_id,b.id,b.id,0,b.lock_version,e.current_published_version_id,
    'event-transition:'||b.id||':'||b.lock_version,'change_to',
    json_object('friendId',b.friend_id,'recipient',f.line_platform_user_id,'slotId',b.slot_id,'startsAt',s.starts_at,'status',b.status,
      'eventName',e.name,'venueName',e.venue_name,'venueUrl',e.venue_url),
    json_object('bookingId',?,'slotId',(SELECT slot_id FROM event_bookings WHERE id=?)),
    json_object('bookingId',b.id,'slotId',b.slot_id),strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM event_bookings b JOIN events e ON e.id=b.event_id JOIN event_slots s ON s.id=b.slot_id
  JOIN friends f ON f.id=b.friend_id AND f.line_account_id=b.line_account_id WHERE b.id=?`)
  .bind(crypto.randomUUID(),oldId,oldId,newId);
}
