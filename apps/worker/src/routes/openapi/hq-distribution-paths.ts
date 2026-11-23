import { hqTemplateListPaths } from '../hq-template-list-openapi.js';
import { hqTemplateMediaPaths } from '../hq-template-media-openapi.js';

// 実行時の副作用を混ぜず定義だけを置き、ハンドラは各機能の経路に保つ。
export const hqTemplateUploadPaths = {
  // ── HQ Templates ───────────────────────────────────────────────────────
  '/api/hq/templates/media/upload-sessions': {
    post: {
      tags: ['HQ Templates'], summary: '店を選ばず、統括の動画・音声の直接アップロードを準備する',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['filename', 'mimeType', 'sizeBytes'], properties: { filename: { type: 'string', maxLength: 200 }, mimeType: { enum: ['video/mp4', 'audio/mp4'] }, sizeBytes: { type: 'integer', minimum: 1, maximum: 209715200 } } } } } },
      responses: { '201': { description: '15分有効の署名付きPUT URL、必須ヘッダー、セッションIDと期限' }, '403': { description: '統括全体の編集権限がない' }, '422': { description: '形式・容量が不正' }, '500': { description: '直接アップロード未設定' } },
    },
  },
  '/api/hq/templates/media/upload-sessions/{id}/complete': {
    post: {
      tags: ['HQ Templates'], summary: '統括の動画・音声を容量・形式・ETag・長さで検査し、受取記録を返す',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['etag'], properties: { etag: { type: 'string' } } } } } },
      responses: { '201': { description: 'メディアの受取記録。再要求も同じ記録を返す。安全性の確認が終わるまで公開・配布しない' }, '403': { description: '統括全体の編集権限がない' }, '404': { description: '利用者・統括に属するセッションがない' }, '409': { description: '期限切れ・内容不一致・取り込み未確定' }, '422': { description: 'ファイル形式・長さが不正' } },
    },
  },
  '/api/hq/templates/media/upload-sessions/{id}': {
    delete: {
      tags: ['HQ Templates'], summary: '未完了の統括アップロードを取り消す',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'セッションを失効し、未完了のファイルを削除' }, '403': { description: '統括全体の編集権限がない' }, '404': { description: '利用者・統括に属するセッションがない' }, '409': { description: '完了済みのファイルは取り消せない' } },
    },
  },
  ...hqTemplateMediaPaths,
  '/api/hq/templates/accounts': {
    get: {
      tags: ['HQ Templates'],
      summary: '配布先として選べるLINE公式アカウントを取得',
      responses: { '200': { description: 'Tenant-scoped account list' }, '403': { description: 'Owner or admin role required' } },
    },
  },
  ...hqTemplateListPaths,
};

export const hqDistributionPaths = {
  '/api/hq/templates/{id}': {
    get: {
      tags: ['HQ Templates'], summary: '統括ひな形の詳細を取得',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Template detail' }, '403': { description: 'Owner or admin role required' }, '404': { description: 'Not found' } },
    },
    patch: {
      tags: ['HQ Templates'], summary: '統括ひな形を改訂',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['expectedRevision', 'name', 'definition'], properties: {
        expectedRevision: { type: 'integer', minimum: 1 }, name: { type: 'string', minLength: 1 }, description: { type: 'string' }, definition: { type: 'object' },
      } } } } },
      responses: { '200': { description: 'Updated' }, '403': { description: 'Owner or admin role required' }, '404': { description: 'Not found' }, '409': { description: 'Revision conflict' } },
    },
    delete: {
      tags: ['HQ Templates'], summary: '統括ひな形を保管（店の配布済みコピーは保持）',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['expectedRevision'], properties: { expectedRevision: { type: 'integer', minimum: 1 } } } } } },
      responses: { '200': { description: 'Deleted' }, '403': { description: 'Owner or admin role required' }, '404': { description: 'Not found' }, '409': { description: 'Revision conflict' } },
    },
  },
  '/api/hq/templates/{id}/preflight': {
    post: {
      tags: ['HQ Templates'], summary: '配布先の競合を事前検査',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['accountIds'], properties: { accountIds: { type: 'array', items: { type: 'string' } } } } } } },
      responses: { '200': { description: 'Preflight result with per-account conflicts' }, '400': { description: 'Invalid account selection' }, '403': { description: 'Owner or admin role required' } },
    },
  },
  '/api/hq/templates/{id}/distribute': {
    post: {
      tags: ['HQ Templates'], summary: '事前検査済みの選択内容で店舗へ配布',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['preflightId', 'resolutions'], properties: {
        preflightId: { type: 'string' }, resolutions: { type: 'array', maxItems: 270, items: { type: 'object', required: ['accountId', 'sourceId', 'mode'], properties: {
          accountId: { type: 'string' }, sourceId: { type: 'string' }, mode: { type: 'string', enum: ['create', 'overwrite', 'alias'] }, targetId: { type: 'string' },
        } } },
      } } } } },
      responses: { '200': { description: 'Distribution run result' }, '400': { description: 'Invalid or changed selection' }, '403': { description: 'Owner or admin role required' }, '409': { description: 'Template or target version conflict' } },
    },
  },
  '/api/hq/templates/{id}/redistributions': {
    post: {
      tags: ['HQ Templates'], summary: '統括から配った店へ裏の仕事で配り直す',
      description: '予約メニュー・マイルの景品のひな形だけ。30分以内の配る前の確かめ（自分が作り、今の版のもの）から、対応表に記録がある店だけをジョブにする。対応のない店は skippedAccountIds で返し、名前で選ぶ今の配布の流れに残す。同じ requestKey（または Idempotency-Key）の再送は同じジョブを返し、中身が違えば 409。店ごとの書き込みは定期処理が進め、直していない店は新しい版に更新、直した店と公開中の景品は「本部の新しい版があります」と知らせる。',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'Idempotency-Key', in: 'header', schema: { type: 'string' }, description: '再送時も同じ値を使う依頼ID。省略時は body.requestKey が必須' }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['preflightIds'], properties: {
        preflightIds: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: { type: 'string' } }, requestKey: { type: 'string', minLength: 8, maxLength: 128 },
      } } } } },
      responses: { '200': { description: 'The same redistribution job for the same request key' }, '201': { description: 'Redistribution job accepted' }, '400': { description: 'Invalid request key or preflight' }, '403': { description: 'HQ edit permission required (read-only and impersonation are rejected)' }, '404': { description: 'Template or preflight not found' }, '409': { description: 'Preflight expired or consumed, template version changed, no bound stores, or idempotency conflict' }, '422': { description: 'Template type does not support redistribution' } },
    },
  },
  '/api/hq/templates/{id}/redistributions/{jobId}': {
    get: {
      tags: ['HQ Templates'], summary: '配り直しのジョブの進みと店ごとの結果を取得',
      description: 'status は pending/running/completed/partial/failed。店ごとの outcome は applied（更新した）/notified（店の判断待ち）/unchanged/failed/conflict。code は失敗の理由だけ。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'jobId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: { '200': { description: 'Redistribution job progress' }, '403': { description: 'Owner or admin role required' }, '404': { description: 'Not found' } },
    },
  },
  '/api/hq/templates/{id}/distributions/{runId}': {
    get: {
      tags: ['HQ Templates'], summary: '配布実行の結果を取得',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: { '200': { description: 'Distribution result' }, '403': { description: 'Owner or admin role required' }, '404': { description: 'Not found' } },
    },
  },
};
