> 文書：予約設定（V8）の動き｜区分：今の説明｜最終確認：2026-10-26（日本時間）

# 予約設定（V8）の動き

入口（管理画面はV8に固定）：
- `app/booking/menus/page.tsx` → `src/v8/booking-menus/settings.tsx`（メニュー・受付枠・休業日・ルール・担当・お支払い・券・予約経路・写真。必要なタブには右にお客さまの予約画面の写し）
- `app/booking/menus/new/page.tsx` → `src/v8/booking-menus/menu-form.tsx`（作る・直す・競合）
- `app/booking/menus/staff/page.tsx` → `src/v8/booking-menus/assign.tsx`（担当メニューをまとめて決める）

写し元：[現役の入口・本体](README.md)・`settings-tabs/*`・`channels-tab-v8.tsx`・`liff-phone-v8.tsx`・`menu-version-history.tsx`・`new/menu-form-v8.tsx`・`staff/assign-v8.tsx`・`app/booking/staff/staff-edit-dialog.tsx` と、それらが読む `lib/*`（`src/v8` からは `@/app` を読めないので写した）。

絵：メニュー `owaS3`・1152 `P6EdLW`・閲覧のみ `C9fv7A`・受付枠 `yRPxl`・1152 `VFxWU`・休業日 `KRgTQ`・予約のルール `x1OZS6`・予約経路 `ZyDd6`・状態 `xCoDe`・作る `QqER7`・競合 `v5L19Z`・担当まとめ `ooufy`。

## 受け付ける URL と指定（今と同じ）
- `/booking/menus?tab=menus|hours|holidays|rules|staff|channels|payments|passes|photos`（無い・知らない値はメニュー）
- `/booking/menus/new`（作る）・`/booking/menus/new?menu=<id>`（直す）
- `/booking/menus/staff`（`?menu_id=<id>` でその行に色を付ける）

## 呼ぶ口・保存先（今と同じ）
- メニュー：`bookingApi.listMenus`・`updateMenu`（並び替えは2件の sort_order を入れ替え）・`patchMenu`（公開／止める）・版の履歴
- 店の設定：`bookingApi.getSettings`・`saveSettings`（版つき、409 は読み直し）
- 設備：`listResources`・`createResource`・`updateResource`・`deleteResource`、空きの確かめ：`checkAvailability`
- 休業日：`createException`・`updateException`・`deleteException`、休みの日の予約数は `listRequests`
- 担当：`listStaff`・`createStaff`・`updateStaff`・`deleteStaff`・`getStaffMenus`・`putStaffMenus`・`listStaffMenusBulk`・`putStaffMenusBulk`（「指名なし」は全員の `is_designation_optional`）
- 作る・直す：`createMenu`・`updateMenu`・`saveMenuResources`・`listMenuVersions`・`revertMenuVersion`
- 予約経路：`/api/booking/admin/channels`・`conflicts`・`channels/settings`（自動割り当て）・`staff/:id/google-calendar`
- 右の写し：`getAvailability(menuId, from, to, applyStoreRules)`。お客さまの予約画面の写しなので、店舗のルール（休業日・受付の範囲）を当てた空きを読む（`apply_store_rules=1`。勤務とシフトのお客さま向けの見本も同じ口）

## 権限
- 変えられるかはサーバーの役割（`/api/staff/me`）で決める：オーナー・管理者は変えられる、担当者は項目キー（`/booking/menus`・`booking.settings`）を持つときだけ。答えが来るまでは今までどおり手元の判定（`canEditFeature`）。
- 閲覧のみの人：頭の下に「閲覧のみで見ています。変える操作は管理者に頼んでください。」の帯。作る・つまみ・下の保存帯は置かない（作るボタン・つまみは場所だけ空ける）。「…」は版の履歴が見られるので残す。

## お客さまの予約のしかた・指名料（要件 B4・B5・B9、2026-10-26）

- 作る・直すに段「お客さまの予約のしかた」（`customer-booking.tsx`）。お客さまの繰り返し予約（オン・オフ、毎週／隔週／毎月第 n 曜日、最大 2〜12 回、初めはオフ）・一度に予約できる人数（1〜6、初めは 1）・追加メニュー（固定の料金のほかのメニューから選ぶ）・追加専用のメニュー（単独では予約できない）。
- 保存はメニューの保存と同じ口（`createMenu`・`updateMenu`）に `recurring`・`maxPartySize`・`addonMenuIds`・`addonOnly` を足す。前と変えた物だけ送る。
- 口はオーナー・管理者だけが通れる。ほかの人（予約メニューを任されたスタッフ）には今の設定を読むだけで出し、保存にも載せない（載せるとメニューごと 403 になる）。
- 一覧の口（`listMenus`）は繰り返しの設定を返さない。返らないときは「この画面ではまだ読み出せません」と出し、［繰り返しの設定を入れ直す］を押すまで上書きしない。返るようになれば、そのまま欄に出す。
- 担当の編集の窓（`staff-edit-dialog.tsx`）と登録（`booking-staff/staff-new.tsx`）に「指名料」（0 以上の円）。オーナー・管理者が変えたときだけ `nominationFee` を送る。ほかの人には額を読むだけで出す。担当の見本は「指名料 +¥500」（0 円なら「指名料なし」）。

