-- 顧客削除の受付後に同じ工程から外部送信を開始しないための印。
ALTER TABLE workflow_steps ADD COLUMN customer_redaction_requested_at INTEGER;

CREATE INDEX workflow_steps_customer_redaction_due ON workflow_steps(customer_redaction_requested_at) WHERE customer_redaction_requested_at IS NOT NULL;
CREATE INDEX workflow_customer_deletion_digest ON operation_audit(target_kind, json_extract(CASE WHEN json_valid(detail_json) THEN detail_json ELSE '{}' END,'$.recipientDigest'));
CREATE INDEX workflow_customer_deletion_friend ON operation_audit(target_kind,friend_id,action);

CREATE TRIGGER workflow_steps_no_deleted_customer_claim
BEFORE UPDATE ON workflow_steps
WHEN NEW.status='running' AND NEW.customer_redaction_requested_at IS NULL
  AND (OLD.status<>'running' OR NEW.lease_owner IS NOT OLD.lease_owner)
  AND OLD.error_code IS NOT 'delivery_started' AND NEW.process_kind='tracked_click'
  AND EXISTS (SELECT 1 FROM workflow_steps root JOIN operation_audit audit
    ON audit.target_kind='customer_deletion' AND audit.action<>'deleted'
      AND audit.id='customer-delete:friend_data:' || audit.friend_id
      AND json_extract(CASE WHEN json_valid(root.input_json) THEN root.input_json ELSE '{}' END,'$.friendId')=audit.friend_id
    WHERE root.scope_id=NEW.scope_id AND root.process_kind=NEW.process_kind AND root.subject_id=NEW.subject_id AND root.step_key='__run'
      AND NEW.scope_id='line:' || json_extract(audit.detail_json,'$.accountId'))
BEGIN SELECT RAISE(ABORT, 'workflow_customer_redaction_pending'); END;

CREATE TRIGGER workflow_steps_no_redacted_start
BEFORE UPDATE ON workflow_steps
WHEN OLD.customer_redaction_requested_at IS NOT NULL AND (
  (NEW.status = 'running' AND (OLD.status <> 'running' OR NEW.lease_owner IS NOT OLD.lease_owner)) OR
  (NEW.status = 'running' AND NEW.error_code = 'delivery_started' AND OLD.error_code IS NOT 'delivery_started') OR
  (OLD.status <> 'unknown' AND NEW.status = 'unknown' AND
    CASE WHEN json_valid(NEW.result_json) THEN json_extract(NEW.result_json, '$.callState.phase') ELSE NULL END = 'started')
)
BEGIN SELECT RAISE(ABORT, 'workflow_customer_redaction_pending'); END;

CREATE TRIGGER workflow_steps_no_deleted_customer_insert
BEFORE INSERT ON workflow_steps
WHEN EXISTS (
  SELECT 1 FROM operation_audit audit WHERE audit.target_kind='customer_deletion'
    AND audit.id='customer-delete:friend_data:' || audit.friend_id
    AND audit.friend_id IN (
      SELECT CASE WHEN NEW.scope_id LIKE 'friend:%' THEN substr(NEW.scope_id,8) END
      UNION SELECT json_extract(CASE WHEN json_valid(NEW.input_json) THEN NEW.input_json ELSE '{}' END,'$.friendId')
      UNION SELECT json_extract(CASE WHEN json_valid(NEW.input_json) THEN NEW.input_json ELSE '{}' END,'$.snapshot.friendId')
      UNION SELECT f.id FROM friends f WHERE NEW.scope_id='line:' || f.line_account_id AND f.line_user_id IS NOT NULL AND f.line_user_id<>''
        AND f.line_user_id IN (
          json_extract(CASE WHEN json_valid(NEW.input_json) THEN NEW.input_json ELSE '{}' END,'$.to'),
          json_extract(CASE WHEN json_valid(NEW.input_json) THEN NEW.input_json ELSE '{}' END,'$.snapshot.to'),
          json_extract(CASE WHEN json_valid(NEW.input_json) THEN NEW.input_json ELSE '{}' END,'$.toLineUserId'))
    )
    AND (
      NEW.scope_id='friend:' || audit.friend_id OR
      (NEW.scope_id='line:' || json_extract(audit.detail_json,'$.accountId') AND (
        json_extract(CASE WHEN json_valid(NEW.input_json) THEN NEW.input_json ELSE '{}' END,'$.friendId')=audit.friend_id OR
        json_extract(CASE WHEN json_valid(NEW.input_json) THEN NEW.input_json ELSE '{}' END,'$.snapshot.friendId')=audit.friend_id OR
        EXISTS (SELECT 1 FROM friends f WHERE f.id=audit.friend_id AND f.line_account_id=json_extract(audit.detail_json,'$.accountId')
          AND f.line_user_id IS NOT NULL AND f.line_user_id<>'' AND f.line_user_id IN (
            json_extract(CASE WHEN json_valid(NEW.input_json) THEN NEW.input_json ELSE '{}' END,'$.to'),
            json_extract(CASE WHEN json_valid(NEW.input_json) THEN NEW.input_json ELSE '{}' END,'$.snapshot.to'),
            json_extract(CASE WHEN json_valid(NEW.input_json) THEN NEW.input_json ELSE '{}' END,'$.toLineUserId')
          ))
      ))
    )
)
BEGIN SELECT RAISE(ABORT, 'workflow_customer_redaction_pending'); END;

CREATE TRIGGER workflow_steps_no_redacted_child
BEFORE INSERT ON workflow_steps
WHEN NEW.step_key <> '__run' AND EXISTS (
  SELECT 1 FROM workflow_steps root WHERE root.scope_id = NEW.scope_id
    AND root.process_kind = NEW.process_kind AND root.subject_id = NEW.subject_id
    AND root.customer_redaction_requested_at IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'workflow_customer_redaction_pending'); END;

CREATE TRIGGER workflow_steps_keep_redaction_request
BEFORE UPDATE ON workflow_steps
WHEN OLD.customer_redaction_requested_at IS NOT NULL AND NEW.customer_redaction_requested_at IS NULL
BEGIN SELECT RAISE(ABORT, 'workflow_customer_redaction_pending'); END;
