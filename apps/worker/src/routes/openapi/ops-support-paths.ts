// 実行時の副作用を混ぜず定義だけを置き、ハンドラは各機能の経路に保つ。
export const opsSupportPaths = {
  // ── HQ Support ─────────────────────────────────────────────────────────
  '/api/hq/support/context': {
    get: {
      tags: ['HQ Support'], summary: '問い合わせ画面の表示用情報を取得',
      responses: { '200': { description: 'Tenant-scoped kinds, accounts and sender' } },
    },
  },
  '/api/hq/support/kinds': {
    get: {
      tags: ['HQ Support'], summary: '問い合わせ種別を取得',
      responses: { '200': { description: 'Supported inquiry kinds' } },
    },
  },
  '/api/hq/support/requests': {
    get: {
      tags: ['HQ Support'], summary: '統括の問い合わせ履歴を取得',
      responses: { '200': { description: 'Tenant-scoped support requests' } },
    },
    post: {
      tags: ['HQ Support'], summary: '運営への問い合わせを登録',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['kind', 'subject', 'body'], properties: { kind: { type: 'string' }, subject: { type: 'string', maxLength: 100 }, body: { type: 'string', maxLength: 4000 }, lineAccountId: { type: 'string' }, attachments: { type: 'array', maxItems: 3, items: { type: 'object' } } } } } } },
      responses: { '201': { description: 'Recorded; notification result is included' }, '400': { description: 'Invalid request' }, '403': { description: 'Read-only staff cannot submit' }, '404': { description: 'Line account not found in tenant scope' } },
    },
  },
  // ── Ops Console（★37 運営コンソール）─────────────────────────────
  '/api/hq/support/requests/{id}': {
    get: { tags: ['HQ Support'], summary: 'お問い合わせ 1 件のやり取り（★V6 36-3-A）', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Request with messages' }, '404': { description: 'Not found' } } },
  },
  '/api/hq/support/requests/{id}/messages': {
    post: { tags: ['HQ Support'], summary: 'お問い合わせの続きを送る（運営へ通知・控えを送信）', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['body'], properties: { body: { type: 'string' }, attachments: { type: 'array', items: { type: 'object' } } } } } } }, responses: { '201': { description: 'Message added' }, '400': { description: 'Validation error' }, '404': { description: 'Not found' }, '413': { description: 'Attachment too large' } } },
  },
  '/api/ops/me': {
    get: { tags: ['Ops Console'], summary: 'ログイン中の運営マスター', responses: { '200': { description: 'Platform admin identity and active impersonation' }, '403': { description: 'Not a platform admin' } } },
  },
  '/api/ops/applications': {
    get: { tags: ['Ops Console'], summary: '申込アカウント一覧', responses: { '200': { description: 'Applications' }, '403': { description: 'Platform admin required' } } },
  },
  '/api/ops/applications/{id}': {
    get: { tags: ['Ops Console'], summary: '申込アカウント詳細', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Application detail' }, '404': { description: 'Application not found' } } },
  },
  '/api/ops/applications/{id}/contact': {
    post: { tags: ['Ops Console'], summary: '申込先への対応メモを保存', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Contact recorded' }, '403': { description: 'Platform admin required' } } },
  },
  '/api/ops/applications/{id}/approve': {
    post: { tags: ['Ops Console'], summary: '申込を承認し招待メールを送信', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Approved and invitation requested' }, '403': { description: 'Platform admin required' } } },
  },
  '/api/ops/applications/{id}/resend-invite': {
    post: { tags: ['Ops Console'], summary: '承認済み申込の招待メールを再送', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Invitation requested' }, '403': { description: 'Platform admin required' } } },
  },
  '/api/ops/tenants': {
    get: { tags: ['Ops Console'], summary: '契約先（統括）の一覧', parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }, { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'suspended', 'archived'] } }], responses: { '200': { description: 'Tenants with counts and summary' }, '403': { description: 'Not a platform admin' } } },
  },
  '/api/ops/tenants/{id}': {
    get: { tags: ['Ops Console'], summary: '契約先の詳細', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Tenant, accounts, members, recent audit' }, '404': { description: 'Tenant not found' } } },
  },
  '/api/ops/tenants/{id}/status': {
    patch: { tags: ['Ops Console'], summary: '契約先の状態を変更（停止・アーカイブ・再開）', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['status', 'reason'], properties: { status: { type: 'string', enum: ['active', 'suspended', 'archived'] }, reason: { type: 'string', minLength: 4, maxLength: 500 }, confirmName: { type: 'string' } } } } } }, responses: { '200': { description: 'Status changed; audit recorded (visible to tenant)' }, '400': { description: 'Missing reason or name confirmation' }, '403': { description: 'Read-only or not a platform admin' } } },
  },
  '/api/ops/tenants/{id}/feature-packs': {
    patch: { tags: ['Ops Console'], summary: '契約先の機能パック（飲食店機能）を切り替える', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['featurePacks'], properties: { featurePacks: { type: 'array', items: { type: 'string', enum: ['restaurant'] } } } } } } }, responses: { '200': { description: 'Feature packs changed; audit recorded (visible to tenant)' }, '400': { description: 'Unknown feature pack' }, '403': { description: 'Read-only or not a platform admin' }, '404': { description: 'Tenant not found' } } },
  },
  '/api/ops/impersonation/current': {
    get: { tags: ['Ops Console'], summary: '有効な代理ログイン', responses: { '200': { description: 'Active impersonation or null' } } },
  },
  '/api/ops/impersonation/start': {
    post: { tags: ['Ops Console'], summary: '代理ログインを開始（既定は閲覧のみ）', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['tenantId'], properties: { tenantId: { type: 'string' } } } } } }, responses: { '200': { description: 'Impersonation started in read mode' }, '400': { description: 'Archived tenant' }, '404': { description: 'Tenant not found' } } },
  },
  '/api/ops/impersonation/write': {
    post: { tags: ['Ops Console'], summary: '書き込みに切り替える（理由必須）', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 4, maxLength: 500 }, expectedSessionId: { type: 'string', description: '確認時の代理ログインID（任意）' } } } } } }, responses: { '200': { description: 'Switched to write mode; audit visible to tenant' }, '400': { description: 'Missing reason or not impersonating' }, '409': { description: 'Impersonation changed after confirmation' } } },
  },
  '/api/ops/impersonation/read': {
    post: { tags: ['Ops Console'], summary: '閲覧のみに戻す', responses: { '200': { description: 'Switched to read mode' }, '400': { description: 'Not impersonating' } } },
  },
  '/api/ops/impersonation/pii-reveal': {
    post: { tags: ['Ops Console'], summary: '個人情報を一時的に表示（理由必須）', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 4, maxLength: 500 }, expectedSessionId: { type: 'string', description: '確認時の代理ログインID（任意）' } } } } } }, responses: { '200': { description: 'PII revealed for this impersonation; logged' }, '400': { description: 'Missing reason or not impersonating' }, '409': { description: 'Impersonation changed after confirmation' } } },
  },
  '/api/ops/impersonation/end': {
    post: { tags: ['Ops Console'], summary: '代理ログインを終える', responses: { '200': { description: 'Ended (or nothing active)' } } },
  },
  '/api/ops/audit': {
    get: { tags: ['Ops Console'], summary: '運営の操作記録', parameters: [{ name: 'tenant_id', in: 'query', schema: { type: 'string' } }, { name: 'action', in: 'query', schema: { type: 'string' } }, { name: 'from', in: 'query', schema: { type: 'string' } }, { name: 'to', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }, { name: 'offset', in: 'query', schema: { type: 'integer' } }], responses: { '200': { description: 'Audit rows and total' } } },
  },
  '/api/ops/members': {
    get: { tags: ['Ops Console'], summary: '運営メンバーの一覧', responses: { '200': { description: 'Platform admins and monthly summary' } } },
    post: { tags: ['Ops Console'], summary: '既存の権限者を運営メンバーに加える', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { staffId: { type: 'string' }, email: { type: 'string' } } } } } }, responses: { '201': { description: 'Added; approved by the caller' }, '400': { description: 'Cannot add yourself' }, '404': { description: 'Staff not found' } } },
  },
  '/api/ops/members/{staffId}/resend-invite': {
    post: { tags: ['Ops Console'], summary: '招待メールを送り直す（招待中・2要素認証待ちの人だけ）', parameters: [{ name: 'staffId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Resent' }, '400': { description: 'Already active' }, '404': { description: 'Invite not found' } } },
  },
  '/api/ops/members/{staffId}': {
    patch: { tags: ['Ops Console'], summary: '運営メンバーの停止・再開', parameters: [{ name: 'staffId', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['isActive'], properties: { isActive: { type: 'boolean' } } } } } }, responses: { '200': { description: 'Updated' }, '400': { description: 'Self or last member' }, '404': { description: 'Staff not found' } } },
  },
  // ── HQ Notices / Ops Announcements（★37-7） ────────────────────────
  '/api/hq/notices': {
    get: { tags: ['HQ Support'], summary: '運営からの未読のお知らせ（画面のお知らせ）', responses: { '200': { description: 'Unread notices for the caller' } } },
  },
  '/api/hq/notices/{id}/read': {
    post: { tags: ['HQ Support'], summary: 'お知らせを既読にする', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Marked' } } },
  },
  '/api/hq/notices/line-registration': {
    get: { tags: ['HQ Support'], summary: '契約者専用LINEの登録案内（友だち追加 URL と本人の確認コード）', responses: { '200': { description: 'Registration info' } } },
  },
  '/api/hq/notices/line-registration/status': {
    get: { tags: ['HQ Support'], summary: '本人の通知専用LINE紐づけ状態', responses: { '200': { description: 'Linked status' } } },
  },
  '/api/ops/notice-line-account': {
    get: { tags: ['Ops Console'], summary: '契約者専用LINEに使うアカウントと候補', responses: { '200': { description: 'Current and candidates' } } },
    put: { tags: ['Ops Console'], summary: '契約者専用LINEに使うアカウントを指定する', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { lineAccountId: { type: 'string', nullable: true } } } } } }, responses: { '200': { description: 'Saved' }, '400': { description: 'Not an ops account' } } },
  },
  '/api/ops/notice-line-account/connect': {
    post: { tags: ['Ops Console'], summary: '運営通知用LINEアカウントを接続', responses: { '200': { description: 'Connected' }, '403': { description: 'Platform admin required' } } },
  },
  '/api/ops/announcements': {
    get: { tags: ['Ops Console'], summary: 'お知らせの一覧（下書き・予約・配信済み）', responses: { '200': { description: 'Announcements' } } },
    post: { tags: ['Ops Console'], summary: 'お知らせを作る（下書き／予約／今すぐ送る）', parameters: [{ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' }, description: '二重押し止めの再実行キー（UUID）。同じキー・同じ内容の再送は保存済みを返し、別内容は409。' }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['subject', 'body', 'channels'], properties: { subject: { type: 'string' }, body: { type: 'string' }, audienceKind: { type: 'string', enum: ['all', 'plan', 'tenants'] }, audiencePlans: { type: 'array', items: { type: 'string' } }, audienceTenantIds: { type: 'array', items: { type: 'string' } }, channels: { type: 'array', items: { type: 'string', enum: ['line', 'screen', 'email'] } }, publishAt: { type: 'string' }, mode: { type: 'string', enum: ['draft', 'schedule', 'send'] } } } } } }, responses: { '200': { description: 'Idempotent replay of the saved announcement' }, '201': { description: 'Created' }, '400': { description: 'Validation error' }, '409': { description: 'Notice LINE account missing or idempotency-key reuse with different content' } } },
  },
  '/api/ops/knowledge': {
    get: { tags: ['Ops Console'], summary: '運営専用ナレッジ一覧（検索・種別・承認状態・ページ送り）', responses: { '200': { description: 'Articles and total' }, '403': { description: 'Platform admin required' } } },
  },
  '/api/ops/knowledge/{id}': {
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    get: { tags: ['Ops Console'], summary: 'ナレッジ記事と解決根拠', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Article' }, '404': { description: 'Not found' } } },
    put: { tags: ['Ops Console'], summary: 'ナレッジ記事を編集（承認失効・版照合）', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Updated' }, '409': { description: 'Version conflict' } } },
  },
  '/api/ops/knowledge/{id}/review': {
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    post: { tags: ['Ops Console'], summary: '根拠確認後の承認・見送り・無効化（版照合）', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Reviewed' }, '400': { description: 'Confirmation required' }, '409': { description: 'Source or version changed' } } },
  },
  '/api/ops/knowledge/{id}/feedback': {
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    post: { tags: ['Ops Console'], summary: '参照した記事の評価', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Feedback recorded' }, '409': { description: 'Usage not found or changed' } } },
  },
  '/api/ops/knowledge/tickets/{id}/process': {
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    post: { tags: ['Ops Console'], summary: '対象の解決済み問い合わせのナレッジ生成予約を実行（運営書込権限必須・二重実行防止）', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Current knowledge and job state' }, '403': { description: 'Forbidden' }, '404': { description: 'Ticket not found' }, '503': { description: 'AI unavailable' } } },
  },
  '/api/ops/knowledge/tickets/{id}/retry': {
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    post: { tags: ['Ops Console'], summary: '失敗した記事生成の再試行を予約', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '202': { description: 'Queued' }, '409': { description: 'Not retryable' } } },
  },
  '/api/ops/announcements/preview': {
    post: { tags: ['Ops Console'], summary: '宛先の見積もり（契約先数・権限者数・LINE登録済み数）', responses: { '200': { description: 'Audience preview' } } },
  },
  '/api/ops/announcements/{id}': {
    put: { tags: ['Ops Console'], summary: '下書き・予約のお知らせを変える（今すぐ送るも可）', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { expectedUpdatedAt: { type: 'string', description: '一覧で見た版。違う版からの保存は最新の内容つきで409。' } } } } } }, responses: { '200': { description: 'Updated' }, '404': { description: 'Not found' }, '409': { description: 'Already sent or version conflict with the latest content' } } },
    delete: { tags: ['Ops Console'], summary: '下書き・予約のお知らせを消す', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Deleted' }, '404': { description: 'Not found' }, '409': { description: 'Already sent' } } },
  },
  // ── Ops Console: ダッシュボード（★37-2） ────────────────────────────
  '/api/ops/dashboard': {
    get: { tags: ['Ops Console'], summary: '運営ダッシュボード（Stripe入金実績・契約中の月額合計・要対応・チケット・LINE登録・使用量）', parameters: [
      { name: 'period', in: 'query', required: false, schema: { type: 'string', enum: ['month', 'prev_month', 'year'] } },
    ], responses: { '200': { description: 'Dashboard aggregates' } } },
  },
  '/api/ops/billing/sync': {
    post: { tags: ['Ops Console'], summary: 'Stripe の請求書を過去1〜12か月分同期する', requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { months: { type: 'integer', minimum: 1, maximum: 12 } } } } } }, responses: { '200': { description: 'Sync result' }, '400': { description: 'Invalid months' }, '503': { description: 'Stripe not configured' } } },
  },
  '/api/ops/dashboard/line-unregistered': {
    get: { tags: ['Ops Console'], summary: 'LINE 未登録の権限者（名前と契約先だけ）', responses: { '200': { description: 'Unregistered staff' } } },
  },
  '/api/ops/dashboard/first-run': {
    get: { tags: ['Ops Console'], summary: '最初の10分の全アカウントのまとめ（数と割合だけ・閲覧のみと代理ログイン中は403）', parameters: [
      { name: 'period', in: 'query', required: false, schema: { type: 'string', enum: ['month', 'prev_month', 'year'] } },
    ], responses: { '200': { description: 'Funnel counts and minutes to the first message' }, '403': { description: 'Forbidden' } } },
  },
  // ── Ops Console: お問い合わせ（★37-6） ────────────────────────────
  '/api/ops/support/summary': {
    get: { tags: ['Ops Console'], summary: 'お問い合わせの状態別件数と数値カード（未対応・初回返信・解決率・解決時間）', responses: { '200': { description: 'Counts by stage and KPIs' } } },
  },
  '/api/ops/support/tickets': {
    get: { tags: ['Ops Console'], summary: 'チケット一覧（状態・優先度・検索・並び替え）', parameters: [
      { name: 'stage', in: 'query', required: false, schema: { type: 'string', enum: ['all', 'new', 'in_progress', 'waiting', 'resolved', 'closed'] } },
      { name: 'priority', in: 'query', required: false, schema: { type: 'string', enum: ['low', 'medium', 'high'] } },
      { name: 'q', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'sort', in: 'query', required: false, schema: { type: 'string', enum: ['newest', 'oldest', 'priority'] } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
      { name: 'offset', in: 'query', required: false, schema: { type: 'integer' } },
    ], responses: { '200': { description: 'Tickets with total' } } },
    post: { tags: ['Ops Console'], summary: '運営が代わりに起票する', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['tenantId', 'subject', 'body'], properties: { tenantId: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, kind: { type: 'string' }, priority: { type: 'string', enum: ['low', 'medium', 'high'] }, channel: { type: 'string', enum: ['ops', 'line'] }, staffId: { type: 'string' } } } } } }, responses: { '201': { description: 'Created' }, '400': { description: 'Validation error' }, '404': { description: 'Staff not found' } } },
  },
  '/api/ops/support/tickets/{id}': {
    get: { tags: ['Ops Console'], summary: 'チケットの内容・やり取り・下書き・契約先の状況（閲覧を監査に記録）', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Ticket detail' }, '404': { description: 'Not found' } } },
    patch: { tags: ['Ops Console'], summary: '状態・優先度を変える', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { stage: { type: 'string', enum: ['new', 'in_progress', 'waiting', 'resolved', 'closed'] }, priority: { type: 'string', enum: ['low', 'medium', 'high'] } } } } } }, responses: { '200': { description: 'Updated' }, '400': { description: 'Validation error' }, '404': { description: 'Not found' } } },
  },
  '/api/ops/support/tickets/{id}/reply': {
    post: { tags: ['Ops Console'], summary: '返信する（登録メールへ送り、統括の履歴に載せる）', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['body'], properties: { body: { type: 'string' }, nextStage: { type: 'string' }, aiAssisted: { type: 'boolean' } } } } } }, responses: { '201': { description: 'Replied' }, '400': { description: 'Validation error' }, '404': { description: 'Not found' }, '409': { description: 'Closed ticket' } } },
  },
  '/api/ops/support/tickets/{id}/draft': {
    put: { tags: ['Ops Console'], summary: '返信の下書きを保存する（空なら削除）', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { body: { type: 'string' } } } } } }, responses: { '200': { description: 'Saved' }, '404': { description: 'Not found' } } },
    delete: { tags: ['Ops Console'], summary: '返信の下書きを消す', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Deleted' }, '404': { description: 'Not found' } } },
  },
  '/api/ops/support/tickets/{id}/draft/ai': {
    post: { tags: ['Ops Console'], summary: 'AI（Workers AI）で返信の下書きを作る', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '201': { description: 'Draft generated' }, '404': { description: 'Not found' }, '502': { description: 'AI failed' }, '503': { description: 'AI not configured' } } },
  },
  '/api/hq/operator-history': {
    get: { tags: ['HQ Support'], summary: '契約先から見える運営の操作履歴（書き込みを伴ったものだけ）', responses: { '200': { description: 'Visible operator actions for the caller tenant' } } },
  },
};
