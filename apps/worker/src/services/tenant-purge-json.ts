/** 明示した列とキーだけを保持する。定義のない列は空のオブジェクトにする。 */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  'bookings.notification_policy_snapshot': [],
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
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const TERMS = new Set(['send_message','set_friend_fields','run_common_action','add_tag','remove_tag','explicit','segment',
  'tag','friend_field','support_mark','scenario','common_var','send_template','reminder','event_booking','notify_staff',
  'start_scenario','same_kind','list','daily','weekly','monthly','manual','purchase']);
const NUMERIC = new Set(['amount','count','interval','cutoffHours','validDays','monthlyCap','version','capacity']);
const DATES = new Set(['createdAt','startsAt','endsAt','until']);
const IDS = new Set(['id','eventId']);
const WORDS = new Set(['kind','type','frequency','target']);

function scalar(key:string, value:JsonValue):JsonValue|undefined {
  if (NUMERIC.has(key)) return typeof value==='number' && Number.isSafeInteger(value) && value>=0 ? value : undefined;
  if (key==='enabled') return typeof value==='boolean' ? value : undefined;
  if (DATES.has(key)) return typeof value==='string' && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;
  if (IDS.has(key)) return typeof value==='string' && ID.test(value) ? value : undefined;
  if (WORDS.has(key)) return typeof value==='string' && TERMS.has(value) ? value : undefined;
  if (key==='targetIds' && Array.isArray(value)) return [];
  return undefined;
}

function clean(value:JsonValue, allowed:ReadonlySet<string>):JsonValue|undefined {
  if (Array.isArray(value)) return value.filter(item=>item!==null && typeof item==='object' && !Array.isArray(item)).map(item=>clean(item,allowed) ?? {});
  if (value===null || typeof value!=='object') return undefined;
  const result:Record<string,JsonValue>=Object.create(null) as Record<string,JsonValue>;
  for (const [key, child] of Object.entries(value)) {
    if (!allowed.has(key)) continue;
    const safe=scalar(key,child);
    if (safe!==undefined) result[key]=safe;
  }
  return result;
}

export function redactRetainedJson(input:string,column:string):string {
  const value=JSON.parse(input) as JsonValue;
  if (column==='common_action_versions.action_config') {
    if (!Array.isArray(value)) throw new Error('invalid_tombstone_action_config');
    return JSON.stringify(value.filter(item=>item!==null && typeof item==='object' && !Array.isArray(item)).map(item=>{
      const action=item as Record<string,JsonValue>;
      return {id:scalar('id',action.id) ?? null,type:scalar('type',action.type) ?? null};
    }));
  }
  if (!(column in ALLOWED)) return '{}';
  return JSON.stringify(clean(value,new Set(ALLOWED[column])) ?? {});
}
