// 新料金の利用開始と個別見積もり。各操作は認証済みの統括または運営に限定する。
const applicationId = { name: 'applicationId', in: 'path', required: true, schema: { type: 'string' } };
const id = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const jsonBody = { required: true, content: { 'application/json': { schema: { type: 'object' } } } };

export const musuboOnboardingPaths = {
  '/api/hq/onboarding/pricing': {
    get: { tags: ['Musubo onboarding'], summary: '承認済みの料金条件と保存済みの選択を取得', responses: { '200': { description: '統括の料金条件と選択' }, '403': { description: '権限なし' }, '404': { description: '条件なし' } } },
    post: { tags: ['Musubo onboarding'], summary: '予定数から料金を再計算して同意を保存', requestBody: jsonBody, responses: { '200': { description: '確定した料金選択' }, '400': { description: '不正な選択' }, '409': { description: '状態が変化' } } },
  },
  '/api/hq/onboarding/quotes/latest': {
    get: { tags: ['Musubo onboarding'], summary: '統括の最新の個別見積もりIDを取得', responses: { '200': { description: '見積もりID' }, '404': { description: '見積もりなし' } } },
  },
  '/api/hq/onboarding/quotes/{id}': {
    get: { tags: ['Musubo onboarding'], summary: '統括宛ての個別見積もりと同意状態を取得', parameters: [id], responses: { '200': { description: '個別見積もりと同意状態' }, '404': { description: '見積もりなし' } } },
  },
  '/api/hq/onboarding/quotes/{id}/accept': {
    post: { tags: ['Musubo onboarding'], summary: '期限内の個別見積もりへ同意', parameters: [id], responses: { '200': { description: '同意済み見積もり' }, '404': { description: '見積もりなし' }, '409': { description: '期限または状態が変化' } } },
  },
  '/api/ops/pricing-conditions': {
    get: { tags: ['Musubo operations'], summary: '利用条件の版を一覧', responses: { '200': { description: '利用条件一覧' }, '403': { description: '運営権限なし' } } },
    post: { tags: ['Musubo operations'], summary: '新しい利用条件を作成', requestBody: jsonBody, responses: { '201': { description: '作成した条件' }, '400': { description: '不正な条件' } } },
  },
  '/api/ops/pricing-conditions/{id}': {
    put: { tags: ['Musubo operations'], summary: '利用条件の次版を保存', parameters: [id], requestBody: jsonBody, responses: { '200': { description: '更新した条件' }, '404': { description: '条件なし' }, '409': { description: '競合' } } },
  },
  '/api/ops/applications/{applicationId}/quotes': {
    get: { tags: ['Musubo operations'], summary: '申込の個別見積もり一覧', parameters: [applicationId], responses: { '200': { description: '見積もり一覧' }, '404': { description: '申込なし' } } },
    post: { tags: ['Musubo operations'], summary: '個別見積もりの下書きを作成', parameters: [applicationId], requestBody: jsonBody, responses: { '201': { description: '作成した下書き' }, '400': { description: '不正な料金' } } },
  },
  '/api/ops/applications/{applicationId}/quotes/{id}': {
    put: { tags: ['Musubo operations'], summary: '個別見積もりの下書きを更新', parameters: [applicationId, id], requestBody: jsonBody, responses: { '200': { description: '更新した下書き' }, '409': { description: '競合' } } },
  },
  '/api/ops/applications/{applicationId}/quotes/{id}/mail-preview': {
    get: { tags: ['Musubo operations'], summary: '個別見積もりメールの送信前確認', parameters: [applicationId, id], responses: { '200': { description: '送信前プレビュー' }, '409': { description: '送信不可' } } },
  },
  '/api/ops/applications/{applicationId}/quotes/{id}/send': {
    post: { tags: ['Musubo operations'], summary: '確認済みの個別見積もりメールを送信', parameters: [applicationId, id], requestBody: jsonBody, responses: { '200': { description: '送信結果' }, '409': { description: '確認内容不一致' } } },
  },
};
