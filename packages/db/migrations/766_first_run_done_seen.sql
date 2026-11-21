ALTER TABLE account_styles ADD COLUMN first_run_done_seen_at TEXT;

UPDATE account_styles
   SET first_run_done_seen_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
 WHERE EXISTS (
   SELECT 1 FROM messages_log
    WHERE line_account_id = account_styles.line_account_id
      AND direction = 'outgoing'
      AND (source = 'friend_add_routing' OR scenario_step_id IS NOT NULL)
 );
