/**
 * 板ごとの開く場所（開く指定つき）。対応表の行が分類の画面をまとめて並べている・
 * 親の画面（/hq など）だけを書いている板は、ここで正しい場所を決める（監査 ROOT-19）。
 *
 * 読むもの：`build-v8-design-map.mjs`（撮影の対応表）・`build-v8-board-to-code.mjs`（板→コードの表）。
 * 足すときは、その画面の BEHAVIOR.md の「受け付ける URL と指定」と撮影の固定データの ID に合わせる。
 */
export const BOARD_URLS = {
  // 設定・通知の分類の行（そのほか／通知）
  y8QQV: '/notifications',
  g3iDs: '/line-notifications?tab=customer',
  u8xibp: '/line-notifications?tab=operator',
  DrwMm: '/line-notifications?tab=failures',
  PZBVb: '/line-notifications?tab=history',
  gjUz3: '/line-notifications/operator/new',
  V7vn3: '/accounts',
  ihjfd: '/accounts/detail?id=visual-qa-account',
  x2dSNv: '/accounts/handover?id=visual-qa-account',
  Y4LkX1: '/emergency?tab=health',
  I2V65v: '/emergency?tab=history',
  OHwbU: '/emergency?tab=control',
  GmVR5: '/ec-commerce',
  nAesv: '/ec-commerce',
  wqC8x: '/ec-commerce?tab=subscriptions',
  iLJmw: '/ec-commerce?tab=connector',
  w1W8h: '/ec-commerce/identity-candidates',
  u3iab3: '/pools',
  D0AOyx: '/pools/new',
  xuJ7D: '/getting-started',
  // 統括のバナー生成（行は /hq だけ。実際は /hq/banners と /hq/banners/project）
  B9ZAr: '/hq/banners',
  W7Z57: '/hq/banners',
  W5Wxr: '/hq/banners?tab=library',
  AnwtH: '/hq/banners?tab=library',
  iMnph: '/hq/banners/project?id=banner-project-qa-1',
  p03ImY: '/hq/banners/project?id=banner-project-qa-1',
  zOpMG: '/hq/banners/project?id=banner-project-qa-1',
  UcBQ5: '/hq/banners/project?id=banner-project-qa-1',
  rI5uh: '/hq/banners/project?id=banner-project-qa-1',
  B24oNg: '/hq/banners/project?id=banner-project-qa-1',
  I0w2e: '/hq/banners/project?id=banner-project-qa-1',
  // 親の画面（/hq・/ops）だけを書いていた板・入口が別の画面へ送る板（監査 ROOT-19 の残り・2026-10-08）
  // 統括のアカウント登録 ①〜⑤（手順は画面の中だけで持つ：v8/account-new/BEHAVIOR.md）
  xj3zz: '/accounts/new',
  JYfda: '/accounts/new',
  GwKE2: '/accounts/new',
  v2KMj: '/accounts/new',
  TvXII: '/accounts/new',
  // 統括のテンプレート（一覧と、その中の「アカウントへ配る」：v8/hq-templates/console.tsx）
  LRc93: '/hq/templates',
  meBRB: '/hq/templates',
  // 運営の代理ログイン中の帯は、入った先の統括のホームの上に出る（/ops は /ops/tenants へ送るだけ）
  VtJQ6: '/hq',
  // 自動応答の完了は作る画面の中（V8 の /auto-replies/publish は作る画面の手順へ送る）
  V4LjH: '/auto-replies/edit',
  // 予約設定の担当スタッフは予約設定のタブ（V8 の /booking/staff はこのタブと窓を共用）
  VLEaj: '/booking/menus?tab=staff',
  // ユーザーを追加・変更の窓は組織・権限の画面の中（v8/restaurant/organization）
  ou60i: '/restaurant-test/organization',
  // ログイン・はじめの設定のまとめ板は、V8 の画面がある「はじめの設定」へ（ログインは V8 の分けなし）
  BOj1a: '/getting-started',
  // 撮影の対応表が親の画面（/hq・/ops・一覧など）だけを書いていた板 → その板の画面（監査 ROOT-19 の残り・2026-10-08）
  Gqve5: '/affiliates/new', // 成果とアフィリエイト アフィリエイターを作る（競合）V8
  RaMf3: '/affiliates/new', // 成果とアフィリエイト アフィリエイターを作る V8
  G83vi: '/analytics/reports/new', // 分析 レポートを作る（競合）V8
  H5UoIu: '/analytics/reports/new', // 分析 レポートを作る V8
  M4torY: '/automations/new', // オートメーション ルールを作る V8
  tJqST: '/automations/new', // オートメーション ルールを作る（競合）V8
  g98F9: '/automations/runs', // オートメーション 動いた記録 V8
  cXqlS: '/conversions/new', // コンバージョン 作る（競合）V8
  j8p3yj: '/conversions/new', // コンバージョン 作る V8
  hmr2P: '/events/change-review?id=ev-1', // イベント予約 変更の確認 V8
  d4adD4: '/events/new', // イベント予約 イベントを作る V8
  JB8V1: '/hq/billing', // 統括 請求 V8
  BHEl9: '/hq/members', // 統括 メンバー（権限を変更する）V8
  r4ARpV: '/hq/members', // 統括 メンバー V8
  yLKwV: '/hq/members', // 統括 メンバー（権限者を招待）V8
  K7HYu: '/hq/settings', // 統括 統括の情報 V8
  D6fh3: '/hq/support', // 統括 お問い合わせ（運営のLINEを登録）V8
  b8xBtZ: '/hq/support', // 統括 お問い合わせ V8
  OhguS: '/hq/support/detail', // 統括 お問い合わせ（やり取り）V8
  X4JcOf: '/hq/templates', // 統括 テンプレート（ひな形を作る）V8
  KMaMk: '/inflow-links/new', // 流入と計測 作る V8
  vWJEm: '/inflow-links/new', // 流入と計測 作る（競合）V8
  BnrQp: '/mileage/earning-rules/new', // マイル たまる決めごとを作る（競合）V8
  ctLwT: '/mileage/earning-rules/new', // マイル たまる決めごとを作る V8
  M8zhjL: '/mileage/friends/detail?id=friend-1&adjust=1', // マイル マイルを手で増やす・減らす V8
  yRDwW: '/nen-campaigns/columns/new', // NEN配信 コラムを書く V8
  w5pwG: '/nen-campaigns/edit', // NEN配信 配信を直す（口コミのお願い）V8
  tQ2MJ: '/ops/announcements', // 運営 お知らせ V8
  e7ljE: '/ops/audit', // 運営 監査ログ V8
  CyW0E: '/ops/dashboard', // 運営 ダッシュボード V8
  tVaUh: '/ops/invite', // 運営 メンバーの招待 V8
  D9JALJ: '/ops/login', // 運営 ログイン V8
  FvbHW: '/ops/members', // 運営 メンバー管理 V8
  P0jhqO: '/ops/support', // 運営 お問い合わせ V8
  XWtYC: '/ops/tenants', // 運営 契約先アカウント V8
  Oub6x: '/ops/tenants/detail', // 運営 契約先の詳細 V8
  qod6X: '/ops/two-factor', // 運営 2要素認証を設定 V8
  Al4Ek: '/scenarios/detail', // シナリオ配信 複製のダイアログ V8
  Z0g3si: '/templates/detail', // テンプレート 削除（使っている所がある） V8
  NGh7b: '/webhooks/new', // 外部連携 送り先を作る（競合）V8
  hsD8e: '/webhooks/new', // 外部連携 送り先を作る V8
  LPOe7: '/webinars/new', // ウェビナー ②動画（日時指定・開催回）V8
  XCUNf: '/webinars/new', // ウェビナー ⑤確認 V8
  j7PP04: '/webinars/new', // ウェビナー ①基本設定（作る）V8
  // 撮影の対応表に場所が無かった板 → 板と画面の表の場所（監査 ROOT-19 の残り・2026-10-08）
  d8X09: '/', // 1. ダッシュボード
  mcOqK: '/', // ★P5 ダッシュボード /（編集・隠れているカード）2026-10-01
  CFAyf: '/accounts/detail?id=visual-qa-account', // LINEアカウント 送受信を止める V8
  n9Z2P: '/accounts/detail?id=visual-qa-account', // LINEアカウント 登録の内容を編集する V8
  Msb1j: '/accounts/detail?id=visual-qa-account&tab=credentials', // LINEアカウント 資格情報を差し替える V8
  WOfBN: '/accounts/detail?id=visual-qa-account-old', // LINEアカウント アーカイブ V8
  AjZhH: '/booking/bookings', // 予約台帳 予約の詳細 V8
  KRgTQ: '/booking/menus?tab=holidays', // 予約設定 休業日 V8
  VFxWU: '/booking/menus?tab=hours', // 予約設定 受付枠（1152）V8
  ZyDd6: '/booking/menus?tab=channels', // 予約設定 予約経路の連携（人）V8
  x1OZS6: '/booking/menus?tab=rules', // 予約設定 予約のルール V8
  yRPxl: '/booking/menus?tab=hours', // 予約設定 受付枠 V8
  CcA4k: '/booking/staff/new', // 予約設定 予約スタッフを登録 V8
  E3YDK: '/booking/staff/shifts', // 自分の勤務（スタッフ本人）V8
  d5fmnM: '/booking/staff/shifts', // 予約設定 勤務とシフト（管理者）V8
  wvGke: '/booking/staff/shifts', // 自分の勤務（ひも付けなし）V8
  EML2F: '/broadcasts', // 欄 一覧
  bIdqV: '/broadcasts', // 欄 一覧の状態
  rfdmA: '/broadcasts', // 欄 一覧（1152）
  dK1aE: '/broadcasts/detail', // 欄 詳細（下書き）
  tPm3e: '/broadcasts/detail', // 欄 詳細（送った後）
  wfHIE: '/broadcasts/detail', // 欄 詳細（承認待ち）
  CRtK8: '/broadcasts/reserved', // 欄 予約した後
  qUdNh: '/events/change-review?id=ev-1', // イベント予約 変更内容を確認 V8
  WOPjZ: '/form-submissions/edit', // 回答フォーム 5段階・住所のブロック（機能追加 F-11・API待ち）
  al47K: '/friend-add-settings', // 友だち追加時の配信 作る③ 初回案内 V8
  h5rm8t: '/friend-add-settings', // 友だち追加時の配信 編集（競合）V8
  h8uNW: '/friend-add-settings', // 友だち追加時の配信 作る② 流入リンク V8
  i1nThZ: '/friend-add-settings', // 友だち追加時の配信 作る④ あわせて行うこと V8（機能追加 F-9・API待ち）
  sFwWf: '/friend-add-settings', // 友だち追加時の配信 テストで自分に送る（機能追加 F-12・API待ち）
  wDzkc: '/friend-add-settings', // 友だち追加時の配信 作る① 基本設定 V8
  xHpkS: '/friend-add-settings', // 友だち追加時 作る②（1152）V8
  ADjK8: '/friends', // 友だち 統合ユーザー V8
  T9gblG: '/friends/migrations', // 友だち CSVで書き出す・取り込む V8
  M4jS9: '/hq/members', // 統括 メンバー 権限を変える（確認）V8
  ZxKL5: '/inflow-links', // 流入と計測 広告費を手で入れる V8
  E14GFm: '/inflow-links/new', // 流入と計測 作る（競合の比べ）V8
  sDXNy: '/line-notifications/operator/new', // LINE通知 運用者へのお知らせ 公開前の確認 V8
  dEv6G: '/nen/members', // 会員 ランクを消す（確認）V8
  TJUUl: '/ops/announcements', // 運営 お知らせ 送る前の確認 V8
  VUyYu: '/ops/members', // 運営 メンバーを停止 V8
  Izau1: '/ops/support', // 運営 お問い合わせを代わりに起票 V8
  i0FTN: '/ops/tenants', // 運営 契約先を作る V8
  okXoi: '/ops/tenants/detail?id=visual-tenant-1', // 運営 契約先を停止 V8
  SrmVs: '/restaurant-test/google?tab=performance', // Googleビジネス パフォーマンス V8
  Cfed0: '/restaurant-test/google?tab=posts', // Googleビジネス 投稿 V8
  T1j2Sw: '/restaurant-test/google?tab=posts&view=new', // Googleビジネス 投稿を作る V8
  JUTGz: '/restaurant-test/google?tab=profile', // Googleビジネス プロフィール V8
  x9HIR: '/restaurant-test/google?tab=reviews&view=draft', // Googleビジネス 返信を作る V8
  CuHXG: '/restaurant-test/google?tab=settings', // Googleビジネス 設定 V8
  hQQlt: '/restaurant-test/inventory', // 予約枠・在庫 予約経路の連携 V8
  MV5Os: '/restaurant-test/menu', // メニュー管理 停止の確認 V8
  NkmwU: '/restaurant-test/menu', // メニュー管理 メニューを追加・変更 V8
  eY9F3: '/restaurant-test/tables', // 座席・卓 卓を止める（確認）V8
  gBrCz: '/restaurant-test/tables', // 座席・卓 卓を追加・変更 V8
  OPGU2: '/scenarios/detail?id=scenario-0', // シナリオ配信 止める確認（小窓） V8
  bMpC5: '/staff', // 組織・権限 ユーザーの停止 V8
  H031gC: '/webhooks?tab=incoming', // 外部連携 受け取る設定を追加 V8
  YZ57z: '/webhooks?tab=sheets', // 外部連携 Google Sheets の接続を解除 V8
  // 撮影の対応表が別の画面を書いていた板 → その板の画面（監査 ROOT-19 の残り・2026-10-08）
  Td4TN: '/affiliate-offers/new', // 成果とアフィリエイト 案件を作る V8（機能追加 F-23・API待ち）
  XJUqs: '/auto-replies/edit', // 自動応答 作る⑤ 確認 V8
  LnGNw: '/common-actions', // オートメーション 共通アクション V8
  j2hfkS: '/common-actions/new', // オートメーション 共通アクションを作る V8
  ziSgL: '/common-actions/versions', // オートメーション 共通アクション 版と使われている場所 V8
  h1G4d: '/search-console', // 分析 Search Console V8
  // 開く指定が要る板（監査 ROOT-19 の残り・2026-10-08）
  tnTn9: '/affiliates?affiliate=af-1', // 成果とアフィリエイト アフィリエイターの詳細（引き出し）V8
  // 撮影の対応表のほうが細かい（タブ指定つき）板（監査 ROOT-19 の残り・2026-10-08）
  AzrZq: '/analytics?view=conversion-report', // 分析 成果地点ごとのレポート V8
  IWnYX: '/tags?tab=searches', // 友だち属性 保存した検索 V8
  q5gbcM: '/tags?tab=fields', // 友だち属性 友だち情報欄 V8
  vKDj5: '/tags?tab=marks', // 友だち属性 対応マーク V8
}
