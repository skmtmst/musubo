const account = { name: 'accountId', in: 'path', required: true, schema: { type: 'string' } };
const id = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
function operation(summary: string, hasId = false) {
  return {
    tags: ['Chats'],
    summary,
    parameters: hasId ? [account, id] : [account],
    responses: {
      200: { description: '指定した店舗の処理結果' },
      403: { description: '権限がありません' },
      404: { description: '対象が見つかりません' },
    },
  };
}
export const accountEmailPaths = {
  '/api/account-email/{accountId}/connection': {
    get: operation('メールの接続状態を取得。転送先などの設定値は管理者のみ'),
    post: {
      ...operation('店舗の専用アドレスを発行'),
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['mailbox'],
              properties: { mailbox: { type: 'string', format: 'email' } },
            },
          },
        },
      },
    },
    delete: {
      ...operation('転送先を失効し、接続を解除'),
      parameters: [
        account,
        {
          name: 'If-Match',
          in: 'header',
          required: true,
          schema: { type: 'string' },
          description: '確認画面で取得した connectionId',
        },
      ],
    },
  },
  '/api/account-email/{accountId}/connection/verify': {
    post: operation('元の店舗窓口に転送確認メールを送信・再送'),
  },
  '/api/account-email/{accountId}/inbox': { get: operation('接続中の店舗メールの一覧・検索・件数') },
  '/api/account-email/{accountId}/threads/{id}': { get: operation('店舗メール会話の履歴と添付情報', true) },
  '/api/account-email/{accountId}/threads/{id}/status': {
    patch: operation('会話の対応状況を版番号つきで更新', true),
  },
  '/api/account-email/{accountId}/threads/{id}/read': {
    post: operation('担当者ごとに店舗メールを既読にする', true),
  },
  '/api/account-email/{accountId}/read-all': { post: operation('担当者ごとに店舗メールをすべて既読にする') },
  '/api/account-email/{accountId}/attachments/{id}': {
    get: {
      ...operation('店舗内の添付をダウンロード', true),
      responses: {
        200: {
          description: '添付ファイル',
          content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
        },
        404: { description: '添付が見つかりません' },
      },
    },
  },
};
