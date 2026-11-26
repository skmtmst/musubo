// 実行時の副作用を混ぜず定義だけを置き、ハンドラは各機能の経路に保つ。
export const accountsPaths = {
  // ── Staff invitation ────────────────────────────────────────────────────
  '/api/staff/last-logins': {
    get: {
      tags: ['Staff'], summary: '統括メンバーの最終ログイン一覧を取得',
      responses: { '200': { description: 'Last login times by staff id' }, '403': { description: 'Owner or admin role required' } },
    },
  },
  '/api/staff/{id}/resend-invite': {
    post: {
      tags: ['Staff'], summary: '統括メンバーへの招待を再送',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Invitation resent' }, '403': { description: 'Owner or admin with all-account scope required' }, '404': { description: 'Not found in current tenant' }, '409': { description: 'Staff invitation is no longer pending' } },
    },
  },
  '/api/staff/{id}/resend-invitation': {
    post: {
      tags: ['Staff'],
      summary: '未受諾・期限切れのスタッフ招待を再送',
      description: '同じ行を使い回して新しい招待トークンを発行する。旧トークンは即時に失効し、新しい期限は7日。',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'Invitation resent with a new token and expiry' },
        '400': { description: 'No email address on the staff member' },
        '403': { description: 'Owner or admin role required' },
        '404': { description: 'Not found in current tenant' },
        '409': { description: 'Already active; nothing to resend' },
        '500': { description: 'Invitation mail could not be sent' },
      },
    },
  },
  '/api/staff/email-change/confirm': {
    post: {
      tags: ['Staff'],
      summary: 'メールアドレス変更を確定',
      description: '確認画面からの POST で確定する。トークンは24時間・使い切り。確定後は旧アドレスへ完了の知らせを送る（N-433）。',
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object',
        required: ['token'],
        properties: { token: { type: 'string', minLength: 1, maxLength: 512 } },
      } } } },
      responses: {
        '200': { description: 'Email change confirmed and applied' },
        '400': { description: 'Missing or malformed token' },
        '409': { description: 'The new address is already registered' },
        '410': { description: 'Token invalid or expired' },
      },
    },
  },
  // ── Users (UUID Cross-Account) ──────────────────────────────────────────
  '/api/users': {
    get: { tags: ['Users'], summary: '内部ユーザー一覧取得', responses: { '200': { description: 'All users' } } },
    post: {
      tags: ['Users'],
      summary: '内部ユーザー作成',
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { email: { type: 'string' }, phone: { type: 'string' }, externalId: { type: 'string' }, displayName: { type: 'string' } } } } } },
      responses: { '201': { description: 'User created' } },
    },
  },
  '/api/users/match': {
    post: {
      tags: ['Users'],
      summary: 'メール/電話でユーザー検索',
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { email: { type: 'string' }, phone: { type: 'string' } } } } } },
      responses: { '200': { description: 'Matched user' }, '404': { description: 'Not found' } },
    },
  },
  '/api/users/{id}': {
    get: { tags: ['Users'], summary: 'ユーザー詳細取得', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'User' } } },
    put: { tags: ['Users'], summary: 'ユーザー更新', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Updated' } } },
    delete: { tags: ['Users'], summary: 'ユーザー削除', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Deleted' } } },
  },
  '/api/users/{id}/link': {
    post: {
      tags: ['Users'],
      summary: '友だちをUUIDにリンク',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { friendId: { type: 'string' } }, required: ['friendId'] } } } },
      responses: { '200': { description: 'Linked' } },
    },
  },
  '/api/users/{id}/accounts': {
    get: {
      tags: ['Users'],
      summary: 'UUID紐付き友だち一覧',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Linked friends/accounts' } },
    },
  },
  // ── LINE Account Tags ───────────────────────────────────────────────────
  '/api/line-account-tags': {
    get: {
      tags: ['LINE Accounts'],
      summary: '統括内のアカウントタグ一覧',
      responses: {
        '200': { description: 'アカウントタグの一覧（並び順・名前順）', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', const: true }, data: { type: 'array', items: { $ref: '#/components/schemas/LineAccountTag' } } } } } } },
        '403': { description: 'Owner or admin role required' },
      },
    },
    post: {
      tags: ['LINE Accounts'],
      summary: 'アカウントタグを作成',
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/LineAccountTagInput', required: ['name'] } } } },
      responses: {
        '201': { description: '作成したアカウントタグ', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', const: true }, data: { $ref: '#/components/schemas/LineAccountTag' } } } } } },
        '400': { description: 'Invalid name, color or displayOrder' },
        '403': { description: 'Owner or admin role required' },
        '409': { description: 'Same tag name already exists in the tenant' },
      },
    },
  },
  '/api/line-account-tags/{id}': {
    patch: {
      tags: ['LINE Accounts'],
      summary: 'アカウントタグの名前・色・並び順を変更',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/LineAccountTagInput', minProperties: 1 } } } },
      responses: {
        '200': { description: '変更後のアカウントタグ', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', const: true }, data: { $ref: '#/components/schemas/LineAccountTag' } } } } } },
        '400': { description: 'Invalid name, color or displayOrder' },
        '403': { description: 'Owner or admin role required' },
        '404': { description: 'Tag not found' },
        '409': { description: 'Same tag name already exists in the tenant' },
      },
    },
    delete: {
      tags: ['LINE Accounts'],
      summary: 'アカウントタグを削除（付与も外す）',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: '削除したタグID', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', const: true }, data: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } } } } } },
        '403': { description: 'Owner or admin role required' },
        '404': { description: 'Tag not found' },
      },
    },
  },
  '/api/line-accounts/{id}/tags': {
    put: {
      tags: ['LINE Accounts'],
      summary: 'LINEアカウントのタグをまとめて置き換え',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['tagIds'], properties: { tagIds: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1 }, description: '同じ統括のアカウントタグID。重複は1つにまとめる' } } } } } },
      responses: {
        '200': { description: '置き換え後のタグ', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', const: true }, data: { type: 'object', required: ['id', 'tags'], properties: { id: { type: 'string' }, tags: { type: 'array', items: { $ref: '#/components/schemas/LineAccountTag' } } } } } } } } },
        '400': { description: 'tagIds is not an array or contains tags outside the tenant' },
        '403': { description: 'Owner or admin role required' },
        '404': { description: 'Account not found or not accessible' },
        '409': { description: 'ACCOUNT_ARCHIVED' },
      },
    },
  },
  // ── LINE Accounts ───────────────────────────────────────────────────────
  '/api/line-accounts/profile-pictures': {
    get: { tags: ['LINE Accounts'], summary: 'LINEアカウントのプロフィール画像一覧', responses: { '200': { description: 'Profile pictures' } } },
  },
  '/api/line-accounts': {
    get: { tags: ['LINE Accounts'], summary: 'LINEアカウント一覧', responses: { '200': { description: 'All LINE accounts' } } },
    post: {
      tags: ['LINE Accounts'],
      summary: 'LINEアカウント登録',
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { channelId: { type: 'string' }, name: { type: 'string' }, channelAccessToken: { type: 'string' }, channelSecret: { type: 'string' } }, required: ['channelId', 'name', 'channelAccessToken', 'channelSecret'] } } } },
      responses: { '201': { description: 'Account created' } },
    },
  },
  '/api/line-accounts/connect/check': {
    post: {
      tags: ['LINE Accounts'],
      summary: '4つのチャネル情報でLINE側を自動設定して接続確認',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                name: { type: 'string', maxLength: 40 },
                channelId: { type: 'string', pattern: '^\\d+$' },
                channelSecret: { type: 'string', format: 'password' },
                loginChannelId: { type: 'string', pattern: '^\\d+$' },
                loginChannelSecret: { type: 'string', format: 'password' },
                importFriends: { type: 'boolean', default: true, description: '省略時はtrue。falseは友だちの取得・取り込み・初回実行の予約を行いません。null・文字列・数などboolean以外は422で拒否します。' },
              },
              required: ['channelId', 'channelSecret', 'loginChannelId', 'loginChannelSecret'],
            },
          },
        },
      },
      responses: { '200': { description: 'Five connection steps; no musubo DB row is created' } },
    },
  },
  '/api/line-accounts/connect': {
    post: {
      tags: ['LINE Accounts'],
      summary: 'LINE側の自動設定・接続確認・アカウント保存',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                name: { type: 'string', maxLength: 40 },
                channelId: { type: 'string', pattern: '^\\d+$' },
                channelSecret: { type: 'string', format: 'password' },
                loginChannelId: { type: 'string', pattern: '^\\d+$' },
                loginChannelSecret: { type: 'string', format: 'password' },
                importFriends: { type: 'boolean', default: true, description: '省略時はtrue。falseは友だちの取得・取り込み・初回実行の予約を行いません。null・文字列・数などboolean以外は422で拒否します。' },
              },
              required: ['channelId', 'channelSecret', 'loginChannelId', 'loginChannelSecret'],
            },
          },
        },
      },
      responses: {
        '201': { description: 'Account created and follower import started when available' },
        '400': { description: 'A connection step failed; no account row remains' },
      },
    },
  },
  '/api/line-accounts/order': {
    patch: {
      tags: ['LINE Accounts'],
      summary: 'アカウント表示順を一括更新 (drag-drop reorder)',
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                ordered: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      displayOrder: { type: 'integer' },
                    },
                    required: ['id', 'displayOrder'],
                  },
                },
              },
              required: ['ordered'],
            },
          },
        },
      },
      responses: { '200': { description: 'Order updated' } },
    },
  },
  '/api/line-accounts/{id}': {
    get: { tags: ['LINE Accounts'], summary: 'LINEアカウント詳細', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Account' } } },
    patch: {
      tags: ['LINE Accounts'],
      summary: 'LINEアカウント部分更新',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                isActive: { type: 'boolean' },
                country: { type: 'string', nullable: true },
                role: { type: 'string', nullable: true },
              },
            },
          },
        },
      },
      responses: { '200': { description: 'Updated' } },
    },
    put: { tags: ['LINE Accounts'], summary: 'LINEアカウント更新', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Updated' } } },
    delete: { tags: ['LINE Accounts'], summary: 'LINEアカウント削除（内部ではアーカイブとして記録を残す）', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Archived' } } },
  },
  '/api/line-accounts/{id}/deactivate': {
    post: {
      tags: ['LINE Accounts'],
      summary: '送受信を止める',
      description: '理由は必須。止めている間は受信も予約配信も止まり、'
        + '送らなかった分は「止めていたので送らなかった」一覧に残る（X-1）。'
        + '本人確認（step-up）が要る。',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['reason'],
              properties: { reason: { type: 'string', maxLength: 500 } },
            },
          },
        },
      },
      responses: {
        '200': { description: '止めた' },
        '401': { description: 'STEP_UP_REQUIRED' },
        '409': { description: '既定アカウント・アーカイブ済み' },
        '422': { description: '理由が無い・長すぎる' },
      },
    },
  },
  '/api/line-accounts/{id}/activate': {
    post: {
      tags: ['LINE Accounts'],
      summary: '送受信を再開する',
      description: '理由は必須。再開の前に接続を確かめ、LINEとの接続（bot_info）が'
        + '通らないときは再開しない（X-1）。確かめた結果は台帳にも残す。'
        + '本人確認（step-up）が要る。',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['reason'],
              properties: { reason: { type: 'string', maxLength: 500 } },
            },
          },
        },
      },
      responses: {
        '200': { description: '再開した' },
        '401': { description: 'STEP_UP_REQUIRED' },
        '409': { description: 'アーカイブ済み' },
        '422': { description: '理由が無い・接続を確認できない' },
      },
    },
  },
  '/api/line-accounts/{id}/skipped-deliveries': {
    get: {
      tags: ['LINE Accounts'],
      summary: '止めている間に送らなかった配信の一覧',
      description: '再開の画面で運用者が確認するための一覧（X-1）。再実行は別途選ぶ。',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: '一覧' }, '404': { description: 'Not found' } },
    },
  },
  '/api/line-accounts/{id}/archive': {
    post: {
      tags: ['LINE Accounts'],
      summary: 'アーカイブする',
      description: '一覧から外して記録を残す。動いている・既定・配送中・'
        + '振り分けの組に入っているアカウントは断る（409）。本人確認が要る。',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'Archived' },
        '401': { description: 'STEP_UP_REQUIRED' },
        '409': { description: 'ACCOUNT_ARCHIVED / LINE_ACCOUNT_ARCHIVE_BLOCKED' },
      },
    },
  },
  '/api/line-accounts/{id}/restore': {
    post: {
      tags: ['LINE Accounts'],
      summary: 'アーカイブから戻す',
      description: '戻った直後は「止まっている」状態。送受信を始めるには別途再開が要る。',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Restored' }, '401': { description: 'STEP_UP_REQUIRED' } },
    },
  },
  '/api/line-accounts/{id}/connection-checks': {
    post: {
      tags: ['LINE Accounts'],
      summary: '接続を確かめる',
      description: 'Idempotency-Key と expectedRevision が要る。'
        + 'bot情報・Webhook・LIFF の突合結果を台帳へ残す。',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: '確かめた結果' },
        '409': { description: 'REVISION_CONFLICT / ACCOUNT_ARCHIVED' },
        '422': { description: 'Idempotency-Key・expectedRevision が要る' },
      },
    },
  },
  '/api/line-accounts/registration-resume': {
    get: {
      tags: ['LINE Accounts'],
      summary: '本人が始めたLINE登録を再開する',
      description: '指定されたMessaging APIのチャネルで、ログイン中の本人が登録し、使い方がまだ未選択の有効なアカウントを確認する。',
      parameters: [{ name: 'channel_id', in: 'query', required: true, schema: { type: 'string', pattern: '^[0-9]{1,32}$' } }],
      responses: {
        '200': { description: '再開できるアカウントID' },
        '403': { description: '登録できる管理者権限がない' },
        '404': { description: '再開できるアカウントがない' },
        '422': { description: 'チャネルIDの形式が正しくない' },
      },
    },
  },
  '/api/line-accounts/{id}/registration-receipt': {
    get: {
      tags: ['LINE Accounts'],
      summary: '登録後のLINE受信を確認する',
      description: '登録したアカウント宛ての友だち追加またはメッセージの受信記録を返す。'
        + '既存の友だち数や空の設定テストは成功と見なさない。',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'waiting / confirmed / error のいずれか' },
        '404': { description: '対象を確認できないか、本人の登録ではない' },
        '409': { description: 'LINE_ACCOUNT_INACTIVE' },
      },
    },
  },
  '/api/line-accounts/verify-connection': {
    post: {
      tags: ['LINE Accounts'],
      summary: '接続確認（登録前の試し）',
      responses: { '200': { description: '確認結果' } },
    },
  },
  '/api/line-accounts/default': {
    put: {
      tags: ['LINE Accounts'],
      summary: '既定アカウントを切り替える',
      responses: { '200': { description: '切り替えた' }, '409': { description: '停止中・保管済みは既定にできない' } },
    },
  },
  '/api/line-accounts/summary': {
    get: {
      tags: ['LINE Accounts'],
      summary: 'アカウントの合計（重複なし友だち数など）',
      responses: { '200': { description: '合計' } },
    },
  },
  '/api/line-accounts/{id}/handovers': {
    get: {
      tags: ['LINE Accounts'],
      summary: 'そのアカウントの引き継ぎ一覧',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: '一覧' } },
    },
  },
};
