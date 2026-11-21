// 実行時の副作用を混ぜず定義だけを置き、ハンドラは各機能の経路に保つ。
export const autoRepliesPaths = {
  '/api/auto-replies': {
    get: {
      tags: ['Auto replies'], summary: 'LINEアカウント範囲内の自動応答一覧を取得',
      parameters: [{ name: 'accountId', in: 'query', schema: { type: 'string' } }],
      responses: { '200': { description: 'Visible auto replies' }, '403': { description: 'Staff role required' }, '404': { description: 'LINE account not found in account scope' } },
    },
  },
  '/api/auto-replies/{id}/restore': {
    post: {
      tags: ['Auto replies'], summary: '削除した自動応答を元に戻す（戻した直後は停止のまま）',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Auto reply restored as stopped' }, '403': { description: 'Owner or admin role required' }, '404': { description: 'Auto reply not found or not deleted' } },
    },
  },
  '/api/auto-replies/{id}/stop': {
    post: {
      tags: ['Auto replies'], summary: '自動応答を停止し、理由・担当者・日時を記録（E-01）',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { reason: { type: 'string' } } } } } },
      responses: { '200': { description: 'Auto reply stopped; stop record returned' }, '400': { description: 'Idempotency-Key header required or invalid reason' }, '403': { description: 'Owner or admin role required' }, '404': { description: 'Auto reply not found in account scope' } },
    },
  },
  '/api/auto-reply-runs/{id}/retry': {
    post: {
      tags: ['Auto replies'], summary: '恒久失敗した後続処理だけを保存済みの内容でやり直す（LINEへの返信は送り直さない）（N-081）',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Retry executed; evaluation recomputed from all action runs' }, '403': { description: 'Owner or admin role required' }, '404': { description: 'Evaluation not found in account scope' }, '409': { description: 'No permanent_failed action runs to claim (already processing or completed)' } },
    },
  },
  '/api/friend-add-runs/{id}/retry': {
    post: {
      tags: ['Webhook'],
      summary: '友だち追加時配信で失敗した処理だけを固定済み内容から再試行（N-102/N-103）',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: 'Failed action runs retried; successful actions were not repeated' },
        '400': { description: 'LINE account is required' },
        '403': { description: 'Owner or admin role required' },
        '404': { description: 'Run not found in account scope' },
        '409': { description: 'No failed action is retryable or another retry already won' },
        '500': { description: 'Retry failed safely' },
      },
    },
  },
  '/api/friend-add-rules/reorder': {
    patch: {
      tags: ['Webhook'],
      summary: '友だち追加時の配信の優先順位を一括更新（一覧のつまみ並び替え）',
      description:
        '動かせる行（受け皿以外）の新しい順を ids で受け取り、1回のバッチで書く。そのアカウント・区分の受け皿以外の全件をちょうど含む並びだけを受け付け、足りなければ 409 で読み直しを促す。',
      parameters: [{ name: 'account_id', in: 'query', required: false, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['friendKind', 'ids'],
              properties: {
                accountId: { type: 'string', description: '対象のLINEアカウント（query の account_id でも可）' },
                friendKind: { type: 'string', enum: ['first_time', 'returning'] },
                ids: { type: 'array', items: { type: 'string' }, maxItems: 500, description: '受け皿以外の全設定の新しい順' },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: 'Order updated' },
        '400': { description: 'account_id / friendKind / ids missing or invalid' },
        '403': { description: 'Owner or admin role required' },
        '404': { description: 'Account not in visible scope' },
        '409': { description: 'ORDER_CHANGED: list changed elsewhere; reload and retry' },
      },
    },
  },
  '/api/friend-add-rules/order': {
    put: {
      tags: ['Webhook'],
      summary: '友だち追加時の配信の優先順位を版つきで一括更新（F8）',
      description:
        '対象IDの全部・所属・区分・expectedVersion の4点を厳密に見る。並びの版は一覧の orderVersion（受け皿以外の lock_version 合計）。どれか1つでも合わなければ書かず 409 で読み直しを促す。',
      parameters: [{ name: 'account_id', in: 'query', required: false, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['friendKind', 'ids', 'expectedVersion'],
              properties: {
                accountId: { type: 'string', description: '対象のLINEアカウント（query の account_id でも可）' },
                friendKind: { type: 'string', enum: ['first_time', 'returning'] },
                ids: { type: 'array', items: { type: 'string' }, maxItems: 500, description: '受け皿以外の全設定の新しい順' },
                expectedVersion: { type: 'integer', minimum: 0, description: '一覧の orderVersion' },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: 'Order updated with new orderVersion' },
        '400': { description: 'account_id / friendKind / ids / expectedVersion missing or invalid' },
        '403': { description: 'Owner or admin role required' },
        '404': { description: 'Account not in visible scope' },
        '409': { description: 'ORDER_CHANGED or ORDER_VERSION_CONFLICT: reload and retry with currentVersion' },
      },
    },
  },
  '/api/friend-add-rules/{id}/test-recipient': {
    get: {
      tags: ['Webhook'],
      summary: '操作者本人のテスト送信先を確認',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: { '200': { description: 'Recipient availability' }, '400': { description: 'Account required' }, '404': { description: 'Rule or account not found' } },
    },
  },
  '/api/friend-add-rules/{id}/test-send': {
    post: {
      tags: ['Webhook'],
      summary: '友だち追加時の配信を操作者本人だけへテスト送信（F12）',
      description:
        '保存済み版のテキスト本文で固定し、送り先は操作者のLINEだけ。本文・引数での送り先指定は受け付けない。手動扱いとして delivery_type=test・source=manual で記録する。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'account_id', in: 'query', required: false, schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: 'Test sent to self with fixed version' },
        '400': { description: 'account_id or Idempotency-Key missing or invalid' },
        '403': { description: 'Role or permission required' },
        '404': { description: 'Rule or account not in visible scope' },
        '409': { description: 'Operator LINE not found among friends' },
        '422': { description: 'Saved version has no text body' },
        '429': { description: 'Repeated too quickly; retry after 10 seconds' },
      },
    },
  },
};
