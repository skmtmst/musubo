// 実行時の副作用を混ぜず定義だけを置き、ハンドラは各機能の経路に保つ。
export const settingsOperationsPaths = {
  '/api/settings/sns/connections': {
    get: {
      tags: ['Settings'], summary: '店舗のSNS契約枠・請求段・接続件数・Google主連携を読む',
      parameters: [{ name: 'lineAccountId', in: 'query', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: '契約枠、サーバー確認済み請求段、接続件数、主連携と版' },
        '403': { description: 'owner/admin以外、またはLINEアカウントの権限なし' },
        '404': { description: '契約枠が未登録' },
      },
    },
  },
  '/api/settings/sns/google-primary': {
    put: {
      tags: ['Settings'], summary: 'Googleビジネスの主連携を版付きで切り替える',
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', required: ['lineAccountId', 'connectionId', 'expectedVersion'],
        properties: {
          lineAccountId: { type: 'string' }, connectionId: { type: 'string' },
          expectedVersion: { type: 'integer', minimum: 0 },
        },
      } } } },
      responses: {
        '200': { description: '保存した接続IDと次の版' },
        '403': { description: 'owner/admin以外、閲覧のみ、またはLINEアカウントの権限なし' },
        '404': { description: '対象のGoogle接続が無い' },
        '409': { description: 'ほかの変更と版が競合' },
      },
    },
  },
  // ── Settings ─────────────────────────────────────────────────────────────
  '/api/settings/company': {
    get: {
      tags: ['Settings'],
      summary: '自社の会社名・ログイン表示名・ロゴを取得',
      description: 'ログイン中スタッフの所属会社だけを返す。版（version）付き。所属を確認できない場合は403。',
      responses: {
        '200': { description: '会社設定 { companyName・loginDisplayName・logoMediaId・logoUrl・logoBackgroundColor・version }' },
        '403': { description: '所属する会社を確認できない' },
        '404': { description: '会社が見つからない' },
      },
    },
    put: {
      tags: ['Settings'],
      summary: '自社の会社名・ログイン表示名・ロゴを版付きで保存',
      description: '会社全体のowner/adminだけが保存できる。ロゴはこの会社に登録された公開済みの画像だけ。expectedVersionが最新でなければ409で読み直しを求める。',
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object',
        required: ['companyName', 'loginDisplayName', 'logoMediaId', 'logoBackgroundColor', 'expectedVersion'],
        properties: {
          companyName: { type: 'string', maxLength: 200 },
          loginDisplayName: { type: 'string', maxLength: 200 },
          logoMediaId: { type: 'string', nullable: true },
          logoBackgroundColor: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
          expectedVersion: { type: 'integer', minimum: 0 },
        },
      } } } },
      responses: {
        '200': { description: '保存後の会社設定' },
        '400': { description: '入力不正' },
        '403': { description: '会社全体の編集権限がない' },
        '409': { description: '版の競合。読み直しが必要' },
        '422': { description: 'この会社の公開済み画像ではない' },
      },
    },
  },
  '/api/settings/features/visibility': {
    get: {
      tags: ['Settings'],
      summary: '一般スタッフ向けの機能表示可否を取得',
      description: '画面の殻に必要な機能ごとの表示可否booleanだけを返す。契約、会社設定、依存理由、並び順などの管理情報は返さない。',
      parameters: [{ name: 'account_id', in: 'query', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'Feature visibility booleans only' },
        '400': { description: 'account_id is required' },
        '403': { description: 'Account scope denied' },
      },
    },
  },
  '/api/settings/features/impact': {
    post: {
      tags: ['Settings'],
      summary: '機能設定の変更案が止める仕事を確認',
      description: '有効から無効へ変わる機能ごとに、公開中・予約中・依存機能の件数と対象種別、対象行IDを返す。保存はしない。止まる仕事があるときだけ確認トークンを発行する。',
      parameters: [{ name: 'account_id', in: 'query', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['features'], properties: { features: { type: 'object', additionalProperties: { type: 'boolean' } }, expectedVersion: { type: 'integer', minimum: 0 } } } } } },
      responses: { '200': { description: 'Feature impacts with target ids and confirmation token' }, '400': { description: 'Unknown feature or invalid value' }, '403': { description: 'Staff role required' }, '409': { description: 'Version conflict, reread required' } },
    },
  },
  // ── Operation alerts ────────────────────────────────────────────────────
  '/api/operations/alerts': {
    get: {
      tags: ['Operations'],
      summary: '運用異常の対応状況と通知結果を一覧する',
      description: '指定したLINEアカウント内だけの異常、受領・解消・再開履歴、通知結果をowner/adminへ返す。',
      parameters: [
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'include_resolved', in: 'query', required: false, schema: { type: 'string', enum: ['0', '1'] } },
      ],
      responses: {
        '200': { description: '運用異常の一覧、通知集計、イベント履歴' },
        '400': { description: 'LINEアカウントが未指定' },
        '403': { description: 'owner/adminではない、またはアカウント範囲外' },
        '500': { description: '一覧取得失敗' },
      },
    },
  },
  '/api/operations/alerts/{id}/acknowledge': {
    post: {
      tags: ['Operations'],
      summary: '運用異常を受領して対応中にする',
      description: '表示中の版をexpectedVersionとして受け取り、同じ管理者・同じメモの再試行だけを重複成功として扱う。',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object',
        required: ['lineAccountId', 'expectedVersion'],
        properties: {
          lineAccountId: { type: 'string' },
          expectedVersion: { type: 'integer', minimum: 1 },
          note: { type: 'string' },
        },
      } } } },
      responses: {
        '200': { description: '受領済みの異常。duplicate=trueは同一内容の再試行' },
        '400': { description: '受領内容が不正' },
        '403': { description: 'owner/adminではない、またはアカウント範囲外' },
        '404': { description: '指定アカウント内に異常が存在しない' },
        '409': { description: '版、管理者、またはメモが競合' },
        '500': { description: '受領の保存失敗' },
      },
    },
  },
  '/api/operations/alerts/{id}/notifications/retry': {
    post: {
      tags: ['Operations'],
      summary: '失敗または未設定だった運用異常通知を再試行する',
      description: '連絡先を設定した後を含め、指定アカウント内の未送信通知を再び送信待ちへ戻す。',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object',
        required: ['lineAccountId'],
        properties: { lineAccountId: { type: 'string' } },
      } } } },
      responses: {
        '200': { description: '再試行へ戻した通知件数' },
        '400': { description: 'LINEアカウントが未指定' },
        '403': { description: 'owner/adminではない、またはアカウント範囲外' },
        '404': { description: '指定アカウント内に異常が存在しない' },
        '500': { description: '再試行受付失敗' },
      },
    },
  },
  '/api/operations/incidents/{id}/restore-preview': {
    post: {
      tags: ['Operations'],
      summary: '復旧前に停止中の定義変更・追加・削除・期限切れを検査する',
      description: '停止時に保存した定義の版・期限の指紋と現在の定義を比較し、能力ごとの再開可否と理由を返す。読み取り専用。',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: '能力ごとのdrift検査結果（unchanged/changed/deleted/inactive/added/expired）' },
        '403': { description: 'owner/adminではない、緊急操作権限がない、またはアカウント範囲外' },
        '404': { description: '緊急操作の記録が存在しない' },
        '409': { description: '停止中のincidentではない' },
        '500': { description: '検査失敗' },
      },
    },
  },
  '/api/operations/send-paths': {
    get: {
      tags: ['Operations'],
      summary: '緊急停止が届く送信経路の台帳を一覧する',
      description: '外部へ届く送信経路ごとに、どの停止対象で止まるか・現在の状態・対象外の理由を返す。台帳と実装の食い違いはproblemsとして返す。',
      parameters: [{ name: 'account_id', in: 'query', required: false, schema: { type: 'string' } }],
      responses: {
        '200': { description: '経路一覧・停止対象ごとの状態・台帳の検査結果' },
        '403': { description: 'owner/adminではない、またはアカウント範囲外' },
        '500': { description: '一覧取得失敗' },
      },
    },
  },
  // ── AI development reports ──────────────────────────────────────────────
  '/api/integrations/ai-loop/reports': {
    post: {
      tags: ['Operations'],
      summary: 'AI開発タスクの状態をSlackへ一方向で報告',
      description: '署名済みの開始・完了・失敗・人間確認イベントだけを専用チャンネルへ表示する。Slackからの実行指示や承認は受け付けない。',
      security: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['version', 'eventId', 'taskId', 'repository', 'title', 'commander', 'executor', 'model', 'status', 'summary', 'taskUrl', 'occurredAt', 'revision'],
              properties: {
                version: { type: 'integer', const: 1 },
                eventId: { type: 'string', minLength: 3, maxLength: 255 },
                taskId: { type: 'string', minLength: 1, maxLength: 120 },
                repository: { type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
                title: { type: 'string', minLength: 1, maxLength: 120 },
                commander: { type: 'string', enum: ['codex', 'claude'] },
                executor: { type: 'string', enum: ['meta', 'codex'] },
                model: { type: 'string', minLength: 1, maxLength: 80 },
                status: { type: 'string', enum: ['started', 'completed', 'failed', 'approval'] },
                summary: { type: 'string', minLength: 1, maxLength: 500 },
                taskUrl: { type: 'string', format: 'uri' },
                prUrl: { type: 'string', format: 'uri' },
                occurredAt: { type: 'string', format: 'date-time' },
                revision: { type: 'integer', minimum: 946684800000, description: '状態確定時刻のUnixミリ秒。再実行を含め単調増加させる。' },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: 'Report created, updated, or ignored as stale' },
        '400': { description: 'Invalid report payload' },
        '401': { description: 'Invalid signature' },
        '503': { description: 'Report channel is not configured' },
      },
    },
  },
};
