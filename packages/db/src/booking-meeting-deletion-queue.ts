/** 削除される接続の暗号文だけを、削除と同じ D1 batch で一時的な後片づけ台帳へ移す。 */
export function queueDeletedMeetingConnections(db:D1Database,input:{whereSql:string;params:unknown[];source:'staff'|'account'|'tenant';now?:number}):D1PreparedStatement {
 const now=input.now??Date.now();
 return db.prepare(`INSERT INTO workflow_steps(scope_id,process_kind,subject_id,step_key,status,retry_key,input_json,created_at,updated_at)
  SELECT 'global:meeting-revoke-queue','booking_meeting_deleted_revoke',c.id,'current','pending',c.id,
   json_object('accountId',c.line_account_id,'staffId',c.staff_id,'provider',c.provider,'connectionId',c.id,
    'credentialEnc',CASE WHEN c.provider IN ('google_meet','zoom') AND c.refresh_state='ready' THEN c.credential_enc ELSE NULL END,
    'tenantId',a.tenant_id,'source',?,'needsManual',CASE WHEN c.provider IN ('teams','outlook') OR c.refresh_state<>'ready' THEN 1 ELSE 0 END),?,?
  FROM booking_meeting_connections c JOIN line_accounts a ON a.id=c.line_account_id WHERE ${input.whereSql}
  ON CONFLICT(scope_id,process_kind,subject_id,step_key) DO NOTHING`)
  .bind(input.source,now,now,...input.params);
}

/** 所有者不明のカレンダー認可は取り消さず、秘密を消して手動確認する。 */
export function queueDeletedGoogleCalendars(db:D1Database,input:{whereSql:string;params:unknown[];source:'staff'|'account'|'tenant';now?:number}):D1PreparedStatement {
 const now=input.now??Date.now();
 return db.prepare(`INSERT INTO workflow_steps(scope_id,process_kind,subject_id,step_key,status,retry_key,input_json,created_at,updated_at)
  SELECT 'global:meeting-revoke-queue','booking_meeting_deleted_revoke','calendar:'||c.id||':'||lower(hex(randomblob(16))),'current','pending','calendar:'||c.id,
   json_object('accountId',c.line_account_id,'staffId',COALESCE(c.staff_id,''),'provider','google_calendar','connectionId','calendar:'||c.id,
    'credentialEnc',NULL,'tenantId',a.tenant_id,'source',?,'needsManual',1,'authType',c.auth_type),?,?
  FROM google_calendar_connections c JOIN line_accounts a ON a.id=c.line_account_id
  WHERE (c.is_active=1 OR c.access_token IS NOT NULL OR c.refresh_token IS NOT NULL OR c.api_key IS NOT NULL) AND ${input.whereSql}
  ON CONFLICT(scope_id,process_kind,subject_id,step_key) DO NOTHING`)
  .bind(input.source,now,now,...input.params);
}
