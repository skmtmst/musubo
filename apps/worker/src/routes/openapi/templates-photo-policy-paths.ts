// 実行時の副作用を混ぜず定義だけを置き、ハンドラは各機能の経路に保つ。
export const templatesPhotoPolicyPaths = {
  '/api/templates/bulk-delete': {
    post: {
      tags: ['Templates'], summary: '確認したテンプレートを一括削除',
      description: '最大50件。確認時の版と使用状況がすべて一致した場合だけまとめて削除する。',
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', required: ['templates'], properties: { templates: { type: 'array', minItems: 1, maxItems: 50, items: {
          type: 'object', required: ['id', 'expectedRevision'], properties: { id: { type: 'string', minLength: 1 }, expectedRevision: { type: 'integer', minimum: 1 } },
        } } },
      } } } },
      responses: { '200': { description: '削除完了' }, '400': { description: '入力不正' }, '403': { description: '操作権限がない' }, '404': { description: '対象が担当範囲にない' }, '409': { description: '版または使用状況が変化した' } },
    },
  },
  // ── Templates ( 公開版固定) ─────────────────────────────────────────
  '/api/templates/{id}/versions': {
    get: {
      tags: ['Templates'],
      summary: 'テンプレートの版の履歴を新しい版から返す',
      description: '公開のたびに足した版を新しい順に返す。前の版は変わらない。status は in_use（いま使っている）/ reserved（予約）/ past（過去）。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: '版の一覧 { versionNumber・status・messageType・messageContent・effectiveFrom・createdAt・createdByStaffId・creatorName・creatorNameSource }。creatorNameは同じ組織の現在の名簿名（source=current_staff_profile）。旧版・不明・別組織はnull。公開時の名前の写しではない。' },
        '404': { description: 'Not found in account scope' },
      },
    },
  },
  '/api/templates/{id}/revert': {
    post: {
      tags: ['Templates'],
      summary: '指定の版の中身で新しい版を作る',
      description: '過去の版は変えない。その中身を下書きへ写して公開する。Idempotency-Key ヘッダ(必須)で再試行を見分ける。版(expectedVersion)が進んでいたら409。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 200 }, description: '公開操作の確認キー。必須。同じキーの再試行は同じ結果を返す。' },
      ],
      requestBody: { content: { 'application/json': { schema: {
        type: 'object',
        required: ['versionNumber', 'expectedVersion'],
        properties: {
          versionNumber: { type: 'integer', minimum: 1, description: '戻す版の番号。必須。無い版は404。' },
          expectedVersion: { type: 'integer', minimum: 0, description: '確認したときの公開版。必須。進んでいたら409。' },
        },
      } } } },
      responses: {
        '200': { description: '戻す成功。data に publishedVersion・hasDraft を返す。' },
        '400': { description: '確認キー不足・版の番号が数でない' },
        '404': { description: 'Not found in account scope・戻す版が無い' },
        '409': { description: '公開版の同時更新の負け・下書きの書き換わり・確認キーの別操作への使い回し' },
      },
    },
  },
  // ── Photo reward policy ( 報酬の決まりの版) ─────────────────────────
  '/api/nen-members/photo-reward-policy/versions': {
    get: {
      tags: ['NenMembers'],
      summary: '報酬の決まりの版の履歴を新しい版から返す',
      description: '保存のたびに足した版を新しい順に返す。前の版は変わらない。status は in_use（いま使っている）/ reserved（予約）/ past（過去）。第1版は既存の5pt固定（legacy-5）。',
      responses: {
        '200': { description: '版の一覧 { versionNumber・policyKey・points・summary・effectiveFrom・status }' },
        '403': { description: '写真審査の表示権限がない' },
      },
    },
    post: {
      tags: ['NenMembers'],
      summary: '報酬の決まりの新しい版を作る',
      description: '番号は「いまの最大＋1」。前の版は変えない。Idempotency-Key ヘッダ(必須)で再試行を見分ける。同じ確認キーの再送では版を増やさない。owner・admin だけ。',
      parameters: [
        { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 200 }, description: '保存操作の確認キー。必須。同じキーの再試行は同じ結果を返す。' },
      ],
      requestBody: { content: { 'application/json': { schema: {
        type: 'object',
        required: ['points'],
        properties: {
          points: { type: 'integer', minimum: 1, maximum: 100000, description: '採用1枚につき付ける点数。必須。' },
          summary: { type: 'string', description: '版の中身のひとこと（例：報酬を5pt→10ptに）。' },
          effectiveFrom: { type: 'string', description: '使い始めの日時。空は公開と同時。未来の日時は予約の札。' },
          expectedVersion: { type: 'integer', minimum: 1, description: '確認したときの最新版。省略可。進んでいたら409。' },
        },
      } } } },
      responses: {
        '200': { description: '保存成功。data に created・version を返す。' },
        '400': { description: '確認キー不足・点数が範囲外・日時の形が不正' },
        '403': { description: 'owner・admin 以外' },
      },
    },
  },
  '/api/nen-members/photo-reward-policy/revert': {
    post: {
      tags: ['NenMembers'],
      summary: '指定の版の中身で報酬の決まりの新しい版を作る',
      description: '過去の版は変えない。その中身（点数・ひとこと）で新しい版を作る。使い始めは空（公開と同時）。Idempotency-Key ヘッダ(必須)で再試行を見分ける。owner・admin だけ。',
      parameters: [
        { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 200 }, description: '保存操作の確認キー。必須。同じキーの再試行は同じ結果を返す。' },
      ],
      requestBody: { content: { 'application/json': { schema: {
        type: 'object',
        required: ['versionNumber'],
        properties: {
          versionNumber: { type: 'integer', minimum: 1, description: '戻す版の番号。必須。無い版は404。' },
        },
      } } } },
      responses: {
        '200': { description: '戻す成功。data に created・version を返す。' },
        '400': { description: '確認キー不足・版の番号が数でない' },
        '403': { description: 'owner・admin 以外' },
        '404': { description: '戻す版が無い' },
      },
    },
  },
  '/api/templates/{id}/publish': {
    post: {
      tags: ['Templates'],
      summary: 'テンプレートの下書きを公開版へ写す',
      description: 'Idempotency-Key ヘッダ(必須)で再試行を見分ける。下書きがなくても成功し、その確認キーを版・下書き版・下書き指紋つきで記録する。同じ確認キー・同じ内容の再試行は記録時の版・本文をそのまま返す(固定応答)。同じ確認キーで別の下書きを出す使い回しは409。公開版(expectedVersion)・下書き版(expectedDraftRevision)が進んでいたら409。新規作成は未公開(版0)で始まり、初回の公開で版1になる。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 200 }, description: '公開操作の確認キー。必須。同じキーの再試行は同じ結果を返す。' },
      ],
      requestBody: { content: { 'application/json': { schema: {
        type: 'object',
        required: ['expectedVersion', 'expectedDraftRevision'],
        properties: {
          expectedVersion: { type: 'integer', minimum: 0, description: '確認したときの公開版。必須。進んでいたら409。' },
          expectedDraftRevision: { type: 'integer', minimum: 0, description: '確認したときの下書き版。必須。書き換わっていたら409。' },
        },
      } } } },
      responses: {
        '200': { description: '公開成功 { published: true }・再試行 { published: false, replayed: true }・下書きなし成功 { published: false, replayed: false }。data に publishedVersion・publishedAt・hasDraft・draftRevision を返す。' },
        '400': { description: '確認キー不足・版の番号が数でない' },
        '404': { description: 'Not found in account scope' },
        '409': { description: '公開版の同時更新の負け・下書きの書き換わり・確認キーの別操作への使い回し' },
      },
    },
  },
  '/api/templates/examples': {
    get: {
      tags: ['Templates'],
      summary: 'テンプレートの見本4件を返す（F5・副作用なし）',
      description: '営業時間のご案内・キャンペーンのお知らせ・予約の受付・来店のお礼とクーポンの4件。本文と画像の置き場・安定IDだけを返す。DBへの書き込み・送信はしない。',
      responses: {
        '200': { description: '見本4件 { id・name・body・imageSlot }' },
      },
    },
  },
  '/api/broadcast-message-assets/{id}/publish': {
    post: {
      tags: ['Broadcasts'],
      summary: '配信素材の下書きを公開版へ写す（F4）',
      description: 'Idempotency-Key ヘッダ(必須)で再試行を見分ける。公開版(expectedVersion)・下書き版(expectedDraftRevision)が進んでいたら409。新規作成は未公開(版0)で始まり、初回の公開で版1になる。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 200 }, description: '公開操作の確認キー。必須。同じキーの再試行は同じ結果を返す。' },
      ],
      requestBody: { content: { 'application/json': { schema: {
        type: 'object',
        required: ['expectedVersion', 'expectedDraftRevision'],
        properties: {
          expectedVersion: { type: 'integer', minimum: 0, description: '確認したときの公開版。必須。進んでいたら409。' },
          expectedDraftRevision: { type: 'integer', minimum: 0, description: '確認したときの下書き版。必須。書き換わっていたら409。' },
        },
      } } } },
      responses: {
        '200': { description: '公開成功 { published: true }・再試行 { published: false, replayed: true }。data に publishedVersion・publishedAt・hasDraft・draftRevision を返す。' },
        '400': { description: '確認キー不足・版の番号が数でない' },
        '404': { description: 'Not found in account scope' },
        '409': { description: '公開版の同時更新の負け・下書きの書き換わり・確認キーの別操作への使い回し' },
      },
    },
  },
  '/api/broadcast-message-assets/{id}/versions': {
    get: {
      tags: ['Broadcasts'],
      summary: '配信素材の版の履歴を新しい版から返す（F4）',
      description: '公開のたびに足した版を新しい順に返す。前の版は変わらない。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: '版の一覧 { versionNumber・payload・createdAt }' },
        '404': { description: 'Not found in account scope' },
      },
    },
  },
  '/api/broadcast-message-assets/folders': {
    get: {
      tags: ['Broadcasts'],
      summary: '配信素材の置き場一覧を取得（F4）',
      description: '素材専用の置き場（独立表）。既存foldersは触らない。アカウント可視範囲で絞る。',
      parameters: [
        { name: 'lineAccountId', in: 'query', schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: '置き場の一覧 { id・lineAccountId・name }' },
        '403': { description: 'LINEアカウントの表示権限なし' },
      },
    },
    post: {
      tags: ['Broadcasts'],
      summary: '配信素材の置き場を作る（F4）',
      description: '素材専用の置き場（独立表）。名前は必須。',
      requestBody: { content: { 'application/json': { schema: {
        type: 'object',
        required: ['name'],
        properties: {
          lineAccountId: { type: 'string', description: 'LINEアカウント。空は未割当。' },
          name: { type: 'string', description: '置き場の名前。必須。' },
        },
      } } } },
      responses: {
        '201': { description: '置き場を作成 { id・lineAccountId・name }' },
        '400': { description: '名前不足' },
        '403': { description: 'LINEアカウントの操作権限なし' },
      },
    },
  },
  '/api/postal-code/search': {
    get: {
      tags: ['Forms'],
      summary: '郵便番号から住所の候補を返す（F11・外部通信なし）',
      description: '日本郵便の公開データを取り込んだ表を読む。候補が複数ある番号は1つに潰さず全部返し、total に全件数を載せる（件数での打ち切りはしない）。手入力の住所は残る。全量未取り込みの環境では readiness.fullDataset が false。',
      parameters: [
        { name: 'code', in: 'query', schema: { type: 'string' }, description: '郵便番号（123-4567 または 1234567）。先頭0を保つ。' },
      ],
      responses: {
        '200': { description: '候補 { normalized・status・candidates・total・readiness }。status は matched・multiple・none・invalid。total は候補の全件数。' },
      },
    },
  },
};
