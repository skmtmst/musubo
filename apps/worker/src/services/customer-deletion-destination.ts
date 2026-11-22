/** 保存するのはアカウントと高エントロピーな LINE ID の照合用ダイジェストだけ。 */
export async function customerDestinationDigest(accountId:string,to:string):Promise<string> {
  const bytes=new TextEncoder().encode(JSON.stringify([accountId,to]));
  const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  return Array.from(hash,byte=>byte.toString(16).padStart(2,'0')).join('');
}

export const noCustomerDeletionForDigest = `NOT EXISTS (SELECT 1 FROM operation_audit audit
  WHERE audit.target_kind='customer_deletion' AND audit.id LIKE 'customer-delete:friend_data:%'
    AND json_extract(CASE WHEN json_valid(audit.detail_json) THEN audit.detail_json ELSE '{}' END,'$.recipientDigest')=?
    AND (audit.action<>'deleted' OR NOT EXISTS (SELECT 1 FROM friends f
      WHERE f.line_account_id=? AND f.line_user_id=? AND f.id<>audit.friend_id)))`;

export async function customerDestinationBlocked(db:D1Database,digest:string,accountId:string,to:string):Promise<boolean> {
  return !(await db.prepare(`SELECT ${noCustomerDeletionForDigest} AS allowed`).bind(digest,accountId,to).first<{allowed:number}>())?.allowed;
}
