/*
  開店準備ガイドの進み具合（利用者×LINEアカウントで1件持つ控え）。
  実装は apps/worker/src/routes/getting-started.ts の
  GET/PUT /api/getting-started/guide。どちらも owner / admin / staff のみ。
  account_id（または accountId）は必須で、見える範囲外のアカウントは 404。
*/
const accountId = {
  name: 'account_id',
  in: 'query',
  required: true,
  description: '対象のLINEアカウントID（accountId でも受ける）',
  schema: { type: 'string' },
};

export const guideProgressSchema = {
  type: 'object',
  required: ['phase', 'stepKey', 'procedureIndex', 'updatedAt'],
  properties: {
    phase: { type: 'string', enum: ['idle', 'active', 'paused', 'done'], description: 'ガイドの状態' },
    stepKey: { type: 'string', nullable: true, description: '案内中の項目のキー。未開始は null' },
    procedureIndex: { type: 'integer', minimum: 1, description: '項目の中の手順番号（1から）' },
    updatedAt: { type: 'string', nullable: true, description: '最後に保存した時刻' },
  },
};

/*
  成功応答は他の経路と同じ `{ success: true, data: … }` の包み方で返す。
  実装（getting-started.ts の `c.json({ success: true, data: guidePayload(row) })`）と
  同じ形をそのまま書く。包みを省くと文書と実応答がずれる（差し戻しの指摘）。
  ずれの再発は getting-started-guide-contract.test.ts が実応答と突き合わせて見張る。
*/
const guideProgressResponse = {
  type: 'object',
  required: ['success', 'data'],
  properties: {
    success: { type: 'boolean', enum: [true], description: '成功は常に true' },
    data: guideProgressSchema,
  },
};

export const gettingStartedGuidePaths = {
  '/api/getting-started/guide': {
    get: {
      tags: ['Getting started'],
      summary: '開店準備ガイドの進み具合を取得',
      description: '保存がなければ phase=idle / stepKey=null / procedureIndex=1 を返す。',
      parameters: [accountId],
      responses: {
        '200': { description: 'ガイドの進み具合', content: { 'application/json': { schema: guideProgressResponse } } },
        '400': { description: 'account_id がない' },
        '401': { description: '未認証' },
        '403': { description: '権限なし' },
        '404': { description: '見える範囲にないアカウント' },
      },
    },
    put: {
      tags: ['Getting started'],
      summary: '開店準備ガイドの進み具合を保存',
      description: '案内の開始・一時停止・再開・完了と、手順番号の進みをそのまま保存する。',
      parameters: [accountId],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['phase'],
              properties: {
                phase: { type: 'string', enum: ['idle', 'active', 'paused', 'done'] },
                stepKey: { type: 'string', nullable: true },
                procedureIndex: { type: 'integer', minimum: 1 },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: '保存後の進み具合', content: { 'application/json': { schema: guideProgressResponse } } },
        '400': { description: 'phase / stepKey / procedureIndex が不正、または account_id がない' },
        '401': { description: '未認証' },
        '403': { description: '権限なし' },
        '404': { description: '見える範囲にないアカウント' },
      },
    },
  },
};
