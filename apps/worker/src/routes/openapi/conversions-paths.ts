// 実行時の副作用を混ぜず定義だけを置き、ハンドラは各機能の経路に保つ。
export const conversionsPaths = {
  // ── Conversions ─────────────────────────────────────────────────────────
  '/api/conversions/definitions/{id}/revise': {
    post: {
      tags: ['Conversions'],
      summary: '成果地点を履歴を保ったまま編集して次の版にする',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['expectedVersion', 'name', 'sourceType', 'deduplicationMode', 'valueMode', 'reversalPolicy'],
              properties: {
                expectedVersion: { type: 'integer', minimum: 1 },
                name: { type: 'string', minLength: 1, maxLength: 120 },
                sourceType: { type: 'string' },
                sourceConfig: { type: 'object' },
                deduplicationMode: { type: 'string', enum: ['every', 'once_per_friend', 'window'] },
                deduplicationWindowDays: { type: ['integer', 'null'], minimum: 1, maximum: 365 },
                valueMode: { type: 'string', enum: ['source', 'fixed', 'none'] },
                fixedValue: { type: ['number', 'null'], minimum: 0 },
                reversalPolicy: { type: 'string', enum: ['source_cancelled', 'manual', 'none'] },
                attributionDays: { type: ['integer', 'null'], minimum: 1, maximum: 365 },
                targetUrl: { type: ['string', 'null'], maxLength: 2000 },
                reason: { type: 'string', maxLength: 200 },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: '次の版になった。過去の成果と集計額は変わらない' },
        '400': { description: '入力または expectedVersion が不正' },
        '403': { description: '編集の権限が無い' },
        '404': { description: '見えない・存在しない成果地点' },
        '409': { description: '版が進んでいる・停止済み・同名がある（副作用は残さない）' },
      },
    },
  },
  '/api/conversions/definitions/{id}/publish': {
    post: {
      tags: ['Conversions'],
      summary: '下書きの成果地点を公開して計測をはじめる',
      description: '下書き(status=draft)の成果地点だけを計測中(active)へ進める。'
        + '公開前の下書きは成果を数えない。過去の記録を失う変更ではない。',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['expectedVersion'],
              properties: { expectedVersion: { type: 'integer', minimum: 1 } },
            },
          },
        },
      },
      responses: {
        '200': { description: '計測中になった' },
        '400': { description: 'expectedVersion が不正' },
        '404': { description: '見えない・存在しない成果地点' },
        '409': { description: '版が進んでいる・下書きではない' },
      },
    },
  },
  '/api/conversions/definitions/{id}/ingest-secret': {
    post: {
      tags: ['Conversions'],
      summary: '外部受信の鍵を発行・再発行する',
      description: 'POST /api/conversions/ingest/{id} で使う HMAC 署名の鍵を発行する。'
        + '平文の鍵はこの応答でだけ返り、DBには暗号化して保存する。'
        + '再発行は古い鍵をその場で無効にする。',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['expectedVersion'],
              properties: { expectedVersion: { type: 'integer', minimum: 1 } },
            },
          },
        },
      },
      responses: {
        '200': { description: '発行した鍵(平文はこの応答のみ)と受信URL' },
        '400': { description: 'expectedVersion が不正' },
        '404': { description: '見えない・存在しない成果地点' },
        '409': { description: '版が進んでいる' },
      },
    },
  },
  '/api/conversions/definitions/{id}/ingest-disable': {
    post: {
      tags: ['Conversions'],
      summary: '外部からの成果受信を止める(起点停止)',
      description: '受信鍵は消さずに受け口だけ止める。再開は ingest-enable。'
        + '止めている間の受信は拒否として受信履歴に残る。',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['expectedVersion'],
              properties: { expectedVersion: { type: 'integer', minimum: 1 } },
            },
          },
        },
      },
      responses: {
        '200': { description: '外部受信を止めた' },
        '400': { description: 'expectedVersion が不正' },
        '404': { description: '見えない・存在しない成果地点' },
        '409': { description: '版が進んでいる' },
      },
    },
  },
  '/api/conversions/definitions/{id}/ingest-enable': {
    post: {
      tags: ['Conversions'],
      summary: '止めた外部受信を再開する',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['expectedVersion'],
              properties: { expectedVersion: { type: 'integer', minimum: 1 } },
            },
          },
        },
      },
      responses: {
        '200': { description: '外部受信を再開した' },
        '400': { description: 'expectedVersion が不正' },
        '404': { description: '見えない・存在しない成果地点' },
        '409': { description: '版が進んでいる' },
      },
    },
  },
  '/api/conversions/definitions/{id}/ingest-events': {
    get: {
      tags: ['Conversions'],
      summary: '外部受信の成否履歴',
      description: '受け取った/再送/拒否の記録。署名・本文・秘密値は含まず、'
        + '署名のSHA-256と本文の項目名だけ残す。isTest=true は検証の受信'
        + '(成果表には書かず実績へ混入しない)。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
      ],
      responses: {
        '200': { description: '受信の成否履歴(新しい順)' },
        '404': { description: '見えない・存在しない成果地点' },
      },
    },
  },
  '/api/conversions/definitions/{id}/events': {
    get: {
      tags: ['Conversions'],
      summary: '成果1件ずつの一覧',
      description: 'IDEA-19: 成果名の下に1件ごとの状態を返す。status は'
        + ' confirmed(確定)/pending(確認待ち)/rejected(却下)/cancelled(取消)で、'
        + '承認状態と取消台帳から導出済み。検証の受信は成果表へ書かないため'
        + 'この一覧には本番実績だけが並ぶ。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
      ],
      responses: {
        '200': { description: '成果の一覧(新しい順)' },
        '404': { description: '見えない・存在しない成果地点' },
      },
    },
  },
  '/api/conversions/ingest/{id}': {
    post: {
      tags: ['Conversions'],
      summary: '外部システムからの成果受信(公開口・HMAC署名)',
      description: '本文のtimestamp（UNIX秒、前後300秒以内）とnonce（英数字・_・-の16〜128字）も署名の対象。nonceは地点ごとに1回だけ。正規再試行は新nonceと同じsourceEventId。管理認証を通さない公開口。X-Conversion-Signature ヘッダに'
        + '本文のHMAC-SHA256(hex)を、X-Conversion-Event-Id または本文の sourceEventId に'
        + '再送を捌くイベントIDを入れる。成否は受信履歴に残る。',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['timestamp','nonce'],
              properties: {
                timestamp: { type: 'integer', description: '署名した送信時刻（UNIX秒）' },
                nonce: { type: 'string', minLength: 16, maxLength: 128 },
                sourceEventId: { type: 'string', description: 'ヘッダの代わりに本文で渡せる' },
                friendId: { type: 'string' },
                lineUserId: { type: 'string' },
                value: { type: ['number', 'null'] },
                metadata: { type: 'object' },
                test: {
                  type: 'boolean',
                  description: 'true のとき検証の受信。同じ検査を通るが成果表には書かず、'
                    + '受信履歴にだけ残る(売上・報酬・集計へ混入しない)',
                },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: '受け取った。duplicated=true なら同じイベントの再送' },
        '400': { description: 'JSONが壊れている・sourceEventIdや友だち特定情報が無い' },
        '401': { description: '署名が無い・違う' },
        '403': { description: '外部受信が止められている' },
        '404': { description: '成果地点が存在しない' },
        '409': { description: '計測中でない・同IDの別内容' },
        '413': { description: '本文が大きすぎる(64KB超)' },
        '422': { description: '友だちが見つからない・対象外' },
        '503': { description: '受信鍵が未発行' },
      },
    },
  },
  '/api/conversions/approvals/bulk': {
    post: {
      tags: ['Conversions'],
      summary: '成果をまとめて承認・却下する',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['items'],
              properties: {
                items: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 100,
                  items: {
                    type: 'object',
                    required: ['id', 'status', 'expectedStatus'],
                    properties: {
                      id: { type: 'string' },
                      status: { type: 'string', enum: ['approved', 'rejected'] },
                      expectedStatus: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
                    },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: '成功ID・競合ID・権限拒否ID・失敗IDに分けて返す' },
        '400': { description: 'itemsが0件・101件以上' },
        '403': { description: '承認の権限が無い' },
      },
    },
  },
  '/api/conversions/points': {
    get: { tags: ['Conversions'], summary: 'CV ポイント一覧', responses: { '200': { description: 'All conversion points' } } },
    post: {
      tags: ['Conversions'],
      summary: 'CV ポイント作成',
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, eventType: { type: 'string' }, value: { type: 'number' } }, required: ['name', 'eventType'] } } } },
      responses: { '201': { description: 'Created' } },
    },
  },
  '/api/conversions/points/{id}': {
    delete: {
      tags: ['Conversions'],
      summary: 'CV ポイント削除',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Deleted' } },
    },
  },
  '/api/conversions/track': {
    post: {
      tags: ['Conversions'],
      summary: 'コンバージョン記録',
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { conversionPointId: { type: 'string' }, friendId: { type: 'string' }, userId: { type: 'string' }, affiliateCode: { type: 'string' }, metadata: { type: 'object' } }, required: ['conversionPointId', 'friendId'] } } } },
      responses: { '201': { description: 'Tracked' } },
    },
  },
  '/api/conversions/events': {
    get: {
      tags: ['Conversions'],
      summary: 'CV イベント一覧',
      parameters: [
        { name: 'conversionPointId', in: 'query', schema: { type: 'string' } },
        { name: 'friendId', in: 'query', schema: { type: 'string' } },
        { name: 'affiliateCode', in: 'query', schema: { type: 'string' } },
        { name: 'startDate', in: 'query', schema: { type: 'string' } },
        { name: 'endDate', in: 'query', schema: { type: 'string' } },
      ],
      responses: { '200': { description: 'Events' } },
    },
  },
  '/api/conversions/events/{id}/reversals': {
    get: {
      tags: ['Conversions'],
      summary: '成果の取消履歴(#819)',
      description: '取消・取消の取消を新しい順に返す。元の成果行は消えない。',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: '取消履歴' },
        '404': { description: '成果が見つからない' },
      },
    },
    post: {
      tags: ['Conversions'],
      summary: '成果の取消・取消の取消を追記(#819)',
      description: '追記型の台帳。kind=reverse は取り消し、kind=restore は'
        + '取り消しの取消。連投・未取り消しへの restore は 409。',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['kind', 'reason'],
              properties: {
                kind: { type: 'string', enum: ['reverse', 'restore'] },
                reason: { type: 'string', maxLength: 500 },
                expectedReversalId: { type: 'string', nullable: true },
                expectedApprovalStatus: { type: 'string', nullable: true, enum: ['pending', 'approved', 'rejected'] },
                expectedCancelled: { type: 'boolean' },
                expectedApprovalRevision: { type: 'integer', minimum: 1, description: '確認時の承認の版。指定時は取消ID・承認状態・取消状態も必要。' },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: '追記した台帳行' },
        '400': { description: 'kindが不正・理由が空' },
        '404': { description: '成果が見つからない' },
        '409': { description: '取消状態または確認した承認の版が変わった' },
      },
    },
  },
  '/api/conversions/events/{id}/attribution': {
    get: {
      tags: ['Conversions'],
      summary: '成果の付け方の記録(#823)',
      description: '候補になった紹介を並べ、付けた先と付けなかった理由を1件ずつ返す。記録が無い昔の成果は 404。',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: '付け方の記録 { reason・windowDays・candidates }' },
        '404': { description: '成果が見つからない・記録が無い' },
      },
    },
  },
  '/api/measurement-sites': {
    get: {
      tags: ['Conversions'],
      summary: '計測サイトと許可ドメイン・拒否の内訳(#819)',
      parameters: [{ name: 'account_id', in: 'query', schema: { type: 'string' } }],
      responses: { '200': { description: '計測サイト一覧' }, '400': { description: 'account_id が無い・権限外' } },
    },
    post: {
      tags: ['Conversions'],
      summary: '計測サイトを足す(#819)',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['label', 'domains'],
              properties: {
                accountId: { type: 'string' },
                label: { type: 'string', maxLength: 100 },
                domains: { type: 'array', items: { type: 'string' }, minItems: 1 },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: '作成したサイト(公開ID含む)' },
        '400': { description: '名前が無い・ドメインが0件' },
      },
    },
  },
  '/api/measurement-sites/{id}': {
    patch: {
      tags: ['Conversions'],
      summary: '計測サイトの名前・許可ドメインを更新(#819)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                label: { type: 'string', maxLength: 100 },
                domains: { type: 'array', items: { type: 'string' }, minItems: 1 },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: '更新した' },
        '400': { description: '入力が不正' },
        '404': { description: 'サイトが見つからない' },
      },
    },
  },
  '/api/measurement-sites/{id}/stop': {
    post: {
      tags: ['Conversions'],
      summary: '計測サイトの計測を止める(R275)。行は残し停止日時と理由を記録',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['reason'],
              properties: { reason: { type: 'string', maxLength: 200 } },
            },
          },
        },
      },
      responses: {
        '200': { description: '停止した' },
        '400': { description: '理由が無い・長すぎる' },
        '404': { description: 'サイトが見つからない' },
        '409': { description: 'すでに停止している' },
      },
    },
  },
  '/api/measurement-sites/{id}/resume': {
    post: {
      tags: ['Conversions'],
      summary: '停止した計測サイトの計測を再開する(R275)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: '再開した' },
        '404': { description: 'サイトが見つからない' },
        '409': { description: '停止していない' },
      },
    },
  },
  '/api/ad-costs/{id}/cancel': {
    post: {
      tags: ['Conversions'],
      summary: '手入力の広告費を取消する(R275)。行は残し取消日時と理由を記録',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['reason'],
              properties: { reason: { type: 'string', maxLength: 200 } },
            },
          },
        },
      },
      responses: {
        '200': { description: '取消した' },
        '400': { description: '理由が無い・長すぎる' },
        '404': { description: '記録が見つからない' },
        '409': { description: '取込分または取消済み' },
      },
    },
  },
  '/api/public/web-conversions': {
    post: {
      tags: ['Conversions'],
      summary: '計測タグからの成果受信(公開口・サイトID+許可ドメイン)', security: [],
      description: '管理認証を通さない公開口。サイトIDは公開識別子で秘密ではない。'
        + '許可にないドメイン・同意が無い送信は数えず、常に204を返す'
        + '(設定の有無を外から推測させない)。許可外の来た先は件数と'
        + '最後の送信元だけ管理画面へ出す。友だちと結び付かない成果は'
        + '地点の「匿名を数える」設定が立つときだけ日別の合計へ足す。',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['siteId'],
              properties: {
                siteId: { type: 'string', description: 'site_ ではじまる公開ID' },
                visitorId: { type: 'string' },
                host: { type: 'string' },
                path: { type: 'string' },
                value: { type: ['number', 'null'] },
                sourceEventId: { type: 'string', description: '再送を捌くイベントID' },
                consent: { type: 'string', enum: ['granted'] },
                consentDecision: { type: 'string', enum: ['granted', 'declined'] },
              },
            },
          },
        },
      },
      responses: { '204': { description: '受け取った(成否は内部台帳のみ)' } },
    },
  },
  '/api/conversions/report': {
    get: {
      tags: ['Conversions'],
      summary: 'CV レポート',
      parameters: [
        { name: 'startDate', in: 'query', schema: { type: 'string' } },
        { name: 'endDate', in: 'query', schema: { type: 'string' } },
      ],
      responses: { '200': { description: 'Aggregated report' } },
    },
  },
};
