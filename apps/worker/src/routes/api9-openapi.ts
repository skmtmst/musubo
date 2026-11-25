/** API-9: 管理APIとLIFF本人APIの契約。 */
type Schema = Record<string, unknown>;
const string: Schema = { type: 'string' },
  integer: Schema = { type: 'integer', minimum: 0 };
function operation(
  summary: string,
  params: string[],
  body?: Schema,
  query: Record<string, Schema> = {},
) {
  return {
    summary,
    tags: ['API-9'],
    parameters: [
      ...params.map((name) => ({
        name,
        in: 'path',
        required: true,
        schema: string,
      })),
      ...Object.entries(query).map(([name, schema]) => ({
        name,
        in: 'query',
        required: [
          'lineAccountId',
          'q',
          'liffId',
          'storeId',
          'date',
          'guestCount',
          'state',
          'code',
          'hub.mode',
          'hub.verify_token',
          'hub.challenge',
        ].includes(name),
        schema,
      })),
    ],
    ...(body
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: body } },
          },
        }
      : {}),
    responses: {
      '200': {
        description:
          'successとdata。下書きはcontent・version・expiresAt、会話はtotal・messagesまたはhits・カーソル',
      },
      '201': { description: '新規保存' },
      '400': { description: '入力不正' },
      '401': { description: '未認証' },
      '403': { description: '権限不足・閲覧のみ' },
      '404': { description: '対象外アカウントまたは期限切れ' },
      '409': { description: '版の競合' },
      '413': { description: '保存容量超過' },
    },
  };
}
export const api9Paths: Record<string, unknown> = {
  '/api/friend-add-rules/folders/{id}': {
    delete: {
      ...operation('友だち追加のフォルダを削除し、設定を未分類へ戻す', ['id'], undefined, { account_id: string }),
      requestBody: {
        required: false,
        content: { 'application/json': { schema: {
          type: 'object', properties: { accountId: string },
        } } },
      },
      description: 'account_id または本文の accountId が必須。owner/admin のみ。公開版・実行履歴は削除しない。処理中の改名・色変更・削除は409。',
      responses: {
        '200': { description: 'フォルダのみ削除', content: { 'application/json': { schema: {
          type: 'object', required: ['success', 'data'], properties: {
            success: { const: true }, data: {
              type: 'object', required: ['id', 'deleted'], properties: { id: string, deleted: { const: true } },
            },
          },
        } } } },
        '400': { description: 'アカウント未指定・入力不正' },
        '401': { description: '未認証' },
        '403': { description: '権限不足・閲覧のみ' },
        '404': { description: 'フォルダなし・アカウントまたはテナント越境' },
        '409': { description: '処理中にフォルダが更新された（VERSION_CONFLICT）' },
        '500': { description: '削除失敗（変更は巻き戻す）' },
      },
    },
  },
  '/api/scenario-drafts/{key}': {
    get: operation('配信に使わないシナリオ下書きを読む', ['key'], undefined, {
      lineAccountId: string,
    }),
    put: operation(
      '下書きを30日保存。新規expectedVersion=0、更新は読んだ版を指定',
      ['key'],
      {
        type: 'object',
        required: ['expectedVersion', 'content'],
        properties: {
          expectedVersion: {
            oneOf: [
              { type: 'integer', const: 0 },
              { type: 'string', format: 'uuid' },
            ],
          },
          content: { type: 'object', additionalProperties: true },
          scenarioId: { type: ['string', 'null'] },
          stepId: { type: ['string', 'null'] },
        },
      },
      { lineAccountId: string },
    ),
    delete: operation(
      '読んだ版の下書きを削除',
      ['key'],
      {
        type: 'object',
        required: ['expectedVersion'],
        properties: { expectedVersion: { type: 'string', format: 'uuid' } },
      },
      { lineAccountId: string },
    ),
  },
  '/api/chats/{friendId}/messages/search': {
    get: operation(
      'NFKC・大小をそろえた本文部分一致。total・id・at・前後の抜粋・位置cursorを返す',
      ['friendId'],
      undefined,
      {
        q: { type: 'string', minLength: 1, maxLength: 200 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
        offset: integer,
      },
    ),
  },
  '/api/chats/{friendId}/messages': {
    get: operation(
      'cursorAt/cursorIdでbefore・after・aroundの会話を読む。totalと次のcursorを返す',
      ['friendId'],
      undefined,
      {
        cursorAt: { type: 'string', format: 'date-time' },
        cursorId: string,
        direction: { type: 'string', enum: ['before', 'after', 'around'] },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
    ),
  },
};
const liff = (
  summary: string,
  params: string[] = [],
  body?: Schema,
  query: Record<string, Schema> = {},
) => ({
  ...operation(summary, params, body, { liffId: string, ...query }),
  security: [],
  description:
    '管理APIキーは不要。liffIdで指定した店舗のLINE Login IDトークンをAuthorization: Bearerに渡す。飲食店機能の有効な検証環境だけ。',
  parameters: [
    ...operation(summary, params, body, { liffId: string, ...query })
      .parameters,
    { name: 'Authorization', in: 'header', required: true, schema: string },
  ],
});
const customerDetails = {
  note: {type:['string','null'],maxLength:200,description:'ご要望（任意）。空欄またはnullで消す'},
  customerPhone: {type:['string','null'],maxLength:50,description:'電話（任意）。全角・空白・括弧・ハイフンを受け、0始まりの国内10〜11桁を確認して半角数字だけ保存。空欄またはnullで消す'},
};
const lateArrivalPolicy = {type:'object',required:['cancelAfterMinutes','message'],properties:{cancelAfterMinutes:{type:'integer',minimum:1,maximum:1440},message:{type:'string',minLength:1,maxLength:1000}}};
const unavailableReason = {type:'string',enum:['temporary_closed','private_event','regular_closed','full']};
const versionBody = {
  type: 'object',
  required: ['expectedVersion'],
  properties: { expectedVersion: { type: 'integer', minimum: 1 } },
};
Object.assign(api9Paths, {
  '/api/liff/restaurant/link/{token}': {
    get: liff('発行したリンクの対象店舗だけを読む', ['token']),
  },
  '/api/liff/restaurant/availability': {
    get: liff(
      '営業時間・休業・貸切・卓・仮押さえ・席待ち・LINE受付枠を反映した120分の席の空き',
      [],
      undefined,
      {
        storeId: string,
        date: { type: 'string', format: 'date' },
        guestCount: { type: 'integer', minimum: 1, maximum: 100 },
      },
    ),
  },
  '/api/liff/restaurant/holds': {
    post: liff(
      '本人の仮押さえ。再実行は同じrequestId、違う入力の使い回しは409。holdExpiresAtとversionを返す',
      [],
      {
        type: 'object',
        required: ['storeId', 'startsAt', 'guestCount', 'requestId'],
        properties: {
          storeId: string,
          startsAt: { type: 'string', format: 'date-time' },
          guestCount: { type: 'integer', minimum: 1, maximum: 100 },
          requestId: { type: 'string', pattern: '^[a-zA-Z0-9_-]{8,128}$' },
          ...customerDetails,
        },
      },
    ),
  },
  '/api/liff/restaurant/reservations': {
    get: liff(
      '本人の席予約の履歴。id・日時・人数・状態・versionを返す',
      [],
      undefined,
      { storeId: string },
    ),
  },
  '/api/liff/restaurant/reservations/{id}/confirm': {
    post: liff(
      '期限内の仮押さえを確定し、自動LINEと媒体閉鎖の作業を台帳に作る',
      ['id'],
      {...versionBody,properties:{...versionBody.properties,...customerDetails}},
    ),
  },
  '/api/liff/restaurant/reservations/{id}/cancel': {
    post: liff(
      '取消期限と版を確認し、枠を戻す。期限超過は403',
      ['id'],
      versionBody,
    ),
  },
  '/api/liff/restaurant/reservations/{id}/reschedule': {
    post: liff('変更期限と版、変更後の空きを確認して原子的に移す', ['id'], {
      type: 'object',
      required: ['expectedVersion', 'startsAt', 'guestCount'],
      properties: {
        expectedVersion: { type: 'integer', minimum: 1 },
        startsAt: { type: 'string', format: 'date-time' },
        guestCount: { type: 'integer', minimum: 1, maximum: 100 },
      },
    }),
  },
  '/api/auto-replies/unmatched-settings': {
    get: operation(
      'LINEでキーワードに当たらないときの返事。未設定はmessage:null、version:0',
      [],
      undefined,
      { lineAccountId: string },
    ),
    put: operation(
      'LINEでキーワードに当たらないときの返事を版付き保存。nullで送信を止める',
      [],
      {
        type: 'object',
        required: ['expectedVersion', 'message'],
        properties: {
          expectedVersion: integer,
          message: { type: ['string', 'null'], minLength: 1, maxLength: 5000 },
        },
      },
      { lineAccountId: string },
    ),
  },
  '/api/instagram/connection': {
    get: operation(
      'Instagramの接続状態。設定なしはunconfigured、replyEnabledで現在の接続の返信可否を返す',
      [],
      undefined,
      { lineAccountId: string },
    ),
    delete: operation(
      'トークンと保存したDMを消して接続を切る。owner/adminのみ',
      [],
      versionBody,
      { lineAccountId: string },
    ),
  },
  '/api/instagram/connections': {
    get: operation(
      '同じLINEアカウントのInstagram接続を全件、画面に出す順で読む。合鍵は返さない',
      [],
      undefined,
      { lineAccountId: string },
    ),
  },
  '/api/instagram/oauth/start': {
    post: operation(
      '操作者・アカウントを固定した10分のOAuthを開始。owner/adminのみ',
      [],
      { type: 'object' },
      { lineAccountId: string },
    ),
  },
  '/api/instagram/oauth/callback': {
    get: operation(
      'stateを一度だけ消費し、ビジネスアカウントのページを自動採用して接続を保存。設定>SNS連携へ戻す',
      [],
      undefined,
      { state: string, code: string },
    ),
  },
  '/api/instagram/refresh': {
    post: operation(
      '期限内のトークンを更新し、ページとInstagramを再照合。期限切れは再接続',
      [],
      { type: 'object' },
      { lineAccountId: string },
    ),
  },
  '/api/instagram/sync': {
    post: operation(
      'プロフィールと最近の25投稿を同期。Meta本文や秘密値をエラーへ出さない',
      [],
      { type: 'object' },
      { lineAccountId: string },
    ),
  },
  '/api/instagram/profile': {
    get: operation(
      '保存したプロフィールを読む。未取得value:null',
      [],
      undefined,
      { lineAccountId: string },
    ),
  },
  '/api/instagram/posts': {
    get: operation('保存した新着投稿を読む。未取得value:null', [], undefined, {
      lineAccountId: string,
    }),
  },
  '/api/instagram/messages': {
    get: operation(
      '署名で検査して保存したDMを可視アカウントで読む',
      [],
      undefined,
      {
        lineAccountId: string,
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        beforeId: string,
      },
    ),
  },
  '/api/instagram/messages/{id}/reply': {
    post: operation(
      '受信から24時間以内のDMへ返信（Idempotency-Key必須）',
      ['id'],
      { type: 'object', properties: { text: string } },
      { lineAccountId: string },
    ),
  },
  '/api/instagram/webhook': {
    get: {
      ...operation('MetaのWebhook登録確認', [], undefined, {
        'hub.mode': string,
        'hub.verify_token': string,
        'hub.challenge': string,
      }),
      security: [],
      responses: {
        '200': { description: '検証したchallengeの文字列' },
        '403': { description: '確認用トークンが不一致' },
      },
    },
    post: {
      ...operation(
        'X-Hub-Signature-256を未加工の本文で検証し、宛先のDMだけ重複なく保存',
        [],
        { type: 'object' },
      ),
      security: [],
      parameters: [
        {
          name: 'X-Hub-Signature-256',
          in: 'header',
          required: true,
          schema: string,
        },
      ],
      responses: {
        '200': { description: '受け付けた（重複は追加しない）' },
        '400': { description: '壊れたJSON' },
        '401': { description: '署名が一致しない' },
        '413': { description: '1MiB超過' },
        '503': { description: 'Metaアプリ未設定' },
      },
    },
  },
});

// 画面が使う主要な戻り値も記載し、数値の版と下書きのUUID版を取り違えないようにする。
export const api9Schemas: Record<string, Schema> = {
  ScenarioEditDraft: {
    type: 'object',
    required: [
      'key',
      'lineAccountId',
      'content',
      'version',
      'updatedAt',
      'expiresAt',
    ],
    properties: {
      key: string,
      lineAccountId: string,
      content: { type: 'object', additionalProperties: true },
      scenarioId: { type: ['string', 'null'] },
      stepId: { type: ['string', 'null'] },
      version: { type: 'string', format: 'uuid' },
      updatedBy: string,
      updatedAt: { type: 'string', format: 'date-time' },
      expiresAt: { type: 'string', format: 'date-time' },
    },
  },
  ConversationCursor: {
    type: 'object',
    required: ['at', 'id'],
    properties: { at: string, id: string },
  },
  ConversationMessage: {
    type: 'object',
    required: [
      'id',
      'content',
      'isUnsent',
      'createdAt',
      'direction',
      'messageType',
    ],
    properties: {
      id: string,
      content: string,
      isUnsent: { type: 'boolean' },
      createdAt: string,
      eventAt: { type: ['string', 'null'] },
      direction: { type: 'string', enum: ['incoming', 'outgoing'] },
      messageType: string,
    },
  },
  ConversationMessagePage: {
    type: 'object',
    required: ['messages', 'total', 'beforeCursor', 'afterCursor'],
    properties: {
      total: integer,
      messages: {
        type: 'array',
        items: { $ref: '#/components/schemas/ConversationMessage' },
      },
      beforeCursor: {
        anyOf: [
          { $ref: '#/components/schemas/ConversationCursor' },
          { type: 'null' },
        ],
      },
      afterCursor: {
        anyOf: [
          { $ref: '#/components/schemas/ConversationCursor' },
          { type: 'null' },
        ],
      },
    },
  },
  ConversationSearchResult: {
    type: 'object',
    required: ['total', 'hits', 'nextOffset'],
    properties: {
      total: integer,
      nextOffset: { type: ['integer', 'null'] },
      hits: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'at', 'excerpt', 'before', 'after', 'cursor'],
          properties: {
            id: string,
            at: string,
            excerpt: string,
            before: {
              type: ['object', 'null'],
              properties: { id: string, excerpt: string },
            },
            after: {
              type: ['object', 'null'],
              properties: { id: string, excerpt: string },
            },
            cursor: { $ref: '#/components/schemas/ConversationCursor' },
          },
        },
      },
    },
  },
  RestaurantCustomerBooking: {
    type: 'object',
    required: [
      'id',
      'storeId',
      'startsAt',
      'endsAt',
      'guestCount',
      'status',
      'version',
      'holdExpiresAt',
      'note',
      'customerPhone',
      'seatType',
    ],
    properties: {
      id: string,
      storeId: string,
      startsAt: { type: 'string', format: 'date-time' },
      endsAt: { type: 'string', format: 'date-time' },
      guestCount: { type: 'integer', minimum: 1, maximum: 100 },
      status: string,
      version: { type: 'integer', minimum: 1 },
      holdExpiresAt: { type: ['string', 'null'] },
      ...customerDetails,
      seatType: {type:['string','null']},
      courseId:{type:['string','null']},
      courseName:{type:['string','null']},
    },
  },
  AutoReplyUnmatchedSettings: {
    type: 'object',
    required: ['lineAccountId', 'message', 'version', 'updatedBy', 'updatedAt'],
    properties: {
      lineAccountId: string,
      message: { type: ['string', 'null'], maxLength: 5000 },
      version: integer,
      updatedBy: { type: ['string', 'null'] },
      updatedAt: { type: ['string', 'null'] },
    },
  },
};
function documentResponse(
  path: string,
  method: string,
  schema: Schema,
  status = '200',
) {
  const op = (
    api9Paths[path] as Record<
      string,
      { responses: Record<string, { description: string; content?: unknown }> }
    >
  )[method];
  op.responses[status] = {
    ...op.responses[status],
    description: op.responses[status]?.description ?? '成功',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['success', 'data'],
          properties: { success: { const: true }, data: schema },
        },
      },
    },
  };
}
for (const method of ['get', 'put'])
  documentResponse('/api/scenario-drafts/{key}', method, {
    $ref: '#/components/schemas/ScenarioEditDraft',
  });
