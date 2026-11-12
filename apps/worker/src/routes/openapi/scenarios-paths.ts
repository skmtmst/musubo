// 実行時の副作用を混ぜず定義だけを置き、ハンドラは各機能の経路に保つ。
export const scenariosPaths = {
  '/api/scenarios/bulk-stop': {
    post: {
      tags: ['Scenarios'], summary: '確認したシナリオを一括停止',
      description: '最大50件。確認時の版と配信対象の集計がすべて一致した場合だけまとめて停止する。',
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', required: ['items'], properties: { items: { type: 'array', minItems: 1, maxItems: 50, items: {
          type: 'object', required: ['id', 'revision', 'activeCount', 'rowIdSum', 'rowIdSquareSum'], properties: {
            id: { type: 'string', minLength: 1 }, revision: { type: 'integer', minimum: 1 },
            activeCount: { type: 'integer', minimum: 0 }, rowIdSum: { type: 'integer', minimum: 0 }, rowIdSquareSum: { type: 'integer', minimum: 0 },
          },
        } } },
      } } } },
      responses: { '200': { description: '停止件数を返す' }, '400': { description: '入力不正' }, '403': { description: '操作権限または対象の閲覧権限がない' }, '404': { description: '対象が担当範囲にない' }, '409': { description: '版または対象が変化した' } },
    },
  },
  // ── Scenarios ────────────────────────────────────────────────────────────
  '/api/scenarios': {
    get: {
      tags: ['Scenarios'],
      summary: '閲覧権限とLINEアカウント範囲内のシナリオ一覧取得',
      parameters: [{ name: 'lineAccountId', in: 'query', schema: { type: 'string' } }],
      responses: {
        '200': { description: 'Visible scenarios' },
        '403': { description: 'Scenario view permission required' },
        '404': { description: 'LINE account not found in account scope' },
      },
    },
    post: {
      tags: ['Scenarios'],
      summary: 'シナリオ作成',
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, triggerType: { type: 'string' }, description: { type: 'string' }, triggerTagId: { type: 'string' }, isActive: { type: 'boolean', default: false, description: '省略時は停止状態。明示的なtrueには公開権限が必要' } }, required: ['name', 'triggerType'] } } } },
      responses: { '201': { description: 'Scenario created (inactive unless explicitly activated)' }, '403': { description: 'Scenario edit permission required; isActive:true also requires publish permission' } },
    },
  },
  '/api/scenarios/{id}': {
    get: {
      tags: ['Scenarios'],
      summary: 'シナリオ詳細取得 (ステップ含む)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: '最後の停止記録とステップを含むシナリオ', content: { 'application/json': { schema: {
          type: 'object', properties: {
            success: { type: 'boolean' },
            data: { allOf: [
              { $ref: '#/components/schemas/Scenario' },
              { type: 'object', properties: { steps: { type: 'array', items: { $ref: '#/components/schemas/ScenarioStep' } } } },
            ] },
          },
        } } } },
        '403': { description: 'Scenario view permission required' },
        '404': { description: 'Not found in account scope' },
      },
    },
    put: {
      tags: ['Scenarios'],
      summary: 'シナリオ更新',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', properties: {
          name: { type: 'string' }, description: { type: 'string', nullable: true },
          triggerType: { type: 'string', enum: ['friend_add', 'tag_added', 'form_answer', 'booking_confirmed', 'manual'] },
          triggerTagId: { type: 'string', nullable: true },
          isActive: { type: 'boolean', description: 'falseで停止、trueで再開。再開しても最後の停止記録は残る' },
          reason: { type: 'string', maxLength: 200, description: 'isActive:falseのときだけ指定できる任意の理由。省略・空白のみはnullで記録。すでに停止中なら記録を上書きしない' },
          deliveryMode: { type: 'string', enum: ['relative', 'elapsed', 'absolute_time'] },
          allowConcurrent: { type: 'boolean' }, folderId: { type: 'string', nullable: true },
          audienceCondition: { type: 'object', nullable: true },
          onCompleteMode: { type: 'string', enum: ['pause', 'resume_previous', 'move'] },
          onCompleteScenarioId: { type: 'string', nullable: true },
        },
      } } } },
      responses: {
        '200': { description: '更新後のシナリオと最後の停止記録', content: { 'application/json': { schema: {
          type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/Scenario' } },
        } } } },
        '400': { description: '入力不正（理由が200字超・文字列でない・停止以外で指定など）' },
        '403': { description: 'シナリオ編集権限が必要' },
        '404': { description: '担当範囲内にシナリオが見つからない' },
      },
    },
    delete: {
      tags: ['Scenarios'],
      summary: 'シナリオ削除',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Deleted' } },
    },
  },
  '/api/scenarios/{id}/confirmation': {
    get: {
      tags: ['Scenarios'], summary: '停止・削除の確認対象と版を取得',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Content revision, active count and subscription revisions' }, '403': { description: 'Scenario edit permission required' }, '404': { description: 'Not found in account scope' } },
    },
  },
  '/api/scenarios/{id}/preview': {
    get: {
      tags: ['Scenarios'], summary: 'シナリオの配信時系列を確認',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Timeline preview' }, '403': { description: 'Scenario view permission required' }, '404': { description: 'Not found in account scope' } },
    },
  },
  '/api/scenarios/{id}/stats': {
    get: {
      tags: ['Scenarios'], summary: 'シナリオの到達率を確認',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Scenario statistics' }, '403': { description: 'Scenario view permission required' }, '404': { description: 'Not found in account scope' } },
    },
  },
  '/api/scenarios/{id}/actions': {
    get: {
      tags: ['Scenarios'], summary: 'シナリオのアクションを確認',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Scenario actions' }, '403': { description: 'Scenario view permission required' }, '404': { description: 'Not found in account scope' } },
    },
  },
  '/api/scenarios/{id}/triggers': {
    get: {
      tags: ['Scenarios'], summary: 'シナリオの開始条件を確認',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Scenario triggers' }, '403': { description: 'Scenario view permission required' }, '404': { description: 'Not found in account scope' } },
    },
  },
  '/api/scenarios/{id}/move-referrers': {
    get: {
      tags: ['Scenarios'], summary: '終了後の移動先にしているシナリオを確認',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Referring scenarios for delete confirmation' }, '403': { description: 'Scenario view permission required' }, '404': { description: 'Not found in account scope' } },
    },
  },
  '/api/scenarios/{id}/simulate': {
    post: {
      tags: ['Scenarios'],
      summary: '副作用なしで対象人数と通ごとの予定を試算',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object',
        required: ['lineAccountId'],
        properties: {
          lineAccountId: { type: 'string' },
          startAt: { type: 'string', format: 'date-time' },
        },
      } } } },
      responses: {
        '200': { description: 'Audience counts and planned steps; no side effects' },
        '403': { description: 'Scenario view permission required' },
        '404': { description: 'Not found in account scope' },
      },
    },
  },
  '/api/scenarios/{id}/runs': {
    get: {
      tags: ['Scenarios'],
      summary: '購読状況・テスト送信・送信枠・通別実績を取得',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'lineAccountId', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'paused', 'completed', 'delivering'] } },
        { name: 'cursor', in: 'query', schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
      ],
      responses: {
        '200': { description: 'Scenario run summary and metrics' },
        '403': { description: 'Scenario view permission required' },
        '404': { description: 'Not found in account scope' },
      },
    },
  },
  '/api/scenarios/{id}/friends/{friendId}/plan': {
    get: {
      tags: ['Scenarios'],
      summary: '選んだ友だちへの配信予定・待機・分岐理由を副作用なしで試算（IDEA-05）',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'friendId', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'lineAccountId', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'startAt', in: 'query', schema: { type: 'string', format: 'date-time' } },
      ],
      responses: {
        '200': { description: 'Per-friend delivery plan; no side effects' },
        '400': { description: 'lineAccountId required' },
        '403': { description: 'Scenario view permission required' },
        '404': { description: 'Not found in account scope' },
      },
    },
  },
  '/api/scenarios/{id}/draft': {
    put: {
      tags: ['Scenarios'],
      summary: '送信後アクション第2期までを楽観ロックで保存',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object',
        required: ['lineAccountId', 'expectedVersion', 'afterActions'],
        properties: {
          lineAccountId: { type: 'string' },
          expectedVersion: { type: 'integer', minimum: 0 },
          afterActions: { type: 'array', maxItems: 100, items: { type: 'object' } },
        },
      } } } },
      responses: {
        '200': { description: 'Draft updated with next version' },
        '403': { description: 'scenario.definition.edit permission required' },
        '404': { description: 'Not found in account scope' },
        '409': { description: 'Version conflict' },
        '422': { description: 'Invalid action or foreign account resource' },
      },
    },
  },
  '/api/scenarios/{id}/steps': {
    post: {
      tags: ['Scenarios'],
      summary: 'ステップ追加',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '201': { description: 'Step created' } },
    },
  },
  '/api/scenarios/{id}/steps/{stepId}': {
    put: {
      tags: ['Scenarios'],
      summary: 'ステップ更新',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'stepId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: { '200': { description: 'Updated' } },
    },
    delete: {
      tags: ['Scenarios'],
      summary: 'ステップ削除',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'stepId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: { '200': { description: 'Deleted' } },
    },
  },
  '/api/scenarios/{id}/enroll/{friendId}': {
    post: {
      tags: ['Scenarios'],
      summary: '手動エンロール',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'friendId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '201': { description: 'Enrolled' },
        '404': { description: 'シナリオ・友だちなし' },
        '409': { description: '登録済み・削除不可の連携あり' },
        '422': { description: '未公開・停止中・ブロック中など登録不可' },
      },
    },
  },
  '/api/scenarios/{id}/publish': {
    post: {
      tags: ['Scenarios'],
      summary: '公開版の固定',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        {
          name: 'Idempotency-Key',
          in: 'header',
          required: true,
          schema: { type: 'string' },
          description: '公開操作の確認キー（8〜200字の英数._:-）。同じキーの再実行は同じ版を返し、別内容での使い回しは409。',
        },
      ],
      responses: {
        '200': { description: 'Published' },
        '400': { description: '確認キー不足・不正' },
        '403': { description: '権限不足' },
        '404': { description: 'シナリオなし・他アカウント' },
        '409': { description: '確認キーの使い回し・同時公開の競合' },
      },
    },
  },
  // ── 友だち単位の購読操作（機能05）─────────────────────────
  '/api/scenario-subscriptions/{subscriptionId}/pause': {
    post: {
      tags: ['Scenarios'],
      summary: '購読の手動停止',
      parameters: [
        { name: 'subscriptionId', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' }, description: '操作の確認キー。同じキーの再送は同じ結果を返し、別の購読・別操作への使い回しは409。' },
      ],
      responses: {
        '200': { description: 'Paused' },
        '400': { description: '確認キー不足・不正' },
        '403': { description: '権限不足（scenario.subscription.edit）' },
        '404': { description: '購読なし・他アカウント' },
        '409': { description: '配信処理中・終了済み・確認キーの使い回し' },
      },
    },
  },
  '/api/scenario-subscriptions/{subscriptionId}/resume': {
    post: {
      tags: ['Scenarios'],
      summary: '購読の再開',
      parameters: [
        { name: 'subscriptionId', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' }, description: '操作の確認キー。' },
      ],
      responses: {
        '200': { description: 'Resumed' },
        '400': { description: '確認キー不足・不正' },
        '403': { description: '権限不足（scenario.subscription.edit）' },
        '404': { description: '購読なし・他アカウント' },
        '409': { description: '配信処理中・終了済み・再開不可・確認キーの使い回し' },
      },
    },
  },
  '/api/scenario-subscriptions/{subscriptionId}/retry': {
    post: {
      tags: ['Scenarios'],
      summary: '配信失敗で止まった購読の再送',
      parameters: [
        { name: 'subscriptionId', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' }, description: '操作の確認キー。' },
      ],
      responses: {
        '200': { description: '再送待ちにした' },
        '400': { description: '確認キー不足・不正' },
        '403': { description: '権限不足（scenario.step_run.retry）' },
        '404': { description: '購読なし・他アカウント' },
        '409': { description: '配信失敗以外・再送不可・確認キーの使い回し' },
      },
    },
  },
  '/api/scenario-subscriptions/{subscriptionId}/move': {
    post: {
      tags: ['Scenarios'],
      summary: '購読を別のシナリオへ移す',
      parameters: [
        { name: 'subscriptionId', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' }, description: '操作の確認キー。' },
      ],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { targetScenarioId: { type: 'string' } },
              required: ['targetScenarioId'],
            },
          },
        },
      },
      responses: {
        '200': { description: '移した（新しい購読を返す）' },
        '400': { description: '確認キー不足・不正・移し先未指定' },
        '403': { description: '権限不足（scenario.subscription.edit）' },
        '404': { description: '購読なし・移し先なし・他アカウント' },
        '409': { description: '配信処理中・終了済み・移し先に登録済み・確認キーの使い回し' },
        '422': { description: '移し先が停止中・アカウント不一致' },
      },
    },
  },
};
