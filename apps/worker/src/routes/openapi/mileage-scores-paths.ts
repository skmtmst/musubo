// 実行時の副作用を混ぜず定義だけを置き、ハンドラは各機能の経路に保つ。
export const mileageScoresPaths = {
  '/api/mileage/redemptions/{id}/hand-cancel': {
    post: {
      tags: ['Mileage'], summary: '手渡し景品の交換を取り消す',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['accountId', 'expectedStatus'], properties: { expectedStatus: { type: 'string', enum: ['reserved', 'succeeded'] }, accountId: { type: 'string' }, reason: { type: 'string', maxLength: 500 } } } } } },
      responses: { '200': { description: '取消とマイル返却' }, '400': { description: '取消理由が不正' }, '403': { description: '権限がありません' }, '404': { description: 'アカウントが見つかりません' }, '409': { description: '取り消せない交換' } },
    },
  },
  '/api/mileage/redemptions/{id}/hand-delivery': {
    post: {
      tags: ['Mileage'], summary: '手渡し景品を渡した記録を残す',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['accountId'], properties: { accountId: { type: 'string' } } } } } },
      responses: { '200': { description: '手渡しを記録' }, '403': { description: '権限がありません' }, '404': { description: 'アカウントが見つかりません' }, '409': { description: '手渡しできない交換' } },
    },
  },
  '/api/mileage/rules': {
    get: {
      tags: ['Mileage'], summary: 'LINEアカウント範囲内のマイル付与ルールを取得',
      responses: { '200': { description: 'Visible mileage rules' }, '403': { description: 'Staff role required' } },
    },
    post: {
      tags: ['Mileage'], summary: 'LINEアカウントに属するマイル付与ルールを作成',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['lineAccountId', 'name', 'eventType', 'amount'], properties: { lineAccountId: { type: 'string' }, name: { type: 'string' }, eventType: { type: 'string' }, amount: { type: 'integer', minimum: 1 } } } } } },
      responses: { '201': { description: 'Mileage rule created' }, '400': { description: 'LINE account is required' }, '403': { description: 'Owner or admin role or account scope required' } },
    },
  },
  '/api/mileage/rules/export': {
    get: {
      tags: ['Mileage'], summary: '許可範囲内のたまる決めごとをCSVで書き出し（N-237。監査へ記録）',
      parameters: [{ name: 'accountId', in: 'query', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Mileage earning rules CSV' }, '400': { description: 'LINE account is required' }, '403': { description: 'Staff role required' }, '404': { description: 'LINE account not found in account scope' } },
    },
  },
  '/api/mileage/earning-rules/{id}/publish': {
    post: {
      tags: ['Mileage'], summary: 'たまる決めごとの下書きを公開版として固定し実行へ反映（N-231 案1）',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['accountId', 'expectedVersion'], properties: { accountId: { type: 'string' }, expectedVersion: { type: 'integer', minimum: 1 } } } } } },
      responses: { '200': { description: 'Earning rule published' }, '400': { description: 'Confirmation or version required' }, '403': { description: 'Owner or admin role required' }, '404': { description: 'Not found in account scope' }, '409': { description: 'Draft version conflict or concurrent publish' }, '428': { description: 'Irreversible confirmation required' } },
    },
  },
  '/api/mileage/earning-rules-order': {
    put: {
      tags: ['Mileage'], summary: 'たまる決めごとの並び順を全件まとめて保存（N-243。一覧と一致しない並びは拒否）',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['accountId', 'ids'], properties: { accountId: { type: 'string' }, ids: { type: 'array', items: { type: 'string' }, minItems: 1 } } } } } },
      responses: { '200': { description: 'Earning rule order saved' }, '403': { description: 'Owner or admin role required' }, '404': { description: 'LINE account not found in account scope' }, '409': { description: 'Ids do not match the current earning rule list' }, '422': { description: 'Ids are empty, duplicated, or invalid' } },
    },
  },
  '/api/mileage/rules/{id}': {
    put: {
      tags: ['Mileage'], summary: '所属LINEアカウント内のマイル付与ルールを更新（停止・再開のみ。公開内容の直接変更は409）',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Mileage rule updated' }, '403': { description: 'Owner or admin role required' }, '404': { description: 'Not found in account scope' }, '409': { description: 'Legacy global rule is immutable, or direct content edit is closed (N-231)' } },
    },
    delete: {
      tags: ['Mileage'], summary: '所属LINEアカウント内のマイル付与ルールを削除',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Mileage rule deleted' }, '403': { description: 'Owner or admin role required' }, '404': { description: 'Not found in account scope' }, '409': { description: 'Legacy global rule is immutable' } },
    },
  },
  '/api/mileage/redemptions': {
    get: {
      tags: ['Mileage'], summary: '届かなかった特典交換の一覧を取得（既定は要対応：失敗中＋配送中）',
      parameters: [
        { name: 'accountId', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'status', in: 'query', schema: { type: 'string', enum: ['all', 'needs_attention', 'reserved', 'delivering', 'succeeded', 'delivery_failed', 'refunded'] } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
        { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 } },
      ],
      responses: { '200': { description: 'Mileage redemptions with failure reason, attempts, and timestamps' }, '400': { description: 'Status is invalid' }, '403': { description: 'Staff role required' }, '404': { description: 'LINE account not found in account scope' } },
    },
  },
  '/api/mileage/entries/{id}/notification-retry': {
    post: {
      tags: ['Mileage'],
      summary: 'マイル手動調整の友だち通知だけをあとから再送する（残高は動かさない）',
      description: '保存済みの通知記録があればその本文と送信キーで、記録の作成自体が失敗した調整では台帳の依頼印から本文を組み直して送る。送信済みの通知は再送しない。',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object',
        required: ['accountId'],
        properties: { accountId: { type: 'string' } },
      } } } },
      responses: {
        '200': { description: '通知の再送結果（sent/failed/delivery_unknown など）' },
        '400': { description: 'LINEアカウントが未指定' },
        '403': { description: 'owner/adminではない、またはアカウント範囲外' },
        '404': { description: '調整・通知対象が見つからない、または通知を依頼していない調整' },
      },
    },
  },
  // ── Action Scores ────────────────────────────────────────────────────────
  '/api/action-scores/adjustments': {
    post: {
      tags: ['Mileage'], summary: '担当者が理由つきで1人分の行動スコアを手で直す（N-235。追記台帳・確認ヘッダ必須）',
      parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['accountId', 'friendId', 'direction', 'amount', 'reason'], properties: { accountId: { type: 'string' }, friendId: { type: 'string' }, direction: { type: 'string', enum: ['increase', 'decrease'] }, amount: { type: 'integer', minimum: 1 }, reason: { type: 'string', minLength: 1, maxLength: 500 } } } } } },
      responses: {
        '200': { description: 'Idempotent replay of the recorded adjustment' },
        '201': { description: 'Score adjustment appended to history' },
        '400': { description: 'Idempotency-Key or required fields are invalid' },
        '403': { description: 'Owner or admin role required' },
        '404': { description: 'LINE account or friend not found in account scope' },
        '409': { description: 'Same idempotency key was used with different content' },
        '422': { description: 'Score would leave the configured band range' },
        '428': { description: 'Irreversible confirmation required' },
      },
    },
  },
  '/api/action-scores/bands/preview': {
    post: {
      tags: ['Mileage'], summary: '編集中の帯の分けかたで各帯の人数だけを数える読み取り専用プレビュー（N-235。公開版・点数は不変）',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['accountId', 'bands'], properties: { accountId: { type: 'string' }, bands: { type: 'object', required: ['min', 'max', 'normalMin', 'highMin'], properties: { min: { type: 'integer', minimum: 0 }, max: { type: 'integer' }, normalMin: { type: 'integer' }, highMin: { type: 'integer' } } } } } } } },
      responses: { '200': { description: 'Band distribution preview' }, '400': { description: 'LINE account is required' }, '403': { description: 'Staff role required' }, '404': { description: 'LINE account not found in account scope' }, '422': { description: 'Band boundaries are invalid' } },
    },
  },
};
