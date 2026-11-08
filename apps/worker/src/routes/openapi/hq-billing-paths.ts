// 実行時の副作用を混ぜず定義だけを置き、ハンドラは各機能の経路に保つ。
export const hqBillingPaths = {
  // ── HQ Billing ─────────────────────────────────────────────────────────
  '/api/hq/billing/summary': {
    get: {
      tags: ['HQ Billing'], summary: '統括の契約状態と選択可能なプランを取得',
      responses: { '200': { description: 'Tenant billing summary and plan entitlements' }, '404': { description: 'Tenant not found' } },
    },
  },
  '/api/hq/billing/payment-failure': {
    get: {
      tags: ['HQ Billing'], summary: '現在の未払い請求と7日間の猶予・Stripeの支払い先を取得',
      responses: {
        '200': { description: '未払いが無ければdataはnull。請求先URLはStripeの請求書ドメインに限定する' },
        '403': { description: 'Owner or admin role required' },
        '404': { description: 'Tenant not found' },
      },
    },
  },
  '/api/hq/billing/preview': {
    get: {
      tags: ['HQ Billing'], summary: 'プラン変更の参考額を取得（契約・DBは変更しない）',
      parameters: [
        { name: 'planKey', in: 'query', required: true, schema: { type: 'string', enum: ['light', 'standard', 'pro'] } },
        { name: 'interval', in: 'query', required: true, schema: { type: 'string', enum: ['month', 'year'] } },
      ],
      responses: {
        '200': {
          description: '即時変更を仮定した参考額（Cache-Control: no-store）',
          content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', const: true }, data: {
            type: 'object',
            required: ['planKey', 'interval', 'afterAmountYen', 'amountDueYen', 'prorationDifferenceYen', 'nextBillingAt', 'estimatedAt', 'isEstimate', 'notice'],
            properties: {
              planKey: { type: 'string', enum: ['light', 'standard', 'pro'] },
              interval: { type: 'string', enum: ['month', 'year'] },
              afterAmountYen: { type: 'integer', description: '変更後の1回あたりの金額（単価×数量）' },
              amountDueYen: { type: 'integer', description: '見積り請求書の請求予定額' },
              prorationDifferenceYen: { type: 'integer', description: '日割りの差額' },
              nextBillingAt: { type: ['string', 'null'], format: 'date-time' },
              estimatedAt: { type: 'string', format: 'date-time' },
              isEstimate: { type: 'boolean', const: true },
              notice: { type: 'string' },
            },
          } } } } },
        },
        '400': { description: 'Invalid plan or interval' },
        '403': { description: 'Owner role required' },
        '404': { description: 'Tenant not found' },
        '409': { description: 'No changeable subscription' },
        '502': { description: 'Stripe price or preview unavailable' },
        '503': { description: 'Stripe or price configuration unavailable' },
      },
    },
  },
  '/api/hq/billing/checkout': {
    post: {
      tags: ['HQ Billing'], summary: 'Stripe Checkoutの申込URLを作成',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['planKey'], properties: { planKey: { type: 'string', enum: ['light', 'standard', 'pro'] } } } } } },
      responses: { '200': { description: 'Checkout URL' }, '400': { description: 'Invalid plan' }, '403': { description: 'Owner role required' }, '409': { description: 'Already subscribed or billing exempt' }, '503': { description: 'Stripe or price configuration unavailable' } },
    },
  },
  '/api/hq/billing/card-setup': {
    post: {
      tags: ['HQ Billing'], summary: '請求を始めずにStripeのカード登録画面を開く',
      responses: { '200': { description: 'Setup-mode Checkout URL' }, '403': { description: 'Owner or admin role required' }, '404': { description: 'Tenant not found' }, '409': { description: 'Billing exempt' }, '502': { description: 'Stripe API unavailable' }, '503': { description: 'Stripe configuration unavailable' } },
    },
  },
  '/api/hq/billing/card-status': {
    get: {
      tags: ['HQ Billing'], summary: 'カード登録済みかをStripeから確認する（カード情報は返さない）',
      responses: { '200': { description: 'Card registration boolean' }, '403': { description: 'Owner or admin role required' }, '404': { description: 'Tenant not found' }, '502': { description: 'Stripe API unavailable' } },
    },
  },
  '/api/hq/billing/portal': {
    post: {
      tags: ['HQ Billing'], summary: 'StripeカスタマーポータルURLを作成',
      responses: { '200': { description: 'Customer portal URL' }, '403': { description: 'Owner or admin role required' }, '409': { description: 'No active customer' }, '503': { description: 'Admin origin unavailable' } },
    },
  },
  '/api/hq/billing/invoices': {
    get: {
      tags: ['HQ Billing'], summary: '統括の支払い履歴を取得',
      responses: { '200': { description: 'Up to 12 tenant-scoped invoices' }, '403': { description: 'Owner or admin role required' }, '502': { description: 'Stripe API unavailable' } },
    },
  },
  '/api/hq/billing/webhook': {
    post: {
      tags: ['HQ Billing'], summary: 'Stripe課金イベントを受信', security: [],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
      responses: { '200': { description: 'Event accepted idempotently' }, '400': { description: 'Invalid signature or payload' }, '413': { description: 'Payload too large' }, '503': { description: 'Webhook secret is not configured' } },
    },
  },
};
