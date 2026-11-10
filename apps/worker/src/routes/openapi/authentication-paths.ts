import { STEP_UP_PURPOSES } from '../../lib/step-up.js';

// 実行時の副作用を混ぜず定義だけを置き、ハンドラは各機能の経路に保つ。
export const authenticationPaths = {

  '/api/auth/passkeys/login/options': {
    post: { tags: ['Auth'], summary: '一次認証後のパスキー認証課題を発行', security: [], responses: { '200': { description: '登録済みの場合だけWebAuthn optionsを返す' }, '401': { description: '一次認証が無効' } } },
  },
  '/api/auth/passkeys/login/verify': {
    post: { tags: ['Auth'], summary: 'パスキーを確認してログインを完了', security: [], responses: { '200': { description: '本人セッションを発行' }, '401': { description: '課題またはパスキーが無効' }, '429': { description: '試行回数の上限' } } },
  },

  '/api/auth/passkeys/self': {
    get: { tags: ['Auth'], summary: '本人の登録済みパスキー一覧', responses: { '200': { description: '登録日と最終使用日。公開鍵は返さない' }, '403': { description: '本人セッションが必要' } } },
    delete: { tags: ['Auth'], summary: '本人確認後に本人のパスキーを削除', responses: { '200': { description: '削除済み' }, '401': { description: '再確認が必要' }, '403': { description: '本人セッションが必要' } } },
  },
  '/api/auth/passkeys/register/options': {
    post: { tags: ['Auth'], summary: '本人の登録用WebAuthn課題を発行', responses: { '200': { description: 'WebAuthn options and challenge token' }, '403': { description: '本人セッションが必要' } } },
  },
  '/api/auth/passkeys/register/verify': {
    post: { tags: ['Auth'], summary: '本人確認後にパスキーを登録', responses: { '200': { description: '登録済み' }, '401': { description: '課題または本人確認が無効' }, '403': { description: '本人セッションが必要' } } },
  },

  // ── Email authentication ───────────────────────────────────────────────
  '/api/auth/register/request': {
    post: {
      tags: ['Auth'], summary: '会員登録用の確認メールを送信', security: [],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['email', 'turnstileToken', 'agreed'], properties: { email: { type: 'string', format: 'email' }, turnstileToken: { type: 'string' }, agreed: { type: 'boolean' }, deviceMarker: { type: 'string' } } } } } },
      responses: { '200': { description: 'Request accepted without exposing account existence' }, '400': { description: 'Invalid request' }, '429': { description: 'Rate limit exceeded' }, '503': { description: 'Turnstile or mail configuration unavailable' } },
    },
  },
  '/api/auth/register/check': {
    get: {
      tags: ['Auth'], summary: '会員登録トークンを確認', security: [],
      responses: { '200': { description: 'Token state' } },
    },
  },
  '/api/auth/register/complete': {
    post: {
      tags: ['Auth'], summary: '会員登録を完了', security: [],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
      responses: { '200': { description: 'Tenant and owner account created' }, '400': { description: 'Invalid or expired token' }, '409': { description: 'Account already exists' } },
    },
  },
  '/api/auth/register/resend-expired': {
    post: {
      tags: ['Auth'], summary: '期限切れの承認済みアカウント作成リンクを元の宛先へ再送', security: [],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } } } } },
      responses: { '200': { description: '元の申込先へ再送済み、または短時間の重複依頼' }, '404': { description: '再送できないリンク' }, '429': { description: '送信回数の上限' }, '502': { description: 'メール送信失敗' } },
    },
  },
  '/api/auth/password/login': {
    post: {
      tags: ['Auth'], summary: 'メールアドレスとパスワードでログイン', security: [],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['email', 'password', 'turnstileToken'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string' }, turnstileToken: { type: 'string' } } } } } },
      responses: { '200': { description: 'Session issued' }, '400': { description: 'Robot verification required' }, '503': { description: 'Robot verification unavailable' }, '401': { description: 'Invalid credentials' }, '429': { description: 'Rate limit exceeded' } },
    },
  },
  '/api/auth/password/forgot': {
    post: {
      tags: ['Auth'], summary: 'パスワード再設定メールを送信', security: [],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['email', 'turnstileToken'], properties: { email: { type: 'string', format: 'email' }, turnstileToken: { type: 'string' } } } } } },
      responses: { '200': { description: 'Request accepted without exposing account existence' }, '429': { description: 'Rate limit exceeded' }, '503': { description: 'Turnstile or mail configuration unavailable' } },
    },
  },
  '/api/auth/password/reset/check': {
    get: {
      tags: ['Auth'], summary: 'パスワード再設定トークンを確認', security: [],
      responses: { '200': { description: 'Token state' } },
    },
  },
  '/api/auth/password/reset': {
    post: {
      tags: ['Auth'], summary: 'パスワードを再設定', security: [],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
      responses: { '200': { description: 'パスワード更新・既存セッション失効。TOTPは保持し、セッションは発行しない' }, '400': { description: 'Invalid or expired token' } },
    },
  },
  '/api/auth/two-factor/policy': {
    get: { summary: '統括のログインで二段階認証を必須にする設定', tags: ['Auth'],
      responses: { '200': { description: 'required・canEdit・登録済み人数・configured・notice（鍵ありは初期値On、鍵不足はOff）' }, '401': { description: '未ログイン' } } },
    put: { summary: 'オーナー・運営が二段階認証のOn/Offを変更', tags: ['Auth'],
      parameters: [{ name: 'X-Step-Up-Token', in: 'header', schema: { type: 'string' }, description: 'Offにする時の本人確認。セッションに結び付く1回限りの票' }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['required'], properties: { required: { type: 'boolean' } } } } } },
      responses: { '200': { description: '監査へ保存。Onへの変更時は既存セッションを失効' }, '401': { description: '再確認が必要' }, '400': { description: '鍵が未設定のため必須にできない' }, '403': { description: '変更権限なし' }, '409': { description: '他の操作と競合' } } },
  },
  '/api/auth/api-key': {
    get: { summary: '本人のAPI鍵の発行・最終利用・失効日時（秘密値なし）', tags: ['Auth'], responses: { '200': { description: '日時のみ' }, '403': { description: '本人セッションが必要' } } },
    post: { summary: '本人確認後に鍵を交換し、この応答で一度だけ表示', tags: ['Auth'], parameters: [{ name: 'X-Step-Up-Token', in: 'header', required: true, schema: { type: 'string' }, description: 'auth.api_key用の一回限りの確認票' }], responses: { '200': { description: '新しい鍵。古い鍵と本人の全セッションは失効。再ログインが必要' }, '401': { description: '再確認が必要' }, '403': { description: '本人操作不可' }, '409': { description: '同時更新' } } },
    delete: { summary: '本人確認後にAPI鍵と本人の全セッションを失効', tags: ['Auth'], parameters: [{ name: 'X-Step-Up-Token', in: 'header', required: true, schema: { type: 'string' }, description: 'auth.api_key用の一回限りの確認票' }], responses: { '200': { description: '失効済み。秘密値は返さない' }, '401': { description: '再確認が必要' }, '403': { description: '本人操作不可' }, '409': { description: '同時更新' } } },
  },
  '/api/auth/two-factor/self': {
    get: { summary: '本人の認証アプリ登録日', tags: ['Auth'],
      responses: { '200': { description: '本人だけの登録日・鍵の準備状態' }, '401': { description: '未ログイン' }, '403': { description: '代理ログイン中または本人設定なし' } } },
  },
  '/api/auth/two-factor/setup': {
    post: {
      tags: ['Auth'], summary: 'TOTP未登録の人が二段階認証の初回登録を開始', security: [],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['challengeToken'], properties: { challengeToken: { type: 'string' } } } } } },
      responses: { '200': { description: 'provisioningUri and manualKey issued' }, '400': { description: 'Missing challenge token' }, '401': { description: 'Invalid or expired setup challenge' }, '409': { description: 'TOTP already configured' } },
    },
  },
  '/api/auth/two-factor/setup/confirm': {
    post: {
      tags: ['Auth'], summary: '二段階認証の初回設定を確認してセッションを発行', security: [],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['challengeToken', 'code'], properties: { challengeToken: { type: 'string' }, code: { type: 'string' } } } } } },
      responses: { '200': { description: 'TOTP登録・確認済みセッション発行' }, '400': { description: 'Invalid code' }, '401': { description: 'Invalid or expired setup challenge' }, '429': { description: 'Attempt limit exceeded' } },
    },
  },
  '/api/auth/ops-invite/check': {
    get: {
      tags: ['Auth'], summary: '運営メンバーの招待を確認（★V6 37-10-A）', security: [],
      parameters: [{ name: 'token', in: 'query', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Invite is valid; email, name, needsPassword' }, '404': { description: 'Unknown invite' }, '410': { description: 'Expired or used' } },
    },
  },
  '/api/auth/ops-invite/accept': {
    post: {
      tags: ['Auth'], summary: '運営メンバーの招待を受ける（名前・パスワード設定 → 2要素認証待ち）', security: [],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['token'], properties: { token: { type: 'string' }, name: { type: 'string' }, password: { type: 'string' } } } } } },
      responses: { '200': { description: '確認または登録用のchallengeTokenのみ。セッションは二段階の確認後に発行' }, '400': { description: 'Invalid name or password' }, '404': { description: 'Unknown invite' }, '410': { description: 'Expired or used' } },
    },
  },
  '/api/auth/sessions': {
    get: {
      tags: ['Auth'], summary: '本人のアクティブなセッション一覧',
      responses: { '200': { description: 'Sessions with current flag, user agent, masked IP' }, '401': { description: 'Not authenticated' } },
    },
  },
  '/api/auth/sessions/{tokenHash}': {
    delete: {
      tags: ['Auth'], summary: '本人のセッションを1件失効（現在のセッションは confirmCurrent=1 が必須）',
      parameters: [{ name: 'tokenHash', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Session revoked' }, '401': { description: 'Not authenticated' }, '404': { description: 'Session not found or not owned' }, '409': { description: 'Current-session confirmation required' } },
    },
  },
  '/api/auth/sessions/revoke-others': {
    post: {
      tags: ['Auth'], summary: '今のセッション以外をまとめて失効',
      responses: { '200': { description: 'Count of revoked sessions' }, '401': { description: 'Not authenticated' } },
    },
  },
  '/api/auth/step-up': {
    post: {
      tags: ['Auth'], summary: '高危険操作用の5分・1回限り再認証grantを発行（V: パスワード経路あり）',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['purpose'], properties: { code: { type: 'string', description: '6桁コード（2段階認証の設定がある人）' }, password: { type: 'string', description: 'パスワード（2段階認証の設定が無い人）' }, purpose: { type: 'string', enum: [...STEP_UP_PURPOSES] } } } } } },
      responses: { '201': { description: 'Step-up grant issued' }, '400': { description: 'Invalid or wrong credential' }, '401': { description: 'Not authenticated (STEP_UP_UNAUTHORIZED)' }, '403': { description: 'Neither TOTP nor password configured' }, '409': { description: 'Code already used' }, '429': { description: 'Attempt limit exceeded' } },
    },
  },
};
