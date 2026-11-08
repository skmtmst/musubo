const resource = { type: 'object', required: ['resourceId', 'priority', 'dailyLimit', 'sortOrder'], properties: {
  resourceId: { type: 'string' }, priority: { type: 'string', enum: ['preferred', 'normal', 'low'] },
  dailyLimit: { type: ['integer', 'null'], minimum: 1 }, sortOrder: { type: 'integer', minimum: 0 },
} };
const properties = { method: { type: 'string', enum: ['balanced', 'priority', 'random'] },
  balancePeriod: { type: 'string', enum: ['day', 'week'], description: '週は店舗時間の月曜から日曜' }, resources: { type: 'array', maxItems: 1000, items: resource } };
const result = { type: 'object', properties: { success: { const: true }, data: { type: 'object', properties: {
  ...properties, version: { type: 'integer', minimum: 0 }, storageReady: { type: 'boolean' },
  effectiveMethod: { type: 'string', enum: ['balanced', 'priority', 'random', 'legacy_first'] },
} } } };
function path(tables = false) {
  const parameters = [{ name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
    ...(tables ? [{ name: 'storeId', in: 'query', required: true, schema: { type: 'string' } }] : [])];
  const responses = { '200': { description: '設定と保存先の準備状態。未移行はlegacy_first', content: { 'application/json': { schema: result } } },
    '400': { description: '入力が不正（fields）' }, '403': { description: '担当外・権限不足' }, '404': { description: '店舗なし・範囲外' },
    '503': { description: 'DB障害。保存時assignment_storage_not_readyはマイグレーション承認待ち' } };
  return {
    get: { tags: ['Booking'], summary: tables ? '卓の割り当て設定を読む' : '担当者の割り当て設定を読む', parameters, responses },
    put: { tags: ['Booking'], summary: '割り当て方・優先度・上限・順序をまとめて保存', description: '予約設定と同じbooking.settings編集権限。resourcesは全置換、省略した人・卓は通常/無制限/順序0。未移行は保存不可。', parameters,
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['method', 'balancePeriod', 'resources', 'expectedVersion'],
        properties: { ...properties, expectedVersion: { type: 'integer', minimum: 0 } } } } } },
      responses: { ...responses, '409': { description: 'version_conflict（再読込が必要）' } },
    },
  };
}
export const bookingAssignmentPaths = {
  '/api/restaurant-test/table-auto-assignment-settings': {
    get: { tags: ['Booking'], summary: '店舗全体の自動配席のオン・オフを読む', parameters: [{ name: 'account_id', in: 'query', required: true, schema: { type: 'string' } }, { name: 'storeId', in: 'query', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'enabledとversion。未保存はオン・版0' }, '404': { description: '対象外の店舗' }, '503': { description: '設定を取得できない' } } },
    put: { tags: ['Booking'], summary: '店舗全体の自動配席のオン・オフを保存', description: '予約設定の編集権限とexpectedVersionが必要。既存予約の卓は変更しない。オフでも未配席で予約を受け付け、空席検査は継続する。', parameters: [{ name: 'account_id', in: 'query', required: true, schema: { type: 'string' } }, { name: 'storeId', in: 'query', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['enabled', 'expectedVersion'], properties: { enabled: { type: 'boolean' }, expectedVersion: { type: 'integer', minimum: 0 } } } } } }, responses: { '200': { description: '保存したenabledとversion' }, '400': { description: '入力不正' }, '403': { description: '閲覧のみ・権限不足' }, '404': { description: '対象外の店舗' }, '409': { description: '版の競合' }, '503': { description: '設定を保存できない' } } },
  },
  '/api/booking/admin/assignment-settings': path(),
  '/api/restaurant-test/assignment-settings': path(true),
};
