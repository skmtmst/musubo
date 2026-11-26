// 実行時の副作用を混ぜず定義だけを置き、ハンドラは各機能の経路に保つ。
export const chatsPaths = {
  '/api/instagram/inbox-status': {
    get: { tags: ['Chats'], summary: 'Instagram受信箱の接続とDM権限を確認',
      parameters: [{ name: 'lineAccountId', in: 'query', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'ready、permission_required、disconnected のいずれか' } } },
  },
  '/api/instagram/conversations/{senderId}': {
    get: {
      tags: ['Chats'], summary: 'Instagram の会話を取得',
      parameters: [
        { name: 'instagramId', in: 'query', schema: { type: 'string' }, description: '会話を受信したInstagramアカウント' },
        { name: 'senderId', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'lineAccountId', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: { '200': { description: '会話と返信可否' }, '401': { description: '認証が必要' }, '403': { description: '権限がありません' } },
    },
  },
  '/api/instagram/conversations/{senderId}/read': {
    post: {
      tags: ['Chats'], summary: 'Instagram の会話を既読にする',
      parameters: [
        { name: 'instagramId', in: 'query', schema: { type: 'string' }, description: '会話を受信したInstagramアカウント' },
        { name: 'senderId', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'lineAccountId', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: { '200': { description: '既読を記録' }, '401': { description: '認証が必要' }, '403': { description: '権限がありません' }, '404': { description: '会話が見つかりません' } },
    },
  },
  '/api/instagram/conversations/{senderId}/resolve': {
    post: {
      tags: ['Chats'], summary: 'Instagramで確認した送信結果を記録する',
      parameters: [
        { name: 'instagramId', in: 'query', schema: { type: 'string' }, description: '会話を受信したInstagramアカウント' },
        { name: 'senderId', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'lineAccountId', in: 'query', required: true, schema: { type: 'string' } },
      ],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['key','outcome'],
        properties: {
          key: { type: 'string' },
          outcome: { type: 'string', enum: ['sent','not_sent'] },
          reason: { type: 'string', maxLength: 500, description: '未送信と判断した確認理由（省略時はMeta側の会話を照合する）' },
        } } } } },
      responses: { '200': { description: '送信結果を記録' }, '401': { description: '認証が必要' }, '403': { description: '権限がありません' }, '404': { description: '会話が見つかりません' }, '409': { description: '未確認または競合' }, '502': { description: 'Meta側の会話を確認できません' } },
    },
  },
  /*
   * 画像と本文を1回の送信単位にする。2回に分けると画像だけが
   * 先に届く部分送信になる。片方だけの送信もこの口で受け付ける。
   */
  '/api/chats/{id}/send-combined': {
    post: {
      tags: ['Chats'],
      summary: '画像と本文（複数可）を1回で送信',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                image: {
                  type: 'object',
                  properties: {
                    originalContentUrl: { type: 'string' },
                    previewImageUrl: { type: 'string' },
                  },
                },
                text: { type: 'string' },
                texts: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'パック送信の本文（挿入順）。text と合わせて画像含め最大5通',
                },
                revision: { type: 'integer' },
                quotedMessageId: { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: 'Sent' },
        '400': { description: 'Idempotency-Key が無い／内容が壊れている' },
        '404': { description: 'Chat not found' },
        '409': { description: '版が食い違う／同じ鍵で内容が違う' },
      },
    },
  },
  /*
   * 送信内容の差し込み解決プレビュー。/send と同じ解決器を通し、
   * 未解決のまま残る差し込み名を返す(送信はそれらを400で拒否する)。
   * 読み取りのみ。LINE呼出し・履歴書込みは行わない。
   */
  '/api/chats/{id}/render-preview': {
    post: {
      tags: ['Chats'],
      summary: '差し込みを解決した送信プレビューを返す',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                messageType: { type: 'string' },
                content: { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: '解決済み本文と未解決の差し込み名' },
        '400': { description: 'content が無い／壊れている' },
        '404': { description: 'Chat not found' },
      },
    },
  },
  /*
   * 返信の送信予約。作成は Idempotency-Key 必須で、時刻は未来のみ。
   * 予約の実行はcronのscheduledジョブがlease付きで行う。
   */
  '/api/chats/{id}/schedule': {
    post: {
      tags: ['Chats'],
      summary: '返信を予約送信する',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                messageType: { type: 'string', enum: ['text', 'flex', 'image', 'video', 'file'], default: 'text' },
                content: { type: 'string', description: '添付は送信口と同じJSON。ファイルの予約はアップロードから30日以内。' },
                scheduledAt: { type: 'string', format: 'date-time' },
                quotedMessageId: { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: 'Scheduled' },
        '400': { description: 'Idempotency-Key・本文・日時のいずれかが不正' },
        '404': { description: 'Chat not found／引用元のメッセージが無い' },
      },
    },
  },
  '/api/chats/{id}/scheduled': {
    get: {
      tags: ['Chats'],
      summary: '会話の送信予約一覧（待機中・送信中）',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'Pending scheduled sends' },
        '404': { description: 'Chat not found' },
      },
    },
  },
  '/api/chats/{id}/scheduled/{scheduleId}': {
    patch: {
      tags: ['Chats'],
      summary: '送信予約の日時・本文を変更',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'scheduleId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                scheduledAt: { type: 'string', format: 'date-time' },
                content: { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: 'Updated' },
        '400': { description: '変更項目が無い／値が不正' },
        '404': { description: '予約が見つかりません' },
        '409': { description: '送信処理が始まっている／処理済み' },
      },
    },
    delete: {
      tags: ['Chats'],
      summary: '送信予約を取消',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'scheduleId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: 'Cancelled' },
        '404': { description: '予約が見つかりません' },
        '409': { description: '送信処理が始まっている／処理済み' },
      },
    },
  },
  '/api/chats/quick-counts': {
    get: {
      tags: ['Chats'],
      summary: '受信箱クイック絞り込み（すべて／要返信／1時間以上待ち）の件数を現在の条件で集計',
      parameters: [
        { name: 'status', in: 'query', schema: { type: 'string' } },
        { name: 'operatorId', in: 'query', schema: { type: 'string' } },
        { name: 'assignee', in: 'query', schema: { type: 'string' } },
        { name: 'unreadOnly', in: 'query', schema: { type: 'string', enum: ['1', 'true'] } },
        { name: 'channel', in: 'query', schema: { type: 'string', enum: ['all', 'line', 'email'] } },
        { name: 'lineAccountId', in: 'query', schema: { type: 'string' } },
        { name: 'q', in: 'query', schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: 'Counts { all, reply, overdue } scoped to the current filters and visible channel' },
        '400': { description: 'channel が不正' },
        '403': { description: 'Staff role required' },
        '404': { description: 'LINE account not found in account scope' },
      },
    },
  },
  '/api/chats/outbound-failures': {
    get: {
      tags: ['Chats'],
      summary: '個別送信の失敗台帳をLINEアカウント範囲内で取得',
      parameters: [
        { name: 'lineAccountId', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer' } },
      ],
      responses: {
        '200': { description: 'Scoped outbound send failures with safe failure codes' },
        '400': { description: 'lineAccountId が未指定' },
        '403': { description: 'Staff role required' },
        '404': { description: 'LINE account not found in account scope' },
      },
    },
  },
};
