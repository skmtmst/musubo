// 実行時の副作用を混ぜず定義だけを置き、ハンドラは各機能の経路に保つ。
export const broadcastsPaths = {
  // ── Broadcasts ───────────────────────────────────────────────────────────
  '/api/broadcast-message-assets/counts': {
    get: {
      tags: ['Broadcasts'],
      summary: '配信素材の種類別件数を取得（タブ件数用・PERF-04）',
      parameters: [
        { name: 'lineAccountId', in: 'query', schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: 'Counts keyed by asset kind' },
        '403': { description: 'LINEアカウントの表示権限なし' },
      },
    },
  },
  '/api/broadcasts': {
    get: { tags: ['Broadcasts'], summary: '配信一覧取得', responses: { '200': { description: 'All broadcasts' } } },
    post: {
      tags: ['Broadcasts'],
      summary: '配信作成',
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { title: { type: 'string' }, messageType: { type: 'string' }, messageContent: { type: 'string' }, targetType: { type: 'string' }, targetTagId: { type: 'string' }, accountIds: { type: 'array', items: { type: 'string' } }, dedupPriority: { type: 'array', items: { type: 'string' } }, scheduledAt: { type: 'string' } }, required: ['title', 'messageType', 'messageContent', 'targetType'] } } } },
      responses: { '201': { description: 'Broadcast created' } },
    },
  },
  '/api/broadcasts/{id}': {
    get: {
      tags: ['Broadcasts'],
      summary: '配信詳細取得',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Broadcast' } },
    },
    put: { tags: ['Broadcasts'], summary: '配信更新', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Updated' } } },
    delete: { tags: ['Broadcasts'], summary: '配信削除', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Deleted' }, '409': { description: '送信中・送信済みは削除不可' } } },
  },
  '/api/broadcasts/{id}/send': {
    post: {
      tags: ['Broadcasts'],
      summary: '即時配信',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Sent' } },
    },
  },
  /*
   * 送り始めた配信を止める・続きを送る・失敗した相手だけ送り直す。
   * どれも `expectedVersion`（画面が読み込んだ版）が要る。版が食い違えば
   * 409 で断り、二重の適用を止める。
   */
  '/api/broadcasts/{id}/cancel': {
    post: {
      tags: ['Broadcasts'], summary: '予約した配信を下書きへ戻す',
      description: '予約の読み込み時に取得した expectedVersion の指定を推奨します。版が変わっていれば取消を断り現在の予約を返します。省略時は従来どおり取り消します。',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { expectedVersion: { type: 'integer', minimum: 1 } } } }, 'application/x-www-form-urlencoded': { schema: { type: 'object', properties: { expectedVersion: { type: 'integer', minimum: 1 } } } } } },
      responses: { '200': { description: '取消して下書きへ戻した' }, '400': { description: '版の形式が不正' }, '404': { description: '対象を確認できない' }, '409': { description: '予約状態または版が変わった。版指定時は現在の配信をdataに返す' } },
    },
  },
  '/api/broadcasts/{id}/stop': {
    post: {
      tags: ['Broadcasts'],
      summary: '送信中の配信を停止',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', properties: { expectedVersion: { type: 'integer' } }, required: ['expectedVersion'] } } },
      },
      responses: {
        '200': { description: '停止した（すでに停止済みの再要求も 200）' },
        '400': { description: 'expectedVersion が無い' },
        '409': { description: '送信中でない／全員配信で止められない／版が食い違う' },
      },
    },
  },
  '/api/broadcasts/{id}/resume': {
    post: {
      tags: ['Broadcasts'],
      summary: '停止した配信の続きを送る',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', properties: { expectedVersion: { type: 'integer' } }, required: ['expectedVersion'] } } },
      },
      responses: {
        '200': { description: '再開した' },
        '400': { description: 'expectedVersion が無い' },
        '409': { description: '停止中でない／版が食い違う' },
      },
    },
  },
  '/api/broadcasts/{id}/retry-failed': {
    post: {
      tags: ['Broadcasts'],
      summary: '失敗した相手だけ再送（送達不明は含まない）',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', properties: { expectedVersion: { type: 'integer' } }, required: ['expectedVersion'] } } },
      },
      responses: {
        '202': { description: '再送を受け付けた' },
        '400': { description: 'expectedVersion が無い' },
        '409': { description: '再送できる相手がいない／送信済みでも停止中でもない／版が食い違う' },
        '428': { description: '取り消せない操作の確認を経ていない' },
      },
    },
  },
  '/api/broadcasts/dedup-preview': {
    post: {
      tags: ['Broadcasts'],
      summary: '複数アカ重複除外の事前プレビュー',
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                accountIds: { type: 'array', items: { type: 'string' } },
                dedupPriority: { type: 'array', items: { type: 'string' } },
              },
              required: ['accountIds', 'dedupPriority'],
            },
          },
        },
      },
      responses: { '200': { description: 'Preview computed (totalSelected, uniqueRecipients, reduction, perAccount)' } },
    },
  },
  /*
   * 二者承認（m12a / -06 §6）。1,000通以上（機能設定で変更可）の送信は、
   * 送る人とは別の人の承認が要る。自分の依頼は承認できない。
   */
  '/api/broadcasts/approval-config': {
    get: {
      tags: ['Broadcasts'],
      summary: '二者承認の境目と運用者数',
      parameters: [{ name: 'lineAccountId', in: 'query', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'threshold, operatorCount, singleOperator' } },
    },
  },
  '/api/broadcasts/approval-threshold': {
    get: {
      tags: ['Broadcasts'],
      summary: '承認が要る通数の境目の取得',
      parameters: [{ name: 'lineAccountId', in: 'query', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'threshold' } },
    },
    put: {
      tags: ['Broadcasts'],
      summary: '承認が要る通数の境目の変更（機能設定）',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', properties: { lineAccountId: { type: 'string' }, threshold: { type: 'integer', minimum: 1, maximum: 1000000 } }, required: ['lineAccountId', 'threshold'] } } },
      },
      responses: { '200': { description: 'threshold を保存した' }, '400': { description: '範囲外の値' } },
    },
  },
  '/api/broadcasts/approvals/candidates': {
    get: {
      tags: ['Broadcasts'],
      summary: '承認を頼める相手の一覧（自分は除く）',
      parameters: [{ name: 'lineAccountId', in: 'query', schema: { type: 'string' } }],
      responses: { '200': { description: '承認できる人の一覧' } },
    },
  },
  '/api/broadcasts/{id}/approval': {
    get: {
      tags: ['Broadcasts'],
      summary: '承認の今の状態と判定',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'approval, gate, viewer' } },
    },
  },
  '/api/broadcasts/{id}/approval-request': {
    post: {
      tags: ['Broadcasts'],
      summary: '承認の依頼（送る人が押す）',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', properties: { approverStaffId: { type: 'string' }, note: { type: 'string' } }, required: ['approverStaffId'] } } },
      },
      responses: { '201': { description: '依頼した' }, '409': { description: '承認が要らない人数／1人運用／依頼中' } },
    },
  },
  '/api/broadcasts/{id}/approval-approve': {
    post: {
      tags: ['Broadcasts'],
      summary: '承認（承認する人が押す）',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: {
          type: 'object',
          properties: { expectedVersion: { type: 'integer', minimum: 1, description: '承認者が内容を確認した配信の版' } },
          required: ['expectedVersion'],
        } } },
      },
      responses: { '200': { description: '承認した（needsSend のときは送信へ進める）' }, '400': { description: '確認した版が未指定、または正の安全な整数でない' }, '403': { description: '権限なし／自分の依頼' }, '409': { description: '確認後に本文・宛先・承認依頼が変わった、または依頼中でない' } },
    },
  },
  '/api/broadcasts/{id}/approval-reject': {
    post: {
      tags: ['Broadcasts'],
      summary: '差し戻し（理由必須）',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } } },
      },
      responses: { '200': { description: '差し戻した' }, '400': { description: '理由が無い' } },
    },
  },
  '/api/broadcasts/{id}/approval-cancel': {
    post: {
      tags: ['Broadcasts'],
      summary: '依頼の取り消し（頼んだ人・owner/admin）',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: '取り消した' }, '409': { description: '依頼中でない' } },
    },
  },
  '/api/broadcasts/{id}/approval-remind': {
    post: {
      tags: ['Broadcasts'],
      summary: 'もう一度知らせる',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: '知らせ直した' }, '409': { description: '依頼中でない' } },
    },
  },
  '/api/broadcasts/{id}/recipients': {
    get: {
      tags: ['Broadcasts'],
      summary: '宛先ごとの結果の台帳',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'result', in: 'query', schema: { type: 'string', enum: ['all', 'delivered', 'temporary', 'permanent', 'unknown', 'inflight'], default: 'all' } },
        { name: 'cursor', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
      ],
      responses: { '200': { description: 'rows, summary, pagination（全員配信・旧配信は集約だけ）' }, '400': { description: 'result が正しくない' }, '404': { description: 'Broadcast not found' } },
    },
  },
  '/api/broadcasts/{id}/activity': {
    get: {
      tags: ['Broadcasts'],
      summary: '配信への操作の記録（新しい順）',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'cursor', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
      ],
      responses: { '200': { description: 'entries, pagination（追記だけ。消せない）' }, '404': { description: 'Broadcast not found' } },
    },
  },
};
