/** 明示した列とキーだけを保持する。定義のない列は空のオブジェクトにする。 */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  'booking_groups.request_json': ['amount', 'count', 'kind', 'createdAt', 'startsAt', 'endsAt'],
  'booking_series.request_json': ['amount', 'count', 'kind', 'createdAt', 'startsAt', 'endsAt'],
  'booking_series.rule_json': ['count', 'interval', 'frequency', 'until', 'startsAt', 'endsAt'],
  'booking_makeup_credits.rule_snapshot_json': ['enabled', 'cutoffHours', 'validDays', 'monthlyCap', 'target', 'targetIds'],
  'events.makeup_rule_json': ['enabled', 'cutoffHours', 'validDays', 'monthlyCap', 'target', 'targetIds'],
  'friend_bulk_runs.selection_json': ['count'],
  'friend_bulk_runs.operation_json': ['kind', 'type', 'count'],
  'conversion_points.source_config_json': [],
  'staff_members.notification_preferences': [],
  'common_action_versions.action_config': ['id', 'type'],
  'event_versions.snapshot_json': ['id', 'eventId', 'version', 'kind', 'startsAt', 'endsAt', 'capacity'],
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function clean(value: JsonValue, allowed: ReadonlySet<string>): JsonValue {
  if (Array.isArray(value)) return value.map(item => clean(item, allowed));
  if (value === null || typeof value !== 'object') return value;
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [key, child] of Object.entries(value)) {
    if (allowed.has(key)) result[key] = clean(child, allowed);
  }
  return result;
}

export function redactRetainedJson(input: string, column: string): string {
  const value = JSON.parse(input) as JsonValue;
  if (column === 'common_action_versions.action_config') {
    if (!Array.isArray(value)) throw new Error('invalid_tombstone_action_config');
    return JSON.stringify(value.map(item => {
      if (item === null || Array.isArray(item) || typeof item !== 'object') throw new Error('invalid_tombstone_action_config');
      return {id:typeof item.id === 'string' ? item.id : null,type:typeof item.type === 'string' ? item.type : null};
    }));
  }
  if (!(column in ALLOWED) || value === null || typeof value !== 'object') return '{}';
  return JSON.stringify(clean(value, new Set(ALLOWED[column])));
}
