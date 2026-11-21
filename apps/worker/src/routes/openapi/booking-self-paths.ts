// 実行時の副作用を混ぜず定義だけを置き、ハンドラは各機能の経路に保つ。
export const bookingSelfPaths = {
  '/api/liff/booking/groups/{id}/cancellation-quote': {
    get: {
      tags: ['Booking'], summary: '本人の組の取消料金を確認する',
      description: 'LINEのIDトークンをAuthorizationヘッダーで受け、店舗と本人を内部で確認する。本人が予約した組の各人の料金と合計を返す。予約の変更や課金は行わない。',
      security: [],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'liffId', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: { '200': { description: '各人の見積もりと合計額（円）' }, '401': { description: 'LINE本人確認なし' }, '404': { description: '本人の組がない' } },
    },
  },
  '/api/booking/admin/monthly-contracts': {
    get: {
      tags: ['Booking'], summary: '本人別の月謝契約と直近12か月の請求状態を読む',
      parameters: [
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'friend_id', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50 } },
        { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 } },
      ],
      responses: { '200': { description: '契約一覧。カード・接続先・請求URLは含まない' }, '400': { description: '入力不正' }, '403': { description: '権限なし' }, '404': { description: '対象なし' }, '409': { description: 'monthly_tenant_required：会社設定未完了' } },
    },
  },
  '/api/liff/booking/monthly-contracts': {
    get: {
      tags: ['Booking'], summary: 'LINE本人の月謝契約と直近12か月の請求状態を読む',
      description: 'LINEの本人確認と同じ店の所属を検査。friend_id指定による代理参照は不可。private, no-store。',
      security: [{ liffIdToken: [] }],
      parameters: [
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50 } },
        { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 } },
      ],
      responses: { '200': { description: '本人の契約一覧' }, '400': { description: '入力不正' }, '401': { description: 'LINE本人確認なし' }, '404': { description: '対象なし' }, '409': { description: 'monthly_tenant_required：会社設定未完了' } },
    },
  },
  // ── LIFF Booking settings（日時を選ぶ段の最初の形） ─────────────────────
  '/api/liff/booking/settings': {
    get: {
      tags: ['Booking'],
      summary: 'LIFF予約の日時表示の最初の形と受付期間を取得',
      description: 'liffId で決まる店舗の設定だけを返す。設定行が無い・列が無い行は既定値（list・60日）。空き枠そのものは /api/liff/booking/availability を期間指定で呼ぶ。',
      security: [],
      parameters: [
        { name: 'liffId', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: 'liff_date_view（list/calendar）とbooking_window_days' },
        '404': { description: 'Unknown LIFF ID' },
      },
    },
  },
  // ── LIFF Booking self change (F6 本人日時変更・取消) ─────────────────────
  '/api/liff/booking/{id}/reschedule': {
    post: {
      tags: ['Booking'],
      summary: '本人の予約日時を変更',
      description: '本人確認→店→友だちの所有だけに許可。管理者キーは要求しない。期限・締切・空き・CASを検査し、Google同期とMeet連携の結果を返す。待ち列は含まない。',
      security: [],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: '変更成立（meet_sync 付き）・同日時再送は changed:false' },
        '401': { description: '本人確認ができない' },
        '403': { description: '期限切れ' },
        '404': { description: '予約なし' },
        '409': { description: '版競合・枠なし' },
        '422': { description: '不正な日時・締切切れ' },
      },
    },
  },
  '/api/liff/booking/{id}/cancel': {
    post: {
      tags: ['Booking'],
      summary: '本人の予約を取消',
      description: '本人確認→店→友だちの所有だけに許可。期限・CASを検査し、料金があるときはfeeAccepted=trueと現在の見積もりに一致するexpectedFeeAmountが必要。取消ずみ再送は副作用をそろえて200。実請求はしない。',
      security: [],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      ],
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', required: ['lock_version'], properties: {
          lock_version: { type: 'integer', minimum: 0 },
          feeAccepted: { type: 'boolean', description: '取消料が発生するときは明示的なtrueが必要' },
          expectedFeeAmount: { type: 'integer', minimum: 0, description: '同意した表示金額（円）。現在の見積もりと違う場合は409' },
        },
      } } } },
      responses: {
        '200': { description: '取消成立（calendar_sync・meet_sync 付き）' },
        '401': { description: '本人確認ができない' },
        '403': { description: '期限切れ' },
        '404': { description: '予約なし' },
        '409': { description: '版競合・送信中の再試行・取消料の同意または金額の再確認が必要' },
      },
    },
  },
  // ── Booking plus (前回・キャンセル待ち・今日・来店の印) ──────────────────
  '/api/liff/booking/last-booking': {
    get: {
      tags: ['Booking'],
      summary: '本人の前回の予約（メニュー・担当）を取得',
      description: '本人確認→店→友だちだけに許可。取り消し・却下・期限切れを除く最新1件。担当が辞めた・メニューが止まっているときは available=false。写真は担当の顔写真。',
      security: [],
      responses: {
        '200': { description: 'available と前回の予約（menu・staff）または available=false と理由' },
        '401': { description: '本人確認ができない' },
      },
    },
  },
  '/api/liff/booking/waitlist/mine': {
    get: {
      tags: ['Booking'],
      summary: '枠を指定して自分の待ち登録を取得',
      description: '本人確認→店→友だちだけに許可。待っている・仮押さえ中の登録があれば返す。シートの登録・取り消しの切り替え用。',
      security: [],
      parameters: [
        { name: 'staff_id', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'menu_id', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'starts_at', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: 'entry（登録）または entry: null' },
        '400': { description: '枠の指定が不正' },
        '401': { description: '本人確認ができない' },
      },
    },
  },
};
