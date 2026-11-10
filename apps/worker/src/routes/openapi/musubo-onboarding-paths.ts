// 新料金の利用開始と個別見積もり。各操作は認証済みの統括または運営に限定する。
const applicationId = { name: 'applicationId', in: 'path', required: true, schema: { type: 'string' } };
const id = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const lineId = { name: 'lineId', in: 'path', required: true, schema: { type: 'string' } };
const jsonBody = { required: true, content: { 'application/json': { schema: { type: 'object' } } } };

export const musuboOnboardingPaths = {
  '/api/hq/billing/musubo/last-line-end': {
    get: { tags: ['Musubo billing'], summary: '最後のLINEの終了日と未払い金額を取得', responses: { '200': { description: '終了条件と状態' }, '409': { description: '対象のLINEを確認できない' } } },
    post: { tags: ['Musubo billing'], summary: '最後のLINEの終了予約・即時終了・予約取消', requestBody: jsonBody,
      responses: { '200': { description: '終了手続きの状態' }, '400': { description: '終了方法が不正' }, '409': { description: '終了状態が変化' } } },
  },
  '/api/hq/billing/musubo/line-addition': {
    get: { tags: ['Musubo billing'], summary: '次のLINE追加料金または保留中の決済を取得', responses: { '200': { description: '追加料金または決済状態' }, '409': { description: '追加不可' } } },
    post: { tags: ['Musubo billing'], summary: '確認済み料金でLINE追加の支払いを開始または再試行', requestBody: jsonBody, responses: { '200': { description: '追加の決済状態' }, '400': { description: '料金への同意なし' }, '409': { description: '料金または決済状態が変化' } } },
  },
  '/api/hq/billing/musubo/line-removal/{lineId}': {
    get: { tags: ['Musubo billing'], summary: '対象LINEの終了日と料金を取得', parameters: [lineId], responses: { '200': { description: '終了条件と状態' }, '409': { description: '対象のLINEを確認できない' } } },
    post: { tags: ['Musubo billing'], summary: '対象LINEの終了予約・即時終了・予約取消', parameters: [lineId], requestBody: jsonBody,
      responses: { '200': { description: '終了手続きの状態' }, '400': { description: '終了方法が不正' }, '409': { description: '終了状態が変化' } } },
  },
  '/api/hq/billing/musubo/resumption': {
    get: { tags: ['Musubo billing'], summary: '利用再開時の料金・未払い・同意状態を取得', responses: { '200': { description: '利用再開の確認内容' }, '409': { description: 'LINEの再接続または料金の再確認が必要' } } },
  },
  '/api/hq/billing/musubo/resumption/accept': {
    post: { tags: ['Musubo billing'], summary: '利用再開時の料金に同意', responses: { '200': { description: '同意済みの料金' }, '409': { description: '料金または支払い状態が変化' } } },
  },
  '/api/hq/billing/musubo/resumption/connect': {
    post: { tags: ['Musubo billing'], summary: '本人確認後に決済と前回のLINE接続を照合して利用再開', responses: { '200': { description: '再開状態' }, '202': { description: '決済と接続を確認中' }, '409': { description: 'カードまたは接続情報を確認できない' } } },
  },
  '/api/hq/billing/musubo/resumption/complete': {
    get: { tags: ['Musubo billing'], summary: '利用再開完了後の請求とLINEの状態を取得', responses: { '200': { description: '利用再開の結果' }, '409': { description: '決済結果を確認中' } } },
  },
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
  '/api/ops/applications/{applicationId}/quotes/{id}/send-review': {
    get: { tags: ['Musubo operations'], summary: '見積もりメールの送信結果と確認が必要な状態を取得', parameters: [applicationId, id], responses: { '200': { description: '送信確認の状態' }, '409': { description: '見積もりの状態が変化' } } },
  },
  '/api/ops/applications/{applicationId}/quotes/{id}/resolve-send': {
    post: { tags: ['Musubo operations'], summary: '送信結果が不明な見積もりの配信記録を照合', parameters: [applicationId, id], requestBody: jsonBody,
      responses: { '200': { description: '照合した送信状態' }, '409': { description: '配信記録の再確認が必要' } } },
  },
  '/api/ops/applications/{applicationId}/quotes/{id}/send': {
    post: { tags: ['Musubo operations'], summary: '確認済みの個別見積もりメールを送信', parameters: [applicationId, id], requestBody: jsonBody, responses: { '200': { description: '送信結果' }, '409': { description: '確認内容不一致' } } },
  },
};
