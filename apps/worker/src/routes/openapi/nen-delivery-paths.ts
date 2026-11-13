// 実行時の副作用を混ぜず定義だけを置き、ハンドラは各機能の経路に保つ。
export const nenDeliveryPaths = {
  // ── NEN delivery ────────────────────────────────────────────────────────
  '/api/nen-campaigns/metrics/flows': {
    get: {
      tags: ['NEN delivery'],
      summary: 'NEN配信フローの実績を取得',
      description: '開封率は取得できないためnull、関連成果は送信後7日以内の相関として返します。',
      parameters: [
        { name: 'lineAccountId', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'days', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 365, default: 30 } },
        { name: 'from', in: 'query', description: 'to と両方指定で days の代わりに期間を決める（ISO 8601）', schema: { type: 'string', format: 'date-time' } },
        { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
      ],
      responses: { '200': { description: 'Flow metrics' }, '403': { description: 'Account access denied' } },
    },
  },
  '/api/nen-campaigns/metrics/columns': {
    get: {
      tags: ['NEN delivery'],
      summary: 'NENコラムの配信・記事閲覧実績を取得',
      description: '計測台帳がない記事閲覧と、未収集の読了率はnullで返します。',
      parameters: [
        { name: 'lineAccountId', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'days', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 365, default: 30 } },
        { name: 'from', in: 'query', description: 'to と両方指定で days の代わりに期間を決める（ISO 8601）', schema: { type: 'string', format: 'date-time' } },
        { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
      ],
      responses: { '200': { description: 'Column metrics' }, '403': { description: 'Account access denied' } },
    },
  },
  '/api/nen-campaigns/metrics/pets': {
    get: {
      tags: ['NEN delivery'],
      summary: 'ペット登録・誕生日クーポン実績を取得',
      parameters: [
        { name: 'lineAccountId', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'days', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 365, default: 30 } },
      ],
      responses: { '200': { description: 'Pet and birthday coupon metrics' }, '403': { description: 'Account access denied' } },
    },
  },
  '/api/nen-campaigns/deliveries': {
    get: {
      tags: ['NEN delivery'],
      summary: 'NEN配信履歴を取得',
      parameters: [
        { name: 'lineAccountId', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
        { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
        { name: 'days', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 365, default: 30 } },
        { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'processing', 'sent', 'skipped', 'failed', 'cancelled'] } },
        { name: 'q', in: 'query', description: '宛先名・配信名の検索語。履歴全体を検索する', schema: { type: 'string' } },
        { name: 'cursor', in: 'query', schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
      ],
      responses: { '200': { description: 'Scoped delivery history' }, '403': { description: 'Account access denied' } },
    },
  },
  '/api/nen-campaigns/deliveries/{id}': {
    get: {
      tags: ['NEN delivery'],
      summary: 'NEN配信履歴の安全な詳細を取得',
      description: '注文情報やクーポンコードを含むraw payloadは返しません。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'lineAccountId', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: { '200': { description: 'Delivery detail' }, '404': { description: 'Not found in account scope' } },
    },
  },
  '/api/nen-campaigns/columns/{id}/send-preview': {
    get: {
      tags: ['NEN delivery'],
      summary: 'コラムの配信内容と予約対象を確認',
      description: '送信待ちに入っていない、配信可能な対象の人数と照合用の印を返す。個々のLINE宛先は返さない。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'lineAccountId', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: { '200': { description: '人数、照合用の印と現在の配信内容' }, '403': { description: '配信権限なし' }, '404': { description: '対象が見つからない' }, '409': { description: '配信が停止中' } },
    },
  },
  '/api/nen-campaigns/columns/{id}/deliver': {
    post: {
      tags: ['NEN delivery'],
      summary: '確認したコラムを配信待ちへ入れる',
      description: '確認した人数と印を両方指定すると、内容・対象の変更時は409を返して予約しない。どちらも省略した旧呼び出しは従来どおり。',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['accountId'], properties: {
        accountId: { type: 'string' }, scheduledAt: { type: 'string', format: 'date-time' },
        recipientCount: { type: 'integer', minimum: 0 }, confirmationToken: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      } } } } },
      responses: { '200': { description: '予約した人数' }, '400': { description: '入力が不正' }, '403': { description: '配信権限なし' }, '409': { description: '確認後に内容または対象が変化' } },
    },
  },
  '/api/nen-campaigns/columns/import': {
    post: {
      tags: ['NEN delivery'],
      summary: '未割り当てのECコラムを選択中のLINEアカウントへ取り込む',
      description: 'EC-CUBE から届いたが宛先が決まらなかったコラム（line_account_id が NULL）を、lineAccountId のアカウントへ割り当てます。',
      parameters: [{ name: 'lineAccountId', in: 'query', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: '{ imported: number }' },
        '403': { description: 'Owner or admin role required' },
        '404': { description: 'LINE account not found' },
      },
    },
  },
  '/api/integrations/eccube/coupon-usages': {
    post: {
      tags: ['NEN delivery'],
      summary: 'ECから届く誕生日クーポン利用の記録',
      description: 'HMAC署名で検証する公開口。発行台帳の used_at を立て、注文として成果計測へもつなげる。同じコードの再送は上書きしない。',
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object',
        required: ['code'],
        properties: {
          code: { type: 'string', maxLength: 64 },
          used_at: { type: 'string', format: 'date-time' },
          order_number: { type: 'string', maxLength: 64 },
          event_id: { type: 'string', maxLength: 255 },
        },
      } } } },
      responses: {
        '200': { description: 'Usage recorded (or already recorded)' },
        '400': { description: 'Invalid payload' },
        '401': { description: 'Invalid signature' },
        '404': { description: 'Unknown coupon code' },
        '503': { description: 'Integration not configured' },
      },
    },
  },
  '/api/integrations/google-sheets/connection': {
    get: {
      tags: ['External integrations'],
      summary: 'Google Sheets連携の接続状態（接続中・要再接続・未接続）と直近の同期状況',
      parameters: [
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: 'Connection status' },
        '403': { description: 'owner/admin required' },
        '404': { description: 'Account not in scope' },
      },
    },
  },
  '/api/integrations/google-sheets/runs': {
    get: {
      tags: ['External integrations'],
      summary: 'Google Sheets同期の直近10件（手動・定期・結果・書き込み行数）',
      parameters: [
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: 'Recent sync runs' },
        '403': { description: 'owner/admin required' },
        '404': { description: 'Account not in scope' },
      },
    },
  },
  '/api/integrations/google-sheets/connect/start': {
    post: {
      tags: ['External integrations'],
      summary: 'Google Sheets連携の認可を開始（state発行＋Google認可URLを返す）',
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object',
        required: ['accountId'],
        properties: { accountId: { type: 'string' } },
      } } } },
      responses: {
        '200': { description: 'Authorize URL issued' },
        '403': { description: '統括の管理者権限が必要' },
        '404': { description: 'Account not in scope' },
        '503': { description: 'OAuth client not configured' },
      },
    },
  },
  '/api/integrations/google-sheets/oauth/callback': {
    get: {
      tags: ['External integrations'],
      summary: 'Google認可の戻り口。stateを検証してトークンを暗号化保存し、管理画面へ戻す',
      parameters: [
        { name: 'state', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'code', in: 'query', required: false, schema: { type: 'string' } },
      ],
      responses: {
        '302': { description: '成功・失敗どちらも結果クエリ付きで管理画面へ302で戻す' },
        '403': { description: '統括の管理者権限が必要' },
        // 契約上2xxまたはdefaultが要るため明記。実際は常に302で、本体のJSON応答は無い。
        'default': { description: '302リダイレクトのみ返す' },
      },
    },
  },
  '/api/integrations/google-sheets/disconnect': {
    post: {
      tags: ['External integrations'],
      summary: 'Google Sheets連携を解除（Google側revoke＋連携行の削除）',
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object',
        required: ['accountId', 'confirmed'],
        properties: { accountId: { type: 'string' }, confirmed: { type: 'boolean' } },
      } } } },
      responses: {
        '200': { description: 'Disconnected' },
        '400': { description: 'Confirmation required' },
        '403': { description: '統括の管理者権限が必要' },
        '409': { description: 'Not connected' },
      },
    },
  },
  '/api/integrations/google-sheets/target': {
    put: {
      tags: ['External integrations'],
      summary: '書き出し先スプレッドシートを設定（URLまたはID。保存前にアクセス可否を検証）',
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object',
        required: ['accountId', 'spreadsheet'],
        properties: { accountId: { type: 'string' }, spreadsheet: { type: 'string' } },
      } } } },
      responses: {
        '200': { description: 'Target saved' },
        '400': { description: 'Invalid spreadsheet URL/ID' },
        '403': { description: '統括の管理者権限が必要' },
        '404': { description: 'Spreadsheet not found' },
        '409': { description: 'Not connected or permission denied' },
      },
    },
  },
  '/api/integrations/google-sheets/sync': {
    post: {
      tags: ['External integrations'],
      summary: 'Google Sheetsへ今すぐ同期（全データ種別・増分upsert）',
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object',
        required: ['accountId'],
        properties: { accountId: { type: 'string' } },
      } } } },
      responses: {
        '200': { description: 'Sync result per data type' },
        '403': { description: '統括の管理者権限が必要' },
        '409': { description: 'Not connected / auth expired' },
      },
    },
  },
  '/api/integrations/tiktok-pnl/status': {
    get: {
      tags: ['External integrations'],
      summary: 'TikTok利益計算シートの状態（シートURL・最終同期・未反映行数・エラー）',
      parameters: [
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: 'TikTok PnL sheet status' },
        '400': { description: 'account_id required' },
        '403': { description: 'owner/admin required' },
      },
    },
  },
  '/api/integrations/tiktok-pnl/sync': {
    post: {
      tags: ['External integrations'],
      summary: 'TikTok利益計算シートへ今すぐ同期（EC取り込み＋差分行の書き出し）',
      parameters: [
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: 'Sync result' },
        '400': { description: 'account_id required' },
        '403': { description: 'owner/admin required' },
        '409': { description: 'Google Sheets連携が未接続' },
        '502': { description: 'Sync failed' },
      },
    },
  },
  '/api/ec-commerce/orders/{id}': {
    get: {
      tags: ['NEN delivery'],
      summary: 'EC注文1件の処理状況（届いた出来事・通知・発送後の案内・成果/マイル/スコア）',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'lineAccountId', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: 'Order processing detail' },
        '400': { description: 'LINE account is required' },
        '403': { description: 'ec.event.view permission or account scope required' },
        '404': { description: 'Order not found in account scope' },
      },
    },
  },
  '/api/nen-campaigns/pets': {
    post: {
      tags: ['NEN delivery'],
      summary: 'ペットの登録（管理画面）',
      description: '誕生日は YYYY-MM-DD か MM-DD（月日だけ）。生まれた年が分からない子も誕生日配信の対象にする。',
      parameters: [
        { name: 'lineAccountId', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' }, description: '二重押し止めの再実行キー（UUID）。同じキー・同じ内容の再送は保存済みを返し、別内容は409。' },
      ],
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object',
        required: ['friendId', 'name'],
        properties: {
          friendId: { type: 'string' },
          name: { type: 'string', maxLength: 80 },
          animalType: { type: 'string', enum: ['dog', 'cat', 'other'] },
          gender: { type: 'string', enum: ['male', 'female', 'unknown'] },
          birthday: { type: 'string', description: 'YYYY-MM-DD または MM-DD' },
          breed: { type: 'string', maxLength: 80 },
          weightKg: { type: 'number', minimum: 0.1, maximum: 200, nullable: true },
          customerId: { type: 'string', nullable: true },
        },
      } } } },
      responses: {
        '200': { description: 'Idempotent replay of the saved pet' },
        '201': { description: 'Created' },
        '400': { description: 'Invalid input' },
        '403': { description: 'Owner or admin role required' },
        '404': { description: 'Friend not found in account scope' },
        '409': { description: 'Idempotency-key reuse with different content' },
      },
    },
  },
  '/api/nen-campaigns/pets/{id}': {
    put: {
      tags: ['NEN delivery'],
      summary: 'ペット情報の更新（管理画面）',
      description: '誕生日を変えると、古い日付へ予約済みの誕生日クーポン配信は取消し、次の日次処理で組み直す。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'lineAccountId', in: 'query', required: true, schema: { type: 'string' } },
      ],
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', maxLength: 80 },
          animalType: { type: 'string', enum: ['dog', 'cat', 'other'] },
          gender: { type: 'string', enum: ['male', 'female', 'unknown'] },
          birthday: { type: 'string', description: 'YYYY-MM-DD または MM-DD' },
          breed: { type: 'string', maxLength: 80 },
          weightKg: { type: 'number', minimum: 0.1, maximum: 200, nullable: true },
          expectedUpdatedAt: { type: 'string', description: '一覧で見た版。違う版からの保存は最新の内容つきで409。' },
        },
      } } } },
      responses: {
        '200': { description: 'Updated' },
        '400': { description: 'Invalid input' },
        '403': { description: 'Owner or admin role required' },
        '404': { description: 'Pet not found in account scope' },
        '409': { description: 'Version conflict with the latest content' },
      },
    },
  },
  '/api/nen-campaigns/deliveries/{id}/retry': {
    post: {
      tags: ['NEN delivery'],
      summary: '恒久失敗したNEN配信を手動再送',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object',
        required: ['lineAccountId', 'expectedVersion', 'reason'],
        properties: {
          lineAccountId: { type: 'string' },
          expectedVersion: { type: 'integer', minimum: 1 },
          reason: { type: 'string', minLength: 1, maxLength: 500 },
        },
      } } } },
      responses: {
        '200': { description: 'Retry queued with a new idempotency generation' },
        '403': { description: 'Owner or admin role required' },
        '404': { description: 'Not found in account scope' },
        '409': { description: 'Retry unavailable or version conflict' },
      },
    },
  },
};
