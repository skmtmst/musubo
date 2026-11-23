// 実行時の副作用を混ぜず定義だけを置き、ハンドラは各機能の経路に保つ。
export const bookingSettingsPaths = {
  // ── Booking settings  ────────────────────────────────────────
  '/api/booking/admin/settings': {
    get: {
      tags: ['Booking'],
      summary: '店舗共通の予約ルールを取得',
      description: '設定行がまだ無い店舗は、表示と初回保存に使う version=0 の既定値を返す。この取得ではDB行を作成しない。businessHoursConfigured=false の0行曜日は後方互換で営業時間制限なし、true の0行曜日は休業。',
      parameters: [
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: '店舗共通ルール、メニュー件数、営業時間、例外日' },
        '403': { description: 'このLINEアカウントを表示する権限がない' },
        '404': { description: 'LINEアカウントが存在しない' },
        '503': { description: '設定を取得できない' },
      },
    },
    put: {
      tags: ['Booking'],
      summary: '店舗共通の予約ルールを版付きで作成・更新',
      description: 'expectedVersion=0 は設定行が無い実在店舗だけに初回行を作る。既存行は版一致時だけ更新する。businessHoursを指定した場合は7曜日を原子的に置換し、0行曜日を休業として明示設定する。',
      parameters: [
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: [
                'expectedVersion', 'timeZone', 'bookingWindowDays',
                'cutoffMinutesBefore', 'cancelDeadlineMinutesBefore',
                'maxActiveBookingsPerFriend', 'approvalMode', 'holdMinutes',
                'slotGranularityMinutes',
              ],
              properties: {
                expectedVersion: { type: 'integer', minimum: 0 },
                timeZone: { type: 'string', minLength: 1, maxLength: 100 },
                bookingWindowDays: { type: 'integer', minimum: 1, maximum: 365 },
                cutoffMinutesBefore: { type: 'integer', minimum: 0, maximum: 43200 },
                cancelDeadlineMinutesBefore: { type: 'integer', minimum: 0, maximum: 43200 },
                maxActiveBookingsPerFriend: { type: 'integer', minimum: 1, maximum: 100 },
                approvalMode: { type: 'string', enum: ['automatic', 'manual'] },
                holdMinutes: { type: 'integer', minimum: 1, maximum: 1440 },
                slotGranularityMinutes: { type: 'integer', enum: [5, 10, 15, 30, 60] },
                businessHours: {
                  type: 'array', minItems: 7, maxItems: 7,
                  description: 'weekday 0（日曜）〜6（土曜）を各1回。空のintervalsは休業。24:00と日またぎは不可。',
                  items: {
                    type: 'object',
                    required: ['weekday', 'intervals'],
                    properties: {
                      weekday: { type: 'integer', minimum: 0, maximum: 6 },
                      intervals: {
                        type: 'array', maxItems: 8,
                        items: {
                          type: 'object', required: ['start', 'end', 'capacity'],
                          properties: {
                            start: { type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' },
                            end: { type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' },
                            capacity: { type: 'integer', minimum: 1, maximum: 1000 },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: 'Updated' },
        '201': { description: 'Created' },
        '400': { description: 'Invalid request' },
        '403': { description: 'Owner or admin role required, or account is outside access scope' },
        '404': { description: 'LINE account not found' },
        '409': { description: 'Version conflict' },
        '503': { description: 'Settings unavailable' },
      },
    },
  },
  '/api/booking/admin/exceptions/{id}': {
    delete: {
      tags: ['Booking'],
      summary: '予約の例外日（休業日・臨時営業）を版付きで削除',
      description: '消す直前の版を expectedVersion で確認し、先に別の変更が入っていたら409で止める。別アカウントのIDは404として隠す。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', additionalProperties: false, required: ['expectedVersion'],
        properties: { expectedVersion: { type: 'integer', minimum: 1 } },
      } } } },
      responses: {
        '200': { description: 'Deleted' },
        '400': { description: 'Invalid request' },
        '403': { description: 'Owner or admin role required, or account is outside access scope' },
        '404': { description: '例外日が存在しない' },
        '409': { description: '版競合' },
        '503': { description: '例外日を削除できない' },
      },
    },
  },
  '/api/booking/admin/resources': {
    get: {
      tags: ['Booking'], summary: '予約設備を利用状況と版付きで一覧取得',
      parameters: [{ name: 'account_id', in: 'query', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: '設備、版、更新日時、メニュー・予約・例外日の参照件数' },
        '403': { description: 'このLINEアカウントを表示する権限がない' },
        '503': { description: '設備を取得できない' },
      },
    },
    post: {
      tags: ['Booking'], summary: '予約設備を作成',
      parameters: [{ name: 'account_id', in: 'query', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', additionalProperties: false, required: ['name', 'type', 'capacity'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          type: { type: 'string', minLength: 1, maxLength: 50 },
          capacity: { type: 'integer', minimum: 1, maximum: 1000 },
          isActive: { type: 'boolean', default: true },
        },
      } } } },
      responses: {
        '201': { description: '作成済み設備' }, '400': { description: 'Invalid request' },
        '403': { description: 'Owner or admin role required, or account is outside access scope' },
        '503': { description: '設備を作成できない' },
      },
    },
  },
  '/api/booking/admin/resources/{id}': {
    patch: {
      tags: ['Booking'], summary: '予約設備を版付きで変更・停止・再開',
      description: '稼働中の設備は、将来予約の最大同時使用量またはメニュー割当の必要数を下回るcapacityへ縮小できない。メニュー割当が競合する場合は、先にメニュー側の設備割当を変更する。停止は既存予約を残して新規受付だけを閉じる。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', additionalProperties: false, required: ['expectedVersion'],
        anyOf: [
          { required: ['name'] },
          { required: ['type'] },
          { required: ['capacity'] },
          { required: ['isActive'] },
        ],
        properties: {
          expectedVersion: { type: 'integer', minimum: 1 },
          name: { type: 'string', minLength: 1, maxLength: 100 },
          type: { type: 'string', minLength: 1, maxLength: 50 },
          capacity: { type: 'integer', minimum: 1, maximum: 1000 },
          isActive: { type: 'boolean' },
        },
      } } } },
      responses: {
        '200': { description: '変更済み設備' }, '400': { description: 'Invalid request' },
        '403': { description: 'Owner or admin role required, or account is outside access scope' },
        '404': { description: '設備が存在しない' },
        '409': { description: '版競合、予約使用量を下回る縮小、またはメニュー割当の必要数を下回る縮小（先にメニュー割当を変更）' },
        '503': { description: '設備を変更できない' },
      },
    },
    delete: {
      tags: ['Booking'], summary: '未参照の予約設備を版付きで削除',
      description: 'メニュー、予約時点の消費snapshot、資源例外日から参照中なら削除せず、停止を案内する。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', additionalProperties: false, required: ['expectedVersion'],
        properties: { expectedVersion: { type: 'integer', minimum: 1 } },
      } } } },
      responses: {
        '200': { description: 'Deleted' }, '400': { description: 'Invalid request' },
        '403': { description: 'Owner or admin role required, or account is outside access scope' },
        '404': { description: '設備が存在しない' },
        '409': { description: '版競合または参照中' },
        '503': { description: '設備を削除できない' },
      },
    },
  },
  '/api/booking/admin/menus/{id}/resources': {
    put: {
      tags: ['Booking'], summary: '予約メニューへ必要な設備と数量を版付きで一括割当',
      description: '割当全体を原子的に置換する。停止中・別アカウント・不存在の設備は同じエラーで拒否し、既存予約の設備snapshotは変更しない。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', additionalProperties: false, required: ['expectedVersion', 'resources'],
        properties: {
          expectedVersion: { type: 'integer', minimum: 1 },
          resources: {
            type: 'array', maxItems: 30, uniqueItems: true,
            items: {
              type: 'object', additionalProperties: false, required: ['resourceId', 'quantity'],
              properties: {
                resourceId: { type: 'string', minLength: 1 },
                quantity: { type: 'integer', minimum: 1, maximum: 1000 },
              },
            },
          },
        },
      } } } },
      responses: {
        '200': { description: '更新後のメニュー版と、この保存で確定した割当' },
        '400': { description: '入力不備、または設備を利用できない' },
        '403': { description: 'Owner or admin role required, or account is outside access scope' },
        '404': { description: '対象アカウントにメニューが存在しない' },
        '409': { description: 'メニュー版が更新済み' },
        '503': { description: '設備割当を保存できない' },
      },
    },
  },
  // ── Booking menu versions / snapshots (T: 予約の設定の版と予約の写し) ──
  '/api/booking/admin/menus/{id}/versions': {
    get: {
      tags: ['Booking'], summary: '予約メニューの版の履歴',
      description: '保存するたびに増える版を新しい順に返す。いちばん新しい版だけ status が in_use。過去の版は変えない。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: '版の一覧（版番号・見出し・札・ひとこと・中身の行）' },
        '400': { description: 'account_id 未指定' },
        '404': { description: '対象アカウントにメニューが存在しない' },
      },
    },
  },
  '/api/booking/admin/menus/{id}/versions/{version}': {
    get: {
      tags: ['Booking'], summary: '予約メニューの指定版の中身',
      description: '比べる画面に行の一覧で返す。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'version', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: '指定版の中身（版番号・見出し・札・ひとこと・中身の行）' },
        '400': { description: 'account_id 未指定' },
        '404': { description: '対象アカウントにメニューまたは版が存在しない' },
      },
    },
  },
  '/api/booking/admin/menus/{id}/hq-status': {
    get: {
      tags: ['Booking'], summary: '本部から配られた予約メニューの版と知らせ',
      description: 'bound=false なら本部の配布物ではない（本部でひな形を消した後や、出所の記録が食い違う物は detached に理由を返し、知らせも出さない）。customized は店が変えた印（「この店専用（統括から）」）。pendingVersion があれば「本部の新しい版があります」で、notices に知らせる理由（store_edited）を返す。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: { '200': { description: '本部の版・届いている版・店が変えたか' }, '400': { description: 'account_id 未指定' }, '403': { description: '担当外のアカウント' }, '404': { description: '対象アカウントにメニューが存在しない' } },
    },
  },
  '/api/booking/admin/menus/{id}/hq-adopt': {
    post: {
      tags: ['Booking'], summary: '本部の新しい版を取り込む',
      description: '届いている版だけを取り込む。店が変えた所も本部の中身に戻り「統括から」になる。受付中か・並び順・担当・既存の予約の値段の控えは変えない。画面が見ていた版と違えば 409 で何も書かない。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['versionId'], properties: { versionId: { type: 'string' } } } } } },
      responses: { '200': { description: '取り込んだ版' }, '400': { description: 'account_id または versionId 未指定' }, '403': { description: 'メニューを保存する権限がない・閲覧のみ' }, '404': { description: '本部から配られたメニューではない' }, '409': { description: '届いている版が変わった・本部のひな形が使えない・店のタグが無い' }, '422': { description: 'この店は予約を使っていない' } },
    },
  },
  '/api/booking/admin/menus/{id}/hq-dismiss': {
    post: {
      tags: ['Booking'], summary: '本部の新しい版を取り込まず今のままにする',
      description: 'その版の知らせだけを消す。次の版が届けばまた知らせる。メニューは書き換えない。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['versionId'], properties: { versionId: { type: 'string' } } } } } },
      responses: { '200': { description: '知らせを閉じた版' }, '400': { description: 'account_id または versionId 未指定' }, '403': { description: 'メニューを保存する権限がない・閲覧のみ' }, '404': { description: '本部から配られたメニューではない' }, '409': { description: '届いている版が変わった' } },
    },
  },
  '/api/booking/admin/menus/{id}/versions/{version}/revert': {
    post: {
      tags: ['Booking'], summary: '予約メニューを指定版に戻す',
      description: '昔の版は変えず、その中身で新しい版を作る。読み直さずに送った古い版は 409 で止める。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'version', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', additionalProperties: false, required: ['expectedVersion'],
        properties: { expectedVersion: { type: 'integer', minimum: 1 } },
      } } } },
      responses: {
        '200': { description: '新しい版の番号' },
        '400': { description: 'expectedVersion の不足または形式不正' },
        '403': { description: 'メニューを保存する権限がない' },
        '404': { description: '対象アカウントにメニューまたは版が存在しない' },
        '409': { description: 'メニュー版が更新済み' },
      },
    },
  },
  '/api/booking/admin/availability-check': {
    get: {
      tags: ['Booking'],
      summary: '指定した日時に予約を受けられるかと、受けられない場合の理由を確認',
      description: '予約設定画面の「この日時はなぜ取れないか」用。読み取り専用で予約は作らない。判定は実際の空き枠計算と同じ入力・同じ手順を使い、受けられない場合は理由コード（勤務外・休業日・所要時間超過・既存予約との重複・外部カレンダーの予定・定員・設備不足など）を返す。他担当の非公開予定の件名・相手など詳細は含めない。',
      parameters: [
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'menu_id', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'staff_id', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'date', in: 'query', required: true, schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
        { name: 'time', in: 'query', required: true, schema: { type: 'string', pattern: '^\\d{2}:\\d{2}$' } },
      ],
      responses: {
        '200': { description: 'bookable（受けられるか）、reasons（理由コードの一覧）、per_staff（担当ごとの可否・残数・理由）' },
        '400': { description: 'account_id・menu_id・date・time の不足または形式不正' },
        '403': { description: 'このLINEアカウントを表示する権限がない' },
      },
    },
  },
};