documentResponse(
  '/api/scenario-drafts/{key}',
  'put',
  { $ref: '#/components/schemas/ScenarioEditDraft' },
  '201',
);
documentResponse('/api/chats/{friendId}/messages', 'get', {
  $ref: '#/components/schemas/ConversationMessagePage',
});
documentResponse('/api/chats/{friendId}/messages/search', 'get', {
  $ref: '#/components/schemas/ConversationSearchResult',
});
for (const method of ['get', 'put'])
  documentResponse('/api/auto-replies/unmatched-settings', method, {
    $ref: '#/components/schemas/AutoReplyUnmatchedSettings',
  });
for (const action of ['confirm', 'cancel', 'reschedule'])
  documentResponse(`/api/liff/restaurant/reservations/{id}/${action}`, 'post', {
    $ref: '#/components/schemas/RestaurantCustomerBooking',
  });
documentResponse(
  '/api/liff/restaurant/holds',
  'post',
  { $ref: '#/components/schemas/RestaurantCustomerBooking' },
  '201',
);
documentResponse('/api/liff/restaurant/holds', 'post', {
  $ref: '#/components/schemas/RestaurantCustomerBooking',
});
documentResponse('/api/liff/restaurant/reservations', 'get', {
  type: 'array',
  items: { $ref: '#/components/schemas/RestaurantCustomerBooking' },
});

