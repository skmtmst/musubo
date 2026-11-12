// 実行時の副作用を混ぜず定義だけを置き、ハンドラは各機能の経路に保つ。
export const nenMembersPaths = {
  // ── NEN Members (会員ランク・ライフタイム・マイル ★37-1) ──────────────
  '/api/public/nen/adopted-photos': {
    get: {
      tags: ['NEN Members'],
      summary: '公開許可済みでサイト掲載中の採用写真を取得',
      security: [],
      parameters: [
        {
          name: 'lineAccountId', in: 'query', required: false,
          description: '内部LINEアカウントID。officialAccountBasicIdと両方指定した場合は同じアカウントであることが必要',
          schema: { type: 'string' },
        },
        {
          name: 'officialAccountBasicId', in: 'query', required: false,
          description: 'LINE公式アカウントのBasic ID。前後の空白を除いた完全一致で、有効かつ未アーカイブの一意なアカウントだけを選択',
          schema: { type: 'string' },
        },
      ],
      responses: {
        '200': { description: 'Public photos for the selected LINE account' },
        '400': { description: 'Selector missing or selectors do not match' },
        '404': { description: 'No unique active LINE account matches the Basic ID' },
      },
    },
  },
  '/api/nen/rank-settings': {
    get: {
      tags: ['NEN Members'], summary: '会員ランク設定（ランク・決まり方・ライフタイムの節目・数値）を取得',
      parameters: [{ name: 'accountId', in: 'query', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Rank settings, rules, lifetime milestones and KPIs' }, '400': { description: 'accountId is required' }, '403': { description: 'Account not visible' } },
    },
    put: {
      tags: ['NEN Members'], summary: 'ランク（名前・通年のしきい値・マイル還元）を一括保存し、ECへ同期してタグを付け替える',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['accountId', 'ranks'], properties: { accountId: { type: 'string' }, ranks: { type: 'array', maxItems: 8, items: { type: 'object', required: ['name', 'annualThresholdYen', 'mileRatePercent'], properties: { id: { type: 'string', nullable: true }, name: { type: 'string', maxLength: 20 }, annualThresholdYen: { type: 'integer', minimum: 0 }, mileRatePercent: { type: 'number', minimum: 0, maximum: 10 } } } } } } } } },
      responses: { '200': { description: 'Saved settings with sync result' }, '400': { description: 'Validation failed' }, '403': { description: 'Owner or admin role required' } },
    },
  },
  '/api/nen/rank-settings/initialize': {
    post: {
      tags: ['NEN Members'], summary: '初期ランクとランク用タグを用意して設定を取得する',
      description: 'オーナーまたは管理者が操作できます。accountId は本文またはクエリに指定します。',
      parameters: [{ name: 'accountId', in: 'query', required: false, schema: { type: 'string' } }],
      requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { accountId: { type: 'string' } } } } } },
      responses: { '200': { description: '初期化後のランク設定' }, '400': { description: 'accountId が必要' }, '403': { description: '権限またはアカウントへのアクセスがない' } },
    },
  },
  '/api/nen/rank-settings/{id}': {
    delete: {
      tags: ['NEN Members'], summary: 'ランクを削除し、会員を移し先へ変更する',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['accountId', 'expectedVersion'],
        properties: { accountId: { type: 'string' }, replacementRankId: { type: 'string', nullable: true }, expectedVersion: { type: 'integer', minimum: 1 }, confirmedMembers:{type:'array',description:'確認した移動対象。省略時は従来どおり。',items:{type:'object',required:['friendId','customerId'],properties:{friendId:{type:'string'},customerId:{type:'string',nullable:true}}}} } } } } },
      responses: { '200': { description: '移し替え件数、操作ID、ECの成功・失敗・同期待ち件数と会員別の理由。未設定ならECへ送らずpending' },
        '400': { description: '入力不備' }, '403': { description: 'オーナーまたは管理者権限が必要' },
        '404': { description: 'ランクが見つからない' }, '409': { description: '版の競合または削除不可' } },
    },
  },
  '/api/nen/rank-settings/{id}/delete-preview': {
    get:{tags:['NEN Members'],summary:'ランク削除で移す会員の集合と人数を確認する',parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}},{name:'accountId',in:'query',required:true,schema:{type:'string'}}],responses:{'200':{description:'現在の会員、人数、設定の版'},'403':{description:'権限不足'},'404':{description:'ランクが見つからない'}}},
  },
  '/api/nen/rank-settings/member-sync/{operationId}': {
    get: {
      tags: ['NEN Members'], summary: '保存した会員別EC送信の結果と失敗理由を取得する',
      parameters: [{ name: 'operationId', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'accountId', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'afterId', in: 'query', schema: { type: 'string' } }],
      responses: { '200': { description: '操作全体の件数、会員別の結果（100人まで）、次のページのnextCursor' },
        '403': { description: 'オーナーまたは管理者権限が必要' }, '404': { description: '記録が見つからない' } },
    },
  },
  '/api/nen/rank-settings/member-sync/{operationId}/retry': {
    post: {
      tags: ['NEN Members'], summary: '未成功の会員を最初の版・担当者・鍵でECへ送り直す（1回100人まで）',
      parameters: [{ name: 'operationId', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['accountId'],
        properties: { accountId: { type: 'string' } } } } } },
      responses: { '200': { description: '成功・失敗・同期待ちの件数と理由。成功済みは再送しない。送信停止中はpending' },
        '403': { description: 'オーナーまたは管理者権限が必要' }, '404': { description: '記録が見つからない' } },
    },
  },
  '/api/nen/rank-settings/resync': {
    post: {
      tags: ['NEN Members'], summary: 'ランク設定をECへ送り直す',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['accountId'], properties: { accountId: { type: 'string' } } } } } },
      responses: { '200': { description: 'Settings with sync result' }, '403': { description: 'Owner or admin role required' } },
    },
  },
  '/api/nen/lifetime-milestones': {
    put: {
      tags: ['NEN Members'], summary: 'ライフタイム（累計購入額）の節目を一括保存し、ECへ同期',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['accountId', 'milestones'], properties: { accountId: { type: 'string' }, milestones: { type: 'array', maxItems: 12, items: { type: 'object', required: ['thresholdYen', 'title'], properties: { id: { type: 'string', nullable: true }, thresholdYen: { type: 'integer', minimum: 1 }, title: { type: 'string', maxLength: 30 }, notifyOnReach: { type: 'boolean' } } } } } } } } },
      responses: { '200': { description: 'Saved milestones with sync result' }, '400': { description: 'Validation failed' }, '403': { description: 'Owner or admin role required' } },
    },
  },
  '/api/nen/members': {
    get: {
      tags: ['NEN Members'], summary: '会員一覧（ランク・通年・ライフタイム・マイル残高・ペット）を取得',
      parameters: [
        { name: 'accountId', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'rank', in: 'query', schema: { type: 'string' } },
        { name: 'ranks', in: 'query', schema: { type: 'string', description: '「○○以上」の札：区切りに合うランクキーをカンマ区切り。rank より優先' } },
        { name: 'link', in: 'query', schema: { type: 'string', enum: ['linked', 'unlinked'] } },
        { name: 'pet', in: 'query', schema: { type: 'string', enum: ['any', 'with', 'without'] } },
        { name: 'q', in: 'query', schema: { type: 'string' } },
        { name: 'sort', in: 'query', schema: { type: 'string', enum: ['annual_desc', 'lifetime_desc', 'balance_desc', 'recent'] } },
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
        { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
      ],
      responses: { '200': { description: 'Paged members with KPIs (petMembers, monthPurchaseYen, monthBuyers) and rank definitions' }, '400': { description: 'accountId is required' }, '403': { description: 'Account not visible' } },
    },
  },
  '/api/nen/feeding-products': {
    get: {
      tags: ['NEN Members'], summary: '主食のカロリー表（マイペットの「今日の目安」に使う）と係数表を取得',
      parameters: [{ name: 'accountId', in: 'query', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Feeding products, pet count and energy factors' }, '400': { description: 'accountId is required' }, '403': { description: 'Account not visible' } },
    },
    put: {
      tags: ['NEN Members'], summary: '主食のカロリー表を一括保存し、登録済みペットの目安を計算し直す',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['accountId', 'products'], properties: { accountId: { type: 'string' }, treatLimitPercent: { type: 'integer', minimum: 1, maximum: 30, description: 'おやつの上限（1日の必要カロリーに対する %）。省略時は現在値（既定 10）' }, products: { type: 'array', maxItems: 20, items: { type: 'object', required: ['name', 'kcalPer100g'], properties: { id: { type: 'string', nullable: true }, name: { type: 'string', maxLength: 40 }, kcalPer100g: { type: 'number', minimum: 1, maximum: 1000 }, isDefault: { type: 'boolean' }, kind: { type: 'string', enum: ['staple', 'nen'], description: 'staple＝主食、nen＝然の商品（おやつ）' } } } } } } } } },
      responses: { '200': { description: 'Saved products' }, '400': { description: 'Validation failed' }, '403': { description: 'Owner or admin role required' } },
    },
  },
  // ── NEN Pets / Health（★37-3／37-4） ──────────────────────────────
  '/api/nen/pets': {
    get: {
      tags: ['NEN Members'], summary: 'マイペット一覧（今日の目安・避妊去勢・運動量・主食・体重の更新）と数値を取得',
      parameters: [
        { name: 'accountId', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'q', in: 'query', schema: { type: 'string' } },
        { name: 'species', in: 'query', schema: { type: 'string', enum: ['dog', 'cat'] } },
        { name: 'product', in: 'query', schema: { type: 'string' } },
        { name: 'weight', in: 'query', schema: { type: 'string', enum: ['stale', 'fresh'] } },
        { name: 'sort', in: 'query', schema: { type: 'string', enum: ['updated_desc', 'name', 'weight_desc', 'age_desc'] } },
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
      ],
      responses: { '200': { description: 'Paged pets with KPIs' }, '400': { description: 'accountId is required' }, '403': { description: 'Account not visible' } },
    },
  },
  '/api/nen/health': {
    get: {
      tags: ['NEN Members'], summary: '健康日記の一覧（最終記録・30日の記録数・8週の体重推移・気になる変化）と数値を取得',
      parameters: [
        { name: 'accountId', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'q', in: 'query', schema: { type: 'string' } },
        { name: 'change', in: 'query', schema: { type: 'string', enum: ['concern', 'silent', 'none'] } },
        { name: 'last', in: 'query', schema: { type: 'string', enum: ['7', '30', 'over30'] } },
        { name: 'sort', in: 'query', schema: { type: 'string', enum: ['concern', 'recent', 'records_desc'] } },
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
      ],
      responses: { '200': { description: 'Paged pets with health summaries and KPIs' }, '400': { description: 'accountId is required' }, '403': { description: 'Account not visible' } },
    },
  },
  '/api/nen/health/{petId}/summary': {
    get: {
      tags: ['NEN Members'], summary: '診察時に獣医師へ見せる「30日のまとめ」（記録・集計。医療判断はしない）',
      parameters: [
        { name: 'petId', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'accountId', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: { '200': { description: '30-day summary' }, '403': { description: 'Account not visible' }, '404': { description: 'Pet not found' } },
    },
  },
  // ── LIFF：然のマイページ（★37-2） ──────────────────────────────────
  '/api/liff/nen/pets/{id}': {
    put: {
      tags: ['NEN Members'], summary: 'マイペットの変更（体重・避妊去勢・運動量・主食）。保存すると「今日の目安」を計算し直す',
      security: [],
      description: 'LIFF の ID トークンで本人確認する（Authorization: Bearer）。本人のペットだけ変えられる。',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string', maxLength: 80 }, breed: { type: 'string', maxLength: 80 }, gender: { type: 'string', enum: ['male', 'female', 'unknown'] }, birthday: { type: 'string', format: 'date' }, weightKg: { type: 'number', minimum: 0.2, maximum: 150 }, concerns: { type: 'array', maxItems: 10, items: { type: 'string' } }, neutered: { type: 'string', enum: ['yes', 'no', 'unknown'] }, activityLevel: { type: 'string', enum: ['low', 'normal', 'high'] }, feedingProductId: { type: 'string', nullable: true } } } } } },
      responses: { '200': { description: 'Updated pet with feeding plan' }, '400': { description: 'Validation failed' }, '401': { description: 'LIFF identity required' }, '404': { description: 'Pet not found' } },
    },
  },
  '/api/liff/nen/health-logs/summary': {
    get: {
      tags: ['NEN Members'], summary: '健康日記「獣医師に見せる（直近30日のまとめ）」（★V6 37-2-B）。管理画面の 30日のまとめ と同じ計算',
      security: [],
      description: 'LIFF の ID トークンで本人確認する（Authorization: Bearer）。本人のペットだけ。医療判断は含めない。',
      parameters: [{ name: 'petId', in: 'query', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: '30-day summary (records, weight, heart/respiratory averages, stool/appetite/skin/tear counts, notes, logs)' }, '401': { description: 'LIFF identity required' }, '404': { description: 'Pet not found' } },
    },
  },
  // ── NEN Photo Rewards（採用写真のポイント手続き・） ──────────────
  '/api/nen-members/photos/{id}/point-retry': {
    post: {
      tags: ['NEN Members'],
      summary: '止まったポイント付与手続きをもう一度ECへ送る（冪等。同じ手続きは重複付与しない）',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['accountId'], properties: { accountId: { type: 'string' } } } } } },
      responses: { '200': { description: 'Reward state after the attempt (synced / processing / failed_retryable / failed_permanent)' }, '400': { description: 'Invalid request or photo not eligible' }, '403': { description: 'photo.reward.reconcile permission required' }, '404': { description: 'Photo not found in account scope' } },
    },
  },
  '/api/nen-members/photos/{id}/point-reconcile': {
    post: {
      tags: ['NEN Members'],
      summary: 'ポイント手続きの状態をECへ照合して結果を取り込む（EC側が付与済みなら二重付与せず完了扱い）',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['accountId'], properties: { accountId: { type: 'string' } } } } } },
      responses: { '200': { description: 'Reward state after reconciliation' }, '400': { description: 'Invalid request or photo not eligible' }, '403': { description: 'photo.reward.reconcile permission required' }, '404': { description: 'Photo not found in account scope' } },
    },
  },
};
