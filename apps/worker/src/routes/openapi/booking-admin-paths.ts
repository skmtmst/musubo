// 実行時の副作用を混ぜず定義だけを置き、ハンドラは各機能の経路に保つ。
export const bookingAdminPaths = {
  '/api/booking/admin/makeup-credits/{id}/operations': {
    post: {
      tags: ['Booking'], summary: '振替の期限を延長する',
      description: 'オーナー・管理者が理由を添えて期限を延ばす。期限の短縮は不可。古い版は409。代理ログインでは変更できない。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', required: ['operation', 'expiresAt', 'reason', 'expectedVersion'], properties: {
          operation: { type: 'string', enum: ['extend'] }, expiresAt: { type: 'string', format: 'date-time' },
          reason: { type: 'string', minLength: 1, maxLength: 1000 }, expectedVersion: { type: 'integer', minimum: 0 },
        },
      } } } },
      responses: { '200': { description: '延長後の期限と版' }, '400': { description: '入力不正・短縮' }, '403': { description: '権限なし・代理ログイン' }, '404': { description: '振替または店舗なし' }, '409': { description: '版競合または変更できない状態' } },
    },
  },
  '/api/booking/admin/groups/{id}/cancellation-quote': {
    get: {
      tags: ['Booking'], summary: '組の予約を取り消す前に料金を確認する',
      description: '取消対象の各予約の料金と合計、組と各予約の版を返す。予約の変更や課金は行わない。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: { '200': { description: '各人の見積もりと合計額（円）' }, '400': { description: '入力不正' }, '403': { description: '店舗または予約の権限なし' }, '404': { description: '対象の組なし' } },
    },
  },
  // ── Booking detail edit / retry / audit  ─────────────
  '/api/booking/admin/bookings.csv': {
    get: {
      tags: ['Booking'], summary: '予約台帳をCSVで書き出す',
      description: '一覧（/api/booking/admin/requests）と同じ絞り込み（status・query・menu_name・staff_id・source・from・to）を受け付け、画面に見えている分だけをCSVで返す。最大5000件までで、打ち切ったときは先頭の注記行に件数上限を明記する。UTF-8 BOM付きCRLF。',
      parameters: [
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'status', in: 'query', required: false, schema: { type: 'string', default: 'requested' } },
        { name: 'query', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'menu_name', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'staff_id', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'source', in: 'query', required: false, schema: { type: 'string', enum: ['liff', 'phone', 'counter', 'operator', 'import'] } },
        { name: 'from', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'to', in: 'query', required: false, schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: '予約台帳CSV（text/csv、BOM付き、最大5000件）' },
        '400': { description: 'account_id 未指定' },
        '403': { description: '台帳の閲覧権限がない、または担当外アカウント' },
      },
    },
  },
  '/api/booking/admin/bookings/{id}': {
    get: {
      tags: ['Booking'], summary: '予約の詳細と確定LINEの見本を取得',
      description: '既存の所属・閲覧権限で読む。confirmationPreviewTextは実送信と同じレンダラーの見本で、取得だけでは送信・予定・決済を作らない。本人用の履歴案内はLIFF設定と実際の変更・取消期限に従う。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: '既存の予約詳細。見本はLINE連携したrequested/confirmedで返し、対象外はnull。',
          content: { 'application/json': { schema: { type: 'object', properties: {
            booking: { type: 'object', properties: { confirmationPreviewText: { type: ['string', 'null'] } } },
          } } } } },
        '400': { description: 'account_id未指定' },
        '403': { description: '所属または閲覧権限なし' },
        '404': { description: '指定した店の予約が見つからない' },
      },
    },
    patch: {
      tags: ['Booking'], summary: '予約内容を版付きで変更',
      description: 'requested/confirmed の予約だけ変更できる。lock_version 必須の楽観ロックで、日時・担当・メニュー・料金・メモ・通知方針を変える。変更対象の予約自身は重なり・席数・資源ガードから外す。LINE未連携の予約へ送信系方針をオンにはできない。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', required: ['lock_version'],
        properties: {
          lock_version: { type: 'integer', minimum: 0 },
          menu_id: { type: 'string' },
          staff_id: { type: 'string' },
          starts_at: { type: 'string', format: 'date-time' },
          price: { type: 'integer', minimum: 0, maximum: 100000000 },
          customer_note: { type: ['string', 'null'], maxLength: 2000 },
          internal_note: { type: ['string', 'null'], maxLength: 2000 },
          notification_policy: {
            type: 'object',
            description: 'この予約だけの通知可否。変更したいキーだけ送る。',
            properties: {
              send_line_confirmation: { type: 'boolean' },
              day_before: { type: 'boolean' },
              hours_before: { type: 'boolean' },
            },
          },
          send_change_notification: { type: 'boolean', description: 'false で今回の変更案内を送らない' },
          reason: { type: 'string', maxLength: 200, description: '変更履歴に残す理由' },
        },
      } } } },
      responses: {
        '200': { description: '変更後の版・カレンダー同期・通知・リマインダの実績' },
        '400': { description: 'JSON不備または lock_version 未指定' },
        '404': { description: '予約または担当が対象アカウントに存在しない' },
        '409': { description: '版競合・変更不可の状態・枠の衝突' },
        '422': { description: 'メニュー未提供・過去日時・料金不備・方針不備・未連携への送信指定' },
      },
    },
  },
  '/api/booking/admin/bookings/{id}/reassign': {
    post: {
      tags: ['Booking'], summary: '予約を別の担当へ移す',
      description: '今の版で担当だけを変える。これからの予約で、今と違う担当のときだけ受け付け、必ず今の空き判定を通す。結果は PATCH /api/booking/admin/bookings/{id} と同じ形。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', required: ['staffId', 'notifyCustomer'],
        properties: {
          staffId: { type: 'string', minLength: 1, description: '移し先の担当ID' },
          notifyCustomer: { type: 'boolean', description: 'false でお客さまへの変更案内を送らない' },
        },
      } } } },
      responses: {
        '200': { description: '変更後の版・カレンダー同期・通知・リマインダの実績' },
        '400': { description: 'account_id 未指定または staffId・notifyCustomer の不備' },
        '404': { description: '予約または担当が対象アカウントに存在しない' },
        '409': { description: '過去の予約・同じ担当・枠の衝突・版競合' },
        '422': { description: 'メニュー未提供など変更できない内容' },
      },
    },
  },
  '/api/booking/admin/bookings/{id}/audit-logs': {
    get: {
      tags: ['Booking'], summary: '予約の変更履歴を新しい順に取得',
      description: '誰が・いつ・何を変えたかのappend-only履歴。対象アカウントの予約だけ返す。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 100 } },
      ],
      responses: {
        '200': { description: '変更履歴の一覧' },
        '400': { description: 'account_id 未指定' },
        '404': { description: '予約が対象アカウントに存在しない' },
      },
    },
  },
  '/api/booking/admin/bookings/{id}/sync/retry': {
    post: {
      tags: ['Booking'], summary: '失敗したGoogleカレンダー反映を現在の予約状態で再試行',
      description: 'retry_wait / permanent_failed の google_calendar 台帳行だけを対象に、同じ行を再利用して再実行する。確定予約は反映、取消・期限切れは削除、未設定は skipped で閉じる。実行中（queued）は409。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: '再試行の結果状態' },
        '400': { description: 'account_id 未指定' },
        '404': { description: '予約が対象アカウントに存在しない' },
        '409': { description: '再試行できる失敗が無い、または実行中' },
      },
    },
  },
  '/api/booking/admin/bookings/{id}/notifications/{runId}/retry': {
    post: {
      tags: ['Booking'], summary: '失敗したLINE通知を同じ台帳行のまま再送',
      description: 'confirmation_line の失敗行だけを対象に再送する。成功済み・取消済みは409、未連携の予約は422。再送の成否は台帳行へ error_code と共に残し、変更履歴にも記録する。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: '再送の結果と台帳の状態' },
        '400': { description: 'account_id 未指定' },
        '404': { description: '予約または台帳行が対象アカウントに存在しない' },
        '409': { description: '成功済み・取消済み・実行中' },
        '422': { description: 'LINE未連携の予約' },
      },
    },
  },
  // ── Booking staff breaks  ────────────────────────────────────
  '/api/booking/admin/staff/{id}/breaks': {
    get: {
      tags: ['Booking'],
      summary: '担当者の休憩一覧取得',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: { '200': { description: 'Breaks with version' }, '404': { description: 'Staff not in account' } },
    },
    put: {
      tags: ['Booking'],
      summary: '担当者の休憩を週全体で置き換え',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { expectedVersion: { type: 'string' }, breaks: { type: 'array', maxItems: 28, items: { type: 'object', properties: { id: { type: 'string' }, weekday: { type: 'integer', minimum: 0, maximum: 6 }, start_time: { type: 'string' }, end_time: { type: 'string' } }, required: ['weekday', 'start_time', 'end_time'] } } }, required: ['breaks', 'expectedVersion'] } } } },
      responses: { '200': { description: 'Replaced with version' }, '400': { description: 'Invalid request' }, '403': { description: 'Owner or admin role required' }, '404': { description: 'Staff not in account' }, '409': { description: 'Version conflict' }, '422': { description: 'Invalid weekday, overlap, outside hours, or time range' } },
    },
  },
  '/api/booking/admin/staff/{id}/break-dates': {
    get: {
      tags: ['Booking'],
      summary: '担当者の日付指定の休憩一覧取得',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: { '200': { description: 'Date breaks with version' }, '404': { description: 'Staff not in account' } },
    },
    put: {
      tags: ['Booking'],
      summary: '担当者の日付指定の休憩を全体で置き換え',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { expectedVersion: { type: 'string' }, breaks: { type: 'array', maxItems: 366, items: { type: 'object', properties: { id: { type: 'string' }, work_date: { type: 'string' }, start_time: { type: 'string' }, end_time: { type: 'string' } }, required: ['work_date', 'start_time', 'end_time'] } } }, required: ['breaks', 'expectedVersion'] } } } },
      responses: { '200': { description: 'Replaced with version' }, '400': { description: 'Invalid request' }, '403': { description: 'Owner or admin role required' }, '404': { description: 'Staff not in account' }, '409': { description: 'Version conflict' }, '422': { description: 'Invalid date, DST gap, overlap, outside hours, or time range' } },
    },
  },
  // ── Booking staff self link  ─────────────────────────────
  '/api/booking/admin/staff/me': {
    get: {
      tags: ['Booking'],
      summary: 'ログイン中ユーザーに紐づく予約スタッフの一覧（本人勤務の対象解決）',
      parameters: [
        { name: 'account_id', in: 'query', required: false, schema: { type: 'string' }, description: '指定時はそのアカウントの紐づけだけを返す。省略時は全アカウント分。' },
      ],
      responses: {
        '200': { description: 'Linked booking staff records' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'booking.staff.own permission required (staff role)' },
      },
    },
  },
  // ── Booking staff×menu matrix bulk save  ──────────────────
  '/api/booking/admin/staff-menus': {
    get: {
      tags: ['Booking'],
      summary: '担当者×メニューの割り当て表を全員分まとめて読む（#1060: 一覧のN+1解消）',
      description: 'アカウント内の全スタッフ×全メニューの割り当てを1応答で返す。応答は一括PUTと同じ `{ staff: [{ staff_id, matrix }] }` の形で、matrix は未割当のメニューも is_offered=0 で含む（単独GET `/api/booking/admin/staff/{id}/menus` と同じ器）。',
      parameters: [
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: 'スタッフごとの割り当て表（staff_id × 全メニュー分のmatrix）' },
        '400': { description: 'account_id 未指定' },
        '403': { description: 'このLINEアカウントを表示する権限がない' },
      },
    },
    put: {
      tags: ['Booking'],
      summary: '担当者×メニューの割り当てを全員分まとめて置き換え（全件成功または全件不適用）',
      parameters: [
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { staff: { type: 'array', items: { type: 'object', properties: { staff_id: { type: 'string' }, menus: { type: 'array', items: { type: 'object', properties: { menu_id: { type: 'string' }, is_offered: { type: 'boolean' }, override_duration_minutes: { type: ['integer', 'null'] }, override_price: { type: ['integer', 'null'] } }, required: ['menu_id', 'is_offered'] } } }, required: ['staff_id', 'menus'] } } }, required: ['staff'] } } } },
      responses: { '200': { description: 'Replaced' }, '400': { description: 'Invalid request' }, '403': { description: 'Owner or admin role required' }, '404': { description: 'Staff or menu not found in account' }, '422': { description: 'Duplicate staff_id' } },
    },
  },
};