documentResponse('/api/liff/restaurant/availability','get',{
  type:'object',required:['storeId','date','guestCount','slots','cancelDeadlineMinutesBefore','cutoffMinutesBefore'],
  properties:{storeId:string,date:{type:'string',format:'date'},guestCount:{type:'integer',minimum:1,maximum:100},unavailableReason,lateArrivalPolicy,
    cancelDeadlineMinutesBefore:integer,cutoffMinutesBefore:integer,
    slots:{type:'array',items:{type:'object',required:['startsAt','endsAt','available','remainingTables','seatTypes'],properties:{startsAt:{type:'string',format:'date-time'},endsAt:{type:'string',format:'date-time'},available:{type:'boolean'},remainingTables:integer,seatTypes:{type:'array',items:string},unavailableReason}}}}
});
const hours = {type:'array',minItems:7,maxItems:7,items:{type:'object',required:['weekday','periods'],properties:{weekday:{type:'integer',minimum:0,maximum:6},periods:{type:'array',items:{type:'object',required:['opensAt','closesAt'],properties:{opensAt:string,closesAt:string}}}}}};
api9Paths['/api/restaurant-test/opening-hours']={
  get:operation('営業時間と遅刻の案内を読む',[],undefined,{account_id:string,storeId:string}),
  put:operation('営業時間と遅刻の案内を版付きで保存。lateArrivalPolicy省略なら維持、nullなら解除',[],{type:'object',required:['storeId','hours','expectedVersion'],properties:{storeId:string,hours,expectedVersion:integer,lateArrivalPolicy:{...lateArrivalPolicy,type:['object','null']}}},{account_id:string})
};
documentResponse('/api/restaurant-test/opening-hours','get',{type:'object',properties:{storeId:string,hours:{...hours,type:['array','null']},version:integer,updatedBy:{type:['string','null']},updatedAt:{type:['string','null']},lateArrivalPolicy:{...lateArrivalPolicy,type:['object','null']}}});
documentResponse('/api/restaurant-test/opening-hours','put',{type:'object',properties:{storeId:string,hours,version:integer}});
api9Paths['/api/restaurant-test/reservation-link']={post:operation('店舗自身のLIFF IDで席予約リンクを発行。未設定・停止アカウントは503',[],{type:'object',required:['storeId'],properties:{storeId:string}},{account_id:string})};
documentResponse('/api/restaurant-test/reservation-link','post',{type:'object',required:['url','html','available'],properties:{url:{type:'string',format:'uri',description:'https://liff.line.me/<店舗のLIFF ID>?page=restaurant&token=<token>'},html:string,available:{type:'boolean',const:true}}});

for (const endpoint of ['/api/liff/restaurant/holds','/api/liff/restaurant/reservations/{id}/reschedule']) {
 const op=api9Paths[endpoint] as any;
 op.post.requestBody.content['application/json'].schema.properties.courseId={type:['string','null'],description:'同じ店舗の公開コース。未指定は席のみ120分'};
}
(api9Paths['/api/liff/restaurant/availability'] as any).get.parameters.push({name:'courseId',in:'query',required:false,schema:{type:'string'}});