## 写真（BA-19・P02、2026-10-19）

- `?tab=photos` → `photos.tsx`。型は既存の `CreatePage`、カード列は `ListPageCards`、面は `Card`、画像は `MediaThumbnail`、選択は共通 `MediaPickerDialog`。★V8 `NQtrW` のお店・メニュー・スタッフの3段を使う。
- 同じLINEアカウントの登録画像から選ぶ。新たにアップロードする場所は作らない。共有・別アカウント・退避済み・画像以外は選べない。
- メニュー・スタッフ各1枚、お店は外観・店内・待合各1枚。お店の前後の操作は写真の分類を変えず、LIFFに出す順だけを変える。解除は写真の削除ではなく参照を外す操作で、保存すると反映される。
- お店の写真は枠ごとに公開を選んで保存する。選択が未設定の写真は非公開。公開APIとLIFFは選んだ写真だけを保存順で返し、0枚ならお店の案内ごと出さない。LIFFは小さな写真を横に並べ、押すと拡大し、閉じる・Escapeで元の写真へ焦点を戻す。
- `bookingPhotosApi.list/saveMenu/saveStaff/saveStore` を呼ぶ。選択・解除後に明示保存する。メニューはメニューの編集権限、スタッフと店は予約設定の編集権限を使い、閲覧のみには選ぶ・外す・順変更・保存を出さない。
- 保存中は連打を止める。失敗・409でも選択を残す。409後は保存を止め、最新の写真と版を読み直してから明示保存する。タブ移動・離脱は既存の書きかけ確認へ渡す。アカウント切替後の古い読込・保存の応答は捨てる。
- 写真の保存と使用先の記録は735の同じSQL処理で更新する。使用中の写真はメディアの削除確認で止め、予約設定の写真タブへ案内する。走査の予約3種類はR2キーの部分一致ではなくメディアIDの完全一致。
- LIFFのメニュー選び・担当選びに登録写真を出す。メニュー選びの「お店の案内」は公開を選んだ登録写真だけを保存順で表示する。スタッフの写真を外した場合は従来のプロフィール画像を保つ。写真の取得失敗は予約入力を消さず再読込できる。

## 今の V8 と違うところ
- 頭：タブの下に余白（絵どおり）。閲覧のみの帯は各タブの中ではなく、頭の下に1本。
- メニュー表：名前の下に分類の札、その下に説明（1行 84px）。作るボタンは＋の印。
- メニュー表：担当が 0 人の担当の列は薄い灰の「—」。公開中で担当が 0 人なら状態の列は黄の札「担当がいないため停止中」で、押すと担当スタッフのタブへ（止めているメニューは灰の「停止中」のまま）。
- 予約のルール：3つの決まりは数の入力ではなく選ぶ欄（`60 日先まで`・`3 時間前まで` など。保存済みの値が候補に無ければ候補に足す）。お知らせの時刻・当日・予約枠の間隔・仮押さえ・タイムゾーン・日時の最初の形は「ほかの設定」を開いて変える。前日の行は「前日の 18:00 に送ります／24時間前に送ります」と書く。
- 休業日：前後の月の日は空ける。数字は升の左上。「臨時休業を足す」は文字ボタン。休みの日の予約の注意は帯ではなく字だけ。
- 下の帯：受付枠・予約のルール・担当まとめ・作るは、キャンセルと保存を中央に置いた帯をいつも出す（変更が無いときに保存を押すと「変更はありません。」）。
- 右の写し：日付は5日（LIFF の週の並びと同じ）で、空きのある先頭の日から。担当は「指名なし」（全員の空きを合わせる）。メニューのカードは説明が無くても1行空ける。
- 予約経路のタブは右の写しを出さず全幅。
- 中身が短いタブでも、下の帯は板の下に置く（板の高さを画面いっぱいにする。絵 x1OZS6）。
- 作る：白い段に「受け方」「予約を受けたときにすること」「使う設備」を白い小段で積み、その下にお支払い。付けるタグは打って絞れる1つ選び（「付けるタグ：〇〇」）。担当の札は3つ横に並べ、トリマーは名前だけ。
- 作る：タグの候補を、`lineAccountId` が無いタグもこのアカウントのものとして出す（一覧の口は `lineAccountId` を返さないので、前は全部はじかれて「使えるタグがありません」になっていた）。
- 担当まとめ：メニューは `sort_order` の順。読み込んだら上書きのある最初の升を選んでおく。「指名なし」「止めている」の印は名前の横（title にも）。

- 閲覧のみの人にも作成の入口を表示し、操作できない理由を示す。
