


/**
 * 内容比較用の正規形。版の正体（version_step_id）は同一性の判断から外す。
 * 版IDが決まる前に作った下書きの写しと、保存済みの版の写しを同じ形で
 * 比べられる。live_step_id・created_at は残す（通の差し替えは別内容）。
 */
export function normalizeVersionStepSnapshot(
  entry: Record<string, unknown>,
): Record<string, unknown> {
  return {
    step_order: entry['step_order'] ?? null,
    delay_minutes: entry['delay_minutes'] ?? 0,
    message_type: entry['message_type'] ?? 'text',
    message_content: entry['message_content'] ?? '',
    ...(entry['message_bubbles_json'] ? { message_bubbles_json: entry['message_bubbles_json'] } : {}),
    condition_type: entry['condition_type'] ?? null,
    condition_value: entry['condition_value'] ?? null,
    next_step_on_false: entry['next_step_on_false'] ?? null,
    offset_days: entry['offset_days'] ?? null,
    offset_minutes: entry['offset_minutes'] ?? null,
    delivery_time: entry['delivery_time'] ?? null,
    template_id: entry['template_id'] ?? null,
    template_id_at_send: entry['template_id_at_send'] ?? null,
    on_reach_tag_id: entry['on_reach_tag_id'] ?? null,
    after_send: entry['after_send'] ?? 'continue',
    target_condition_json: entry['target_condition_json'] ?? null,
    question_json: entry['question_json'] ?? null,
    is_draft: entry['is_draft'] ?? 0,
    ...(entry['common_var_pins'] ? { common_var_pins: entry['common_var_pins'] } : {}),
    live_step_id: entry['live_step_id'] ?? null,
    created_at: entry['created_at'] ?? null,
  };
}
