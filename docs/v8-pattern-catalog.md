> 文書：V8 型の対応表（パターン台帳）｜区分：今の正本｜最終確認：2026-10-19（日本時間）

# V8 型の対応表（パターン台帳）

## people-day-grid 人の当日予約盤（L28）

- 役目：時刻を縦、担当を横に並べる。正の部品は `shared/reservation-board.tsx` の `timeDirection="vertical"` と `reservation-people-grid.tsx`。標準の横時間軸は変更しない。
- 空き枠はAPIから渡った `slots` のみ。予約の詳細・版付き移動・移動失敗後の復旧は共通盤の契約を保つ。閲覧者へ作成入口・ドラッグを出さない。
- 当日の型は `templates/booking-page.tsx` の明示的な `stats` / `aside`。白い板が1100未満なら右欄を畳み「次の予約・内訳」で開く。数・次の予約・売上は実データから読み、未取得は0にしない。
- 右欄の区画は同じ型の `BookingSidebarSection` へ題と内容を渡す。区切り・余白・題の段を画面側に定義しない。
- 格子の外枠は共通 `GridTable` の `presentation="calendar"`。カードの本文ではなく、時刻・担当の行/列/セルを持つ表として描く。通常の一覧の密度・カードの余白の定義は変えない。
- 見張り：`reservation-people-grid.test.tsx`・`day-frame.test.tsx` と実ブラウザの3幅。使う板はGcyTr/O2Z8u。細かな最終調整はClaudeへ渡す。

- 作成：2026-10-09（オーナー「見落としていて決まりから外れているところが、次回から外れないように、同じものとして認識されるようにしておいて」・B-143・B-168・B-172）
- 何の文書か：**同じ役目の物を、画面が違っても同じ物として見つける**ための表。型ごとに「役目・持ち主（正の部品）・見つけ方・決まり・見張り」を1節で書く。
- 誰が読むか：画面を作る・直す人（Codex・Claude・Pen の作業役）と、点検の道具。機械が読む表は `scripts/visual-qa/v8-pattern-catalog.json`（この文書と同じ中身。正規表現は JSON が正）。
- 点検の道具：`node scripts/visual-qa/v8-pattern-audit.mjs --code ~/lh-work/lh-train-12 --pen ~/lh-work/design/v8/html --out ~/lh-work/design/v8/review/pattern-audit-run`（`--only card,kpi-band` で型を絞る）。
- 決まりの正本は `docs/v8-design-rules.md`。この文書は決まりを増やさない。決まりの節と B-番号へつなぐだけ。

## 2026-10-10 B-172 のコード側の更新

- 閲覧のみの帯は `ReadOnlyNotice` が持つ。`ListPageBody`・`CreatePage`・`DetailPage` に `readOnly` を渡しても出せる。権限の条件と、統括などの頼む先は画面が持つ。
- アカウント未選択・未登録の案内は `AccountRequiredState`、一覧の空・取得失敗は `ListState`。既存の再試行・作成・戻る操作を渡せる。明示的な `action={null}` は、権限不足などで再試行を出さない意味。
- 件数の正本は shared の `PAGE_SIZES`（10・20・50）。旧 ui の入口は互換用の再公開。取得用のバッチ上限やCSVの上限は一覧の表示件数ではない。
- フォルダの作る操作を隠したときの空きは `FolderPanel`、削除後の案内は `FolderPanelNote` が持つ。既存の管理する列は `ManagedFolderPanel` がAPIと行の操作を持つ。選ぶ窓のフォルダ列は作る操作が元からないため、`reserveCreateSpace={false}` を指定する。
- 既に本線で共通化された数の帯・状態の札・削除確認は既存の持ち主を使う。行の「…」は `RowMenu` / `MoreAction`、ページ内の戻るはパンくずとキャンセルへ寄せる。

### 増殖を止めるCI

`node scripts/visual-qa/v8-pattern-audit.mjs --code . --base <PRのbase SHA> --out <出力先>` を required-pr-gate の repository-checks で実行する。同じ対応表で土台と変更後を点検し、持ち主以外に新しい (a)(b)(c) 候補があれば非0終了する。既存候補の行移動は許可し、同じ候補の増殖は止める。

文言だけの目印（words・account-words・retry-words・folder-words・prev-next・back-in-bar）は調査一覧に残し、CIの形の違反とは分ける。説明、完了画面、日付送りにも同じ語が出るため。帯のクラスで余白・位置だけを持つものと、すぐ内側が `ReadOnlyNotice` の包みだけは自作と数えない。同じファイルのほかの自作は検出する。`STANDARD_PAGE_SIZES` / `PAGE_SIZE_SELECT_OPTIONS` を読む定数は共通の正本への参照として扱う。

実際に使われる経路の76ファイルの帯、15ファイル26か所の状態カード、一覧の件数定数、欄に結び付かない失敗の知らせを共通部品へ寄せた。同じ表での候補数は (a) 7032→6767、(b) 1435→1416、(c) 2497→2493。正規表現の全体一覧には未使用コードと要確認候補が残る。新しい候補0は、残りの候補が全部違反なしという意味ではない。Penの部品IDと見た目の合格は司令塔が記録する。

## 列車31b：既存の型の小さい口（2026-10-13）

- 作成の2列：`templates/create-page.tsx` の `CreateColumns`。見え方は入力の高さに収め、長い見本はその欄で送る。380幅と1100未満の畳み方は型が持つ。保存・プレビューの内容は画面が渡す。
- 手順ごとの補足列：`templates/create-step-columns.tsx` の `CreateStepColumns`。白い板1100未満では右欄を同じ内容の確認窓へ畳む。入力値・補足の役目名は画面から渡す。
- 作成の完了見出し：`templates/create-parts.tsx` の `CreateCompletionHeading`。丸い成功印・中央の題・結果本文を表示する。状態の札と区別し、数と次の操作は画面から渡す。
- 内容で終わる板の本文：`templates/page-frame.tsx` の `PageContent`。左右24・上16、下24は外枠が1回だけ持つ。本文の外に置く数の帯は `PageContent layout="stats"`（左右24、上下の追加なし）へ。既に本文の内側にある帯を二重に包まない。
- 履歴の表：既存の `shared/table.tsx` の `DataTable.grid`。列・端の余白と本文／見出しの文字の大きさを共通の口へ渡す。画面で表の子を上書きしない。

## 使い方（必ず守る）

- 外側の看板は `layout/sidebar-identity.tsx` の `SidebarBrand`（店は `SidebarIdentity` が取得した値を渡す）。運営も同じ横並びを使う。
- 左下の本人操作は `shared/sidebar-user-menu.tsx`。既存の本人カードと `ActionMenu` を使い、運営の本人情報・メンバー管理・2要素認証・ログアウトを渡す。店・統括の権限取得は既存 `hq/account-menu.tsx` が持つ。
- 運営の注意帯は `Notice` の `presentation="ops"`。琥珀色・右の環境札なし。環境と版は左下の `SidebarVersion` で確認する。

1. **画面を作る・直す前に**、その画面に出る型をこの表で探し、**持ち主（正の部品）だけを使う**。画面の中で同じ役目の物を書かない（§2・§6.20）。
2. **画面の CSS で部品の見た目を上書きしない**。部品に見た目の `className`・`style` を渡さない（幅・余白・並びは呼び出し側が渡してよい＝§5）。色・大きさ・角丸・影を直書きしない（変数を読む）。
3. **Pen の板は部品の写しだけ**を使う。切り離し・見た目の上書きをしない（文字・件数・データの違いだけ上書きしてよい）。
4. **直すときは持ち主だけを直す**。画面ごとに直したくなったら型が足りない合図。**この表に型（または部品の変わり形）を足してから**直す（B-172）。
5. **新しい役目の物を作るとき**は、先にこの表と JSON に型を足す（id・役目・持ち主・見つけ方・決まり・見張り）。足したら道具を回して候補の数を記録する。

## 点検の4つの数（B-172）

| 記号 | 何を数えるか | どこで |
|---|---|---|
| (a) 手書き | 持ち主以外で同じ形を作っている所（下の「見つけ方（コード）」の目印に当たった所。共通部品・型の中は除く） | file:line |
| (b) 上書き | 持ち主の部品に見た目の `className`・`style` を渡している所（渡したクラスの規則に色・枠・角丸・影・文字があるもの）／画面の `.module.css` が部品の中を `:global(.x)`・子孫の要素・`[data-variant]` などで塗り直している所 | file:line |
| (c) 直書き | 画面の CSS に、色・大きさ（文字・高さ・幅）・角丸・影を変数なしで書いた所。型は selector の手がかりで割り当て、当たらない分は「（型なし）」 | file:line |
| (d) Pen | 手描きの目印（下の「見つけ方（Pen）」）と、持ち主の部品の写しの見た目の上書き（`background-color・outline・box-shadow・border-radius` が写しで一番多い値と違う）・切り離し（ほかの写しに無い中身） | 板 ID |
| 効く範囲 | 持ち主を直すと変わる所：持ち主の部品を読む画面側のファイル数・機能の数、Pen は写しを置いた板の数 | — |

- 数はどれも**候補**。理由のある例外も混ざるので、直す前に目で確かめる。数を減らすために目印を外さない（外すときは理由をこの文書に書く）。
- Pen の部品の板の html（`~/lh-work/design/v8/html/components-*.html`）は 10-04 の書き出しで古い。そのため (d) の写しは「部品の板の値」ではなく「同じ名前の写しで一番多い値」と比べる。部品の板を書き出し直したら、部品の値と比べる形に戻せる。
- 道具そのものの試験：`scripts/visual-qa/v8-pattern-audit.test.ts`（偽の一致・見落としを作りものの repo と板で確かめる。持ち主のファイル・見張りの試験のファイルが実在するかも見る）。

## 型の一覧（2026-10-09 の点検の数）

10-09の数は当時の記録。10-11に確認した持ち主と追加の決まりは各節の追記を読む。機械の表と点検スクリプトは列車16〜18の本線の新版を保ち、今回の文書追記で検出範囲まで更新済みとは扱わない。

数は `~/lh-work/lh-train-12`（本線＋列車11・12）と Pen の板 632 枚。(a) の括弧は v8 の置き場だけの数。

| 型 | 持ち主 | (a) | (b) | (c) | (d) 手描き／写し | 効く範囲（ファイル／機能／Pen 板） |
|---|---|---|---|---|---|---|
| [card](#card) カード（中身のまとまりの箱） | 未定：Pen | 45（37） | 22 | 204 | 186／0 | 63／37／0 |
| [kpi-band](#kpi-band) 数の帯 | 決まっている | 163（113） | 55 | 270 | 0／0 | 149／64／15 |
| [page-head](#page-head) 一覧・画面の頭 | 決まっている | 158（109） | 4 | 216 | 26／149 | 169／74／505 |
| [toolbar](#toolbar) 一覧の道具の段 | 決まっている | 227（170） | 1 | 9 | 157／3 | 36／29／191 |
| [filter](#filter) 絞り込み | 決まっている | 190（90） | 28 | 29 | 37／5 | 116／55／40 |
| [folder-column](#folder-column) フォルダの列 | 決まっている | 83（60） | 1 | 32 | 19／0 | 16／13／0 |
| [table](#table) 表 | 決まっている | 546（458） | 581 | 204 | 4／20 | 223／81／86 |
| [row-menu](#row-menu) 行の右端「…」 | 決まっている | 109（53） | 31 | 9 | 0／0 | 132／68／0 |
| [pagination](#pagination) ページ送り | 決まっている | 222（126） | 0 | 12 | 8／0 | 155／71／56 |
| [detail-panel](#detail-panel) 詳細のパネル・引き出し | 未定：Pen | 140（73） | 3 | 14 | 13／0 | 41／29／0 |
| [dialog](#dialog) 窓（確かめ・編集） | 決まっている | 109（32） | 18 | 41 | 6／0 | 354／109／0 |
| [picker-dialog](#picker-dialog) 選ぶ窓 | 決まっている | 2（1） | 1 | 1 | 3／0 | 2／1／0 |
| [picker-field](#picker-field) 選ぶ欄（選ぶ前・選んだ後） | 未定：Pen | 137（71） | 0 | 2 | 64／0 | 7／4／0 |
| [select](#select) プルダウン（許される範囲） | 決まっている | 154（88） | 33 | 18 | 12／3 | 376／111／97 |
| [tap-action](#tap-action) 押したら（TapActionField） | 決まっている | 44（29） | 0 | 1 | 0／0 | 6／6／0 |
| [tap-extra](#tap-extra) 押されたときにあわせて行うこと | 決まっている | 48（27） | 0 | 0 | 0／0 | 6／6／0 |
| [action-list](#action-list) 行うことを足す | 未定：コード・Pen | 34（16） | 0 | 8 | 24／0 | 0／0／0 |
| [media-slot](#media-slot) 画像の枠（MediaSlot） | 未定：Pen | 81（41） | 1 | 11 | 0／0 | 26／16／0 |
| [field](#field) 欄（Field・必須・任意・文字数） | 決まっている | 804（332） | 52 | 196 | 1／4 | 269／91／104 |
| [field-error](#field-error) 欄の赤表示 | 決まっている | 704（477） | 14 | 31 | 0／0 | 43／27／0 |
| [sticky-bar](#sticky-bar) 作る・編集の下の帯 | 未定：Pen | 260（162） | 5 | 15 | 30／0 | 126／72／0 |
| [tabs](#tabs) タブ | 決まっている | 86（52） | 19 | 13 | 130／13 | 80／51／132 |
| [status-badge](#status-badge) 状態の札 | 決まっている | 436（268） | 81 | 54 | 306／10 | 125／56／178 |
| [list-state](#list-state) 空・読めない・読み込み中 | 決まっている | 816（475） | 13 | 17 | 31／0 | 430／115／1 |
| [viewer-band](#viewer-band) 閲覧のみの帯 | 未定：Pen | 248（239） | 0 | 10 | 8／0 | 0／0／0 |
| [notice](#notice) 知らせ（トースト・Notice） | 決まっている | 195（62） | 0 | 20 | 23／0 | 394／112／23 |
| [save-conflict](#save-conflict) ぶつかりの帯 | 未定：Pen | 223（131） | 2 | 8 | 0／0 | 12／11／0 |
| [customer-info](#customer-info) 顧客情報の欄 | 決まっている | 20（9） | 0 | 0 | 20／0 | 0／0／0 |
| [phone-preview](#phone-preview) スマホのプレビュー | 決まっている | 76（37） | 3 | 88 | 29／0 | 58／31／2 |
| [period](#period) 期間の選択 | 未定：コード・Pen | 166（95） | 0 | 3 | 73／0 | 0／0／0 |
| [chart](#chart) グラフ | 未定：Pen | 16（7） | 0 | 22 | 108／0 | 2／1／0 |
| [external-link](#external-link) 外へのリンク | 決まっている | 85（47） | 0 | 48 | 57／0 | 4／1／13 |
| [csv](#csv) CSV | 未定：コード・Pen | 158（93） | 0 | 0 | 80／0 | 0／0／0 |
| [primary-button](#primary-button) 主ボタン・ボタン | 決まっている | 96（49） | 279 | 81 | 464／18 | 698／151／277 |
| [date-time](#date-time) 日付・時刻の欄 | 未定：Pen | 86（43） | 7 | 12 | 0／0 | 102／48／0 |
| [toggle](#toggle) オン・オフ・選ぶ部品 | 決まっている | 247（162） | 26 | 18 | 0／0 | 265／98／87 |
| [copy](#copy) コピー | 未定：Pen | 47（25） | 0 | 0 | 0／0 | 2／1／0 |
| [steps](#steps) 手順 | 決まっている | 34（23） | 9 | 77 | 85／2 | 20／19／19 |
| [bulk-bar](#bulk-bar) まとめて選ぶ（一括バー） | 決まっている | 11（7） | 0 | 6 | 3／0 | 12／9／0 |
| [back-link](#back-link) ページ内の戻る（置かない） | 未定：Pen | 53（43） | 0 | 6 | 0／0 | 11／6／0 |
| [folder-select](#folder-select) 所属フォルダを選ぶ欄 | 決まっている | 61（45） | 0 | 0 | 0／0 | 25／18／0 |

---

<a id="card"></a>
## card カード（中身のまとまりの箱）

- 選んだカードの枠と面は `Card.selected` へ渡す。既定のカードは変更しない。
- 下部に操作を置くカードは `Card.actions` を使い、情報の段間と操作までの間隔は `gap` で1回だけ指定する。自然な高さの差が48px以下なら既存の高さ合わせで操作も下端へ寄せる。記事として並べる場合は `as="article"`。
- 親が左右の余白を持つカード一覧は `ListPageCards inset="parent"`、狭い板の列数は `narrowColumns` で指定する。先頭の数の帯を道具領域に置く一覧は `ListPage toolbarSpacing="stats"` とし、見出し下と道具上の余白を重ねない。タブ・独立した数の帯が間にある一覧の間隔は保つ。

- 一覧のカード配置は一覧型の `ListPageCards`（`list-page.tsx` と `page-templates.module.css`）が列数と共通16の間隔を持つ。カードの面と内側は `Card`・`CardContent`・`CardHeader`（card.tsx）、操作は `RowNameButton`・`IconButton` が持つ（L7メディア・バナー）。CardContentは端の16を1回だけ持つ。
- 分析のカード本文は `ListPageSection` が共通16/24の余白、`DetailColumns(presentation="analysis")` が左右の列と狭幅の折り畳みを持つ。カードの面/題はCard/CardHeader。ほかの提示と既定は保つ（L11 ws9wt）。

- **役目**：中身のまとまりを白地＋線なし＋影＋角丸12で1枚に見せる
- **持ち主（コード）**：`apps/web/src/components/shared/card.tsx`・`apps/web/src/components/shared/card.module.css`（部品 `Card`・`CardHeader`）
  - 読む変数：`--card-shadow`・`--card-edge`・`--radius-card`
- **持ち主（Pen）**：**未定**
  - 注：Pen にカードの部品が無い（B-168「Pen もカードは部品のカードだけ」の部品を作る）
- **見つけ方（コード）**：
  - ring-card：CSS の規則に `border-radius:\s*(12px|var\(--radius-card\))` と `box-shadow:\s*var\(--tpl-[\w-]*ring\)|border:\s*1px solid var\(--color-(hairline|divider|border[\w-]*)\)|outline:\s*1px` があり、`--card-shadow` が無い — カードの角丸で線だけ（影なし）の箱（B-168）
  - own-shadow-card：CSS の規則に `border-radius:\s*(12px|var\(--radius-card\))` と `box-shadow:\s*(0|[^;v]*rgba|var\(--shadow-card)` があり、`--card-shadow` が無い — カードの角丸で別の影の箱
  - (c) の割り当て：直書きの selector が `card|panel|box|tile|section\b|sheet|block` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - outline-card：名前が `^(知らせ|選ぶカード|選ぶ欄|ポップ|吹き出し|ダイアログ|窓)` でない・style に `border-radius: 12px` と `background-color: #ffffff` と `outline: 1px`・style に `0px 1px 1px #1d1d1f29`・`0px 8px 24px` が無い — 白地・角丸12・線だけで影なし（カードの部品を使わない手描き）
- **決まり**：[§6.2](v8-design-rules.md)・[§6.18](v8-design-rules.md)・B-137・B-148・B-168
- **見張り**：なし／**要る試験**：画面の .module.css に「角丸がカードの値・枠だけ・--card-shadow なし」の規則を新しく書いたら落ちる試験（例外は一覧に理由つき。B-168）
- **10-09 の数**：(a) 45（v8 37）・(b) 22・(c) 204・(d) 手描き 186（73 板）／写し 0・効く範囲 63 ファイル／37 機能／Pen 0 板

- **10-11の追加**：[§6.31](v8-design-rules.md)・[§6.37](v8-design-rules.md)・B-208・B-222・B-224・B-233。箱の中は16以上（小さい箱12）、固定高さではみ出させず下の余白も守る。LIFFの白い中身カードも共通影。選ぶカード・入力欄・ボタンは影の対象外。

<a id="kpi-band"></a>
## kpi-band 数の帯

- 指標を順に追う帯は `KpiBand connections` へ前段との矢印と割合を渡す。数と単位は同じ `KpiCard` が描き、最長の数に合わせて全マスを同じ大きさで縮める。共通カードの内側余白は削らない。欠測・分母0の割合は出さず、画面側でカードの箱や間隔を作らない。

- 数字は共通値の34px・500・行40、上下16。どの帯も横一列（全部のマスの上端が同じ）。入りきらない数だけ共通KpiBandが字を小さくし、数字・単位は省略しない（2026-10-26 オーナー：数の帯は横一列にそろえる）。

- **役目**：数（KPI）を線で区切った1本の帯で並べる
- **補足**：Gの最新版に従い、既定は文節で折り返す。`detailLayout="single"` は1行＋省略で全文を `title` に残し、`qualifier` は括弧の前で改行する。行き先は次の行。幅・高さを画面のCSSで上書きせず、帯全体のマスの高さをそろえる。
- **持ち主（コード）**：`apps/web/src/components/shared/kpi-band.tsx`・`apps/web/src/components/shared/kpi-card.tsx`・`apps/web/src/components/shared/kpi-card.module.css`・`apps/web/src/components/shared/kpi-band-v8.css`・`apps/web/src/components/shared/list-kpis.tsx`（部品 `KpiBand`・`KpiCard`・`ListKpis`）
  - 読む変数：`--color-hairline`
- **持ち主（Pen）**：`Pp3nS`「数のマス」
- **見つけ方（コード）**：
  - own-stat：`\b(function|const)\s+(StatCard|Stat|MiniStat|Kpi|KpiMenu|StatTile|Metric|SummaryCard)\b` — 画面で数のマスを自作（KpiCard を使う）
  - cards：`presentation=["']cards["']` — 数の並びをカードにしている（B-153 は線の帯）
  - kpi-class：`styles\.(kpi|stat|stats|kpis|metric|metrics|summaryCards?)\b`（持ち主の部品を読んでいないファイルだけ） — 数の帯を CSS で手書き
  - (b) の割り当て：画面の CSS の上書きの selector が `kpi|stat` に当たればこの型
  - (c) の割り当て：直書きの selector が `kpi|stat|metric|summary(Cell|Item)|count(Cell|Box)` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - kpi-card：名前 `数のカード|^数 `・style に `box-shadow: 0px 1px 1px #1d1d1f29` — 数のカード（影の箱）で数を並べている
- **決まり**：[§6.7](v8-design-rules.md)・[§6.1](v8-design-rules.md)・B-149・B-153・B-145
- **見張り**：`apps/web/src/components/shared/kpi-band-contract.test.tsx`・`apps/web/src/components/shared/kpi-card-migration-contract.test.tsx`・`apps/web/src/components/shared/list-kpis-contract.test.ts`
- **10-09 の数**：(a) 163（v8 113）・(b) 55・(c) 270・(d) 手描き 0（0 板）／写し 0・効く範囲 149 ファイル／64 機能／Pen 15 板

- **10-11の追加**：[§6.29](v8-design-rules.md)・B-195・B-220。状態語は数字にせず状態札へ。帯の全マスに補足・行き先が無ければ高さ90、1つでもあれば全マスをそろえる。持ち主は同じ KpiBand＋KpiCard。既存の見張りに `kpi-card-description-react.test.tsx`、画面の余白の見張り `apps/web/scripts/v8-guard/pendec2-rules.test.mjs`（補足の空白の検出）をつなぐ。

<a id="page-head"></a>
## page-head 一覧・画面の頭

- ダッシュボードで案内の初回取得が本文を後から押し下げる場合は、`DashboardPage` の `initialContent` に店舗・スタイルの範囲と待機状態を渡す。案内は独立して利用でき、本文は共通の骨組みで待つ。同じ範囲で表示済みの本文は後の読み直しで作り直さない。

- 取得する名前の題は `lib/resource-title.ts` の `resolveResourceTitle` で未取得と取得済み空名を分け、外側の帯と型へ同じ値を渡す。`components/shell/page-resource-scope.tsx` の `PageResourceScope` は店舗・対象IDが変わったときだけ編集状態を作り直し、前の対象名を次へ持ち越さない。内部タブの指定では作り直さず、埋め込みの編集は親の状態管理に任せる。

- **役目**：板の題・「？」・右の主ボタンを1段で出す。画面全体の説明はB-245の「この画面の説明」で灰色の説明を開閉する。
- **B-245の持ち主**：`components/shared/page-explanation.tsx` の `PageExplanationProvider`・`PageExplanationToggle`・`PageExplanationBody`。型の題の横と既存の説明の位置へ置き、人・画面ごとの開閉を覚える。欄や数の用語説明は `HelpTip`、一時的な失敗・閲覧のみは `Notice` のまま。
- **作る型の説明**：`components/templates/create-page.tsx` と `components/shared/create-page.tsx` の `CreatePage` が `help` を題の型へ渡す。監査では直接渡した説明文字列を操作と分け、再公開の入口から実際の持ち主まで照合する。説明内の生のボタンや、同名の手書きの型は操作の検査を続ける。
- **狭い板の右欄**：`CreatePage` の `preview` と `TemplateEditFrame` の `side` は、窓か右欄かを受け取る描画の口も使える。幅で畳む入口と窓は型へ任せ、窓の中にもう一度見え方を開くボタンを置かない。設定の情報と実際の見え方は保持する。
- **右欄の役目の文字**：`CreatePage` の `previewLabel` / `previewTitle` は、`PreviewLauncher` の既存の `label` / `title` へ渡す。設定・試算・紹介リンクなどをLINEの見え方と呼ばず、画面は今の右欄の役目だけを渡す。手順で内容が変わる時はその段に合わせる。入口や窓を画面で作り足さない。
- 固定の旧URLは `lib/canonical-route.ts` で正規の入口へそろえる。クライアントの転送待ちは `components/shell/legacy-route.tsx` と `PagePending`、題・説明書は転送先の画面で解決する。メニューの権限キーと旧URLの所属は保持する。
- ブラウザの題は `components/shell/document-title.tsx` の持ち主だけが描く。画面・認証・スマホの名前は登録して渡し、前のURLの名前は次のURLへ流さない。`usePageTitle` を無効にする埋め込み編集は親の題を保つ。
- **持ち主（コード）**：`apps/web/src/components/templates/page-frame.tsx`・`apps/web/src/components/shared/page-header.tsx`・`apps/web/src/components/shared/help-tip.tsx`（部品 `PageHeading`・`PageTitle`・`PageFrame`・`ListPage`・`CreatePage`・`DetailPage`・`DashboardPage`・`SettingsPage`・`AnalyticsPage`・`InboxPage`）
  - 読む変数：`--text-title`
- **持ち主（Pen）**：`EnlYo`「板の頭」・`KjC1z`「？」
- **見つけ方（コード）**：
  - raw-h1：`<h1\b`（持ち主の部品を読んでいないファイルだけ） — 題を h1 で手書き（型の PageHeading を使う）
  - header-desc：`<PageHeader\b(?:[^<>]|=>){0,400}?\bdescription=` — 頭の下の説明（B-158 の 2：説明は「？」へ）
  - lead：`className=\{styles\.(lead|subtitle|pageDescription|headDescription|intro)\}` — 題の下の説明の行
  - (b) の割り当て：画面の CSS の上書きの selector が `heading|pageHead` に当たればこの型
  - (c) の割り当て：直書きの selector が `pageHead|heading|header\b|title\b|lead|subtitle|description` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - desc-line：名前 `^説明の行$|^説明$`・祖先の名前 `^板の頭|^頭$` — 頭の下の説明の行（「？」へ入れる）
- **決まり**：[§5](v8-design-rules.md)・[§6.12-2](v8-design-rules.md)・B-158
- **見張り**：`apps/web/src/components/shared/page-header-enlyo-contract.test.ts`・`apps/web/src/components/templates/page-templates-head-contract.test.ts`
- **10-09 の数**：(a) 158（v8 109）・(b) 4・(c) 216・(d) 手描き 26（17 板）／写し 149・効く範囲 169 ファイル／74 機能／Pen 505 板

<a id="toolbar"></a>
## toolbar 一覧の道具の段

- **役目**：検索→絞り込みの札→並び→右端に件数の切り替えを1段で並べる
- **持ち主（コード）**：`apps/web/src/components/shared/list-toolbar.tsx`・`apps/web/src/components/shared/list-toolbar.module.css`・`apps/web/src/components/shared/search-field.tsx`（部品 `ListToolbar`・`ListToolbarSearch`・`ListToolbarOptional`）
  - 読む変数：`--color-control-border`・`--control-shadow`
- **持ち主（Pen）**：`c4n9Kr`「道具の1段」・`TkVyB`「検索」
- **見つけ方（コード）**：
  - toolbar-class：`styles\.(toolbar|toolBar|tools|controlsRow|filterBar|filtersRow|searchRow)\b`（持ち主の部品を読んでいないファイルだけ） — 道具の段を CSS で手書き
  - search-alone：`<SearchField\b`（持ち主の部品を読んでいないファイルだけ） — 検索欄を道具の段の外で置いている
  - sort-alone：`<SortSelect\b`（持ち主の部品を読んでいないファイルだけ） — 並びの欄を道具の段の外で置いている
  - (b) の割り当て：画面の CSS の上書きの selector が `toolbar` に当たればこの型
  - (c) の割り当て：直書きの selector が `toolbar|toolBar|controls\b|filters?Row|searchRow` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - hand-toolbar：名前 `^(道具|道具の段|検索の段|絞り込みの段)$` — 道具の段の手描き（部品「道具の1段」でない）
- **決まり**：[§6.8](v8-design-rules.md)・[§6.11-12](v8-design-rules.md)・B-143・B-122・B-157
- **見張り**：`apps/web/src/components/shared/list-toolbar-contract.test.tsx`・`apps/web/src/components/ui/list-controls-contract.test.ts`
- **10-09 の数**：(a) 227（v8 170）・(b) 1・(c) 9・(d) 手描き 157（153 板）／写し 3・効く範囲 36 ファイル／29 機能／Pen 191 板

<a id="filter"></a>
## filter 絞り込み

- URLで分類を切り替える札は `shared/filter-link`。リンク先・現在地・再読込を保つ。

- **役目**：一覧を状態・種類などで絞る札。数が増える物は選ぶ窓で絞る
- **持ち主（コード）**：`apps/web/src/components/shared/filter-chip.tsx`・`apps/web/src/components/shared/filter-chip.css`（部品 `FilterChip`）
  - 読む変数：`--color-control-border`
- **持ち主（Pen）**：`XGJDa`「絞り込みの札/オン」・`O2fCAt`「絞り込みの札/オフ」
- **見つけ方（コード）**：
  - growing-select：`<Select\b(?:[^<>]|=>){0,400}?(label|aria-label|placeholder)=["'][^"']*(店舗|タグ|シナリオ|担当者|所属アカウント|送信者|スタッフ|テンプレート)` — 数が増える物の絞り込みをプルダウンで（B-164 は選ぶ窓）
  - own-chip：`aria-pressed=\{`（持ち主の部品を読んでいないファイルだけ） — 絞り込みの札を aria-pressed で自作
  - (b) の割り当て：画面の CSS の上書きの selector が `filter|chip` に当たればこの型
  - (c) の割り当て：直書きの selector が `filter|chip` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - hand-chip：名前 `^(札 すべて|絞り込み|札 絞り込み)`・名前が `絞り込みの札|窓を開く` でない — 絞り込みの札の手描き
- **決まり**：[§6.17](v8-design-rules.md)・B-164・B-163
- **見張り**：`apps/web/src/components/shared/filter-chip.test.tsx`／**要る試験**：道具の段の絞り込みで、作った物（店舗・タグ・シナリオ）を Select で並べたら落ちる試験
- **10-09 の数**：(a) 190（v8 90）・(b) 28・(c) 29・(d) 手描き 37（27 板）／写し 5・効く範囲 116 ファイル／55 機能／Pen 40 板

<a id="folder-column"></a>
## folder-column フォルダの列



- L6判定X1・X2（2026-10-13）：ListPageがフォルダ機能の無い一覧の作成を題右へ移し、ListPageBodyのListFolderContextがFolderDotNameへ丸の要否を伝える。畳まれたフォルダ列は機能ありのまま。持ち主は `apps/web/src/components/shared/list-folder-context.tsx` と既存の一覧型・名前部品。見張りは `fix-patterns-browser.mjs` のF9と故障対照。

- **役目**：一覧の左でフォルダを選び・作り・並べ替える
- **持ち主（コード）**：`apps/web/src/components/shared/managed-folder-panel.tsx`・`apps/web/src/components/shared/managed-folder-panel.module.css`・`apps/web/src/components/shared/folder-panel.tsx`・`apps/web/src/components/shared/folder-panel.module.css`・`apps/web/src/components/shared/folder-row-actions.tsx`・`apps/web/src/components/shared/folder-add-dialog.tsx`・`apps/web/src/components/shared/folder-editor-dialog.tsx`・`apps/web/src/components/shared/folder-dot.tsx`（部品 `ManagedFolderPanel`・`FolderPanel`・`FolderDot`）
  - 読む変数：`--color-hairline`
- **持ち主（Pen）**：`faSbC`「フォルダの列」
  - 部品の板の html に書き出されていない ID：`faSbC`（文書の記録 `~/lh-work/design/v8/review/PEN-UPDATE-1009.md`・`COMPONENT-MAP.md` にある。(d) の写しの比べはできない）
- **見つけ方（コード）**：
  - raw-panel：`<FolderPanel\b`（持ち主の部品を読んでいないファイルだけ） — FolderPanel を直に使う（ManagedFolderPanel にする）
  - row-actions：`\buseFolderRowActions\(` — フォルダの行の「…」を画面で組む
  - own-dialog：`<(FolderAddDialog|FolderEditorDialog)\b` — フォルダの窓を画面で直に出す
  - folder-words：`(?:>|['"'])[^<'"']{0,40}(?:フォルダを追加する|見る：|フォルダを消しても)` — フォルダの列の言葉が決まりと違う
  - (b) の割り当て：画面の CSS の上書きの selector が `folder|rail` に当たればこの型
  - (c) の割り当て：直書きの selector が `folder|rail` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - hand-folders：名前 `^(フォルダ|フォルダの一覧|左の列|見る)$` — フォルダの列の手描き（部品 faSbC でない名前）
- **決まり**：[§2](v8-design-rules.md)・[§6.8](v8-design-rules.md)・B-143・B-136・B-126・B-147
- **見張り**：`apps/web/src/components/shared/folder-panel-contract.test.ts`・`apps/web/src/components/shared/managed-folder-panel.test.tsx`・`apps/web/src/components/shared/folder-rail-owner-contract.test.ts`・`apps/web/src/v8/folder-dot-1152-contract.test.ts`
- **10-09 の数**：(a) 83（v8 60）・(b) 1・(c) 32・(d) 手描き 19（11 板）／写し 0・効く範囲 16 ファイル／13 機能／Pen 0 板

<a id="table"></a>
## table 表

- **役目**：表を見出し40・左右24・線は黒7%で並べる
- 列配分：`DataTable.columnSizing="controls"` は状態札と操作の列だけ必要な自然幅を確保し、`Th/Td.grow` の名前列へ残りを配る。固定の名前・日時等の予算は保持。空の伸縮スペースは幅に含めず、前後の間は含める。`content` と未指定の表は従来どおり。
- **持ち主（コード）**：`apps/web/src/components/shared/table.tsx`・`apps/web/src/components/shared/table.module.css`・`apps/web/src/components/shared/grid-table.tsx`・`apps/web/src/components/shared/grid-table.module.css`・`apps/web/src/components/shared/data-table.module.css`・`apps/web/src/components/shared/table-presentation.module.css`（部品 `DataTable`・`TableHeadRow`・`Th`・`Tr`・`Td`・`SortTh`・`GridTable`・`GridHeadRow`・`GridRow`・`GridCell`）
  - 行高の対応（§6.5-3・2026-10-12 B-254）：一覧型内の `DataTable`・`GridTable`、テンプレート一覧は、**セル内の描画文字が1行なら52、2行・3行なら60**。判定は共通表の `useListRowDensity`、値は `--tpl-list-row-h`／`--tpl-list-row-multi-h`。文字のない高さ40の見本画像は複数行相当。WQmepの受信表は絵で確認した既存の専用口60を保持。1行の `ListSkeleton` は52、一般の表・`TableSkeleton` は56。行高の正本は見た目の決まり §6.5-3。
  - 読む変数：`--color-table-head`・`--color-hairline`
- **持ち主（Pen）**：`ASVsl`「表の見出し」・`JpOg0`「表の行」・`TBCUY`「横に送れる表」
- **見つけ方（コード）**：
  - raw-table：`<table\b` — 表を素の table で手書き
  - raw-grid：`role=["'](grid|row|columnheader|rowheader)["']` — 表を role で手書き
  - (b) の割り当て：画面の CSS の上書きの selector が `\b(table|thead|tbody|tr|th|td)\b` に当たればこの型
  - (c) の割り当て：直書きの selector が `table|row\b|rows\b|cell|thead|tbody|\bth\b|\btd\b|\btr\b` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - hand-row：名前 `^行 `・style に `height: 5\d px|height: 5\dpx|height: (52|54|56|60|61)px` — 表の行の手描き（部品「表の行」でない）
- **決まり**：[§6.5-3](v8-design-rules.md)・[§6.1](v8-design-rules.md)・B-152・B-160
- **見張り**：`apps/web/src/components/shared/table.test.tsx`・`apps/web/src/components/shared/v8-table-row-line-contract.test.ts`・`apps/web/src/components/shared/table-header-migration-contract.test.ts`
- **10-09 の数**：(a) 546（v8 458）・(b) 581・(c) 204・(d) 手描き 4（2 板）／写し 20・効く範囲 223 ファイル／81 機能／Pen 86 板

- **10-11の追加**：[§6.28](v8-design-rules.md)・B-217・B-218。一覧は外枠・角丸・影の無い平らな表、線と色付き行は領域いっぱい、中身は左右24。名前は黒の太字1行＋フォルダ丸。旧いv19Ivv基準・左右16は B-217、名前の緑は B-218 で置き換え。`apps/web/scripts/list-row-audit.mjs`・`apps/web/scripts/v8-guard/list-skeleton-audit.mjs` が既存の見張り。

<a id="row-menu"></a>
## row-menu 行の右端「…」

- **役目**：行の操作を右端の「…」1つにまとめる
- **持ち主（コード）**：`apps/web/src/components/shared/row-actions.tsx`・`apps/web/src/components/shared/row-actions.module.css`・`apps/web/src/components/shared/action-menu.tsx`・`apps/web/src/components/shared/action-menu.module.css`（部品 `RowMenu`・`MoreAction`・`RowActions`・`RowAction`・`RowQuickAction`・`RowStatusActions`）
- **持ち主（Pen）**：`hnuY9`「その他操作メニュー」
  - 部品の板の html に書き出されていない ID：`hnuY9`（文書の記録 `~/lh-work/design/v8/review/PEN-UPDATE-1009.md`・`COMPONENT-MAP.md` にある。(d) の写しの比べはできない）
- **見つけ方（コード）**：
  - own-dots：`>\s*(…|⋯|\.\.\.)\s*<` — 「…」を手で描く
  - dots-icon：`\b(MoreHorizontal|MoreVertical|DotsHorizontal|EllipsisHorizontal|Ellipsis)\b`（持ち主の部品を読んでいないファイルだけ） — 「…」の印を手で置く
  - row-buttons：`styles\.(rowActions|rowButtons|actionsCell|rowOps)\b`（持ち主の部品を読んでいないファイルだけ） — 行の右端にボタンを並べる
  - (b) の割り当て：画面の CSS の上書きの selector が `rowMenu|rowAction|more` に当たればこの型
  - (c) の割り当て：直書きの selector が `rowMenu|rowAction|more\b|kebab|ellipsis|rowButtons?` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - hand-dots：文字 `^(…|⋯)$`・祖先の名前 `^行|表の行` — 「…」の手描き（その他の操作の部品でない）
  - 除く祖先：`^その他の操作`
- **決まり**：[§2](v8-design-rules.md)・[§6.8](v8-design-rules.md)・B-143
- **見張り**：`apps/web/src/components/shared/row-actions-contract.test.tsx`・`apps/web/src/v8/row-menu-contract.test.ts`
- **10-09 の数**：(a) 109（v8 53）・(b) 31・(c) 9・(d) 手描き 0（0 板）／写し 0・効く範囲 132 ファイル／68 機能／Pen 0 板

- **10-11の追加**：[§6.28](v8-design-rules.md)・[§6.39](v8-design-rules.md)・B-193・B-199・B-200・B-232。一覧の主操作は1つまで、編集の専用ボタン列を置かない。操作がある全行に同じxの「…」。閲覧のみで操作が無い板と読むだけの履歴表は対象外。

<a id="pagination"></a>
## pagination ページ送り

- **役目**：ページを送り、10・20・50件を切り替える
- **持ち主（コード）**：`apps/web/src/components/shared/pagination.tsx`・`apps/web/src/components/shared/list-pagination.tsx`・`apps/web/src/components/shared/pagination.module.css`・`apps/web/src/components/shared/page-size-select.tsx`・`apps/web/src/components/shared/page-size-options.ts`（旧 ui は再公開）・`apps/web/src/components/ui/list-range.tsx`（部品 `Pagination`・`ListPagination`・`PageSizeSelect`・`pageSizeOptions`・`pageSizeLabel`・`ListPagePagination`）
- **持ち主（Pen）**：`jX2Uw`「ページ送り」
  - 注：PageSizeSelect は shared が持つ（B-172）。
  - 手元に全件がある一覧は `ListPagination` へ total/page/pageSize/unit を渡す。範囲とページ数を部品が決め、1ページ・0件でも枠を残す。カーソル式や総数未取得は既存の `Pagination`／`CursorPagination` を使う。
- **見つけ方（コード）**：
  - own-size：`\b(const|let)\s+\w*(PAGE_SIZE|PAGE_SIZES|PER_PAGE|pageSizes|perPageOptions)\w*\s*=` — 件数の定数を画面ごとに持つ
  - own-range-text：`summary`／`pagerSummary` で件数文を組む — `Pagination.range` へ総数・先頭・末尾・単位だけを渡す（L組差し戻しB）。
  - size-100：`\[\s*20\s*,\s*50\s*,\s*100\s*\]` — 件数が 20・50・100（決まりは 10・20・50）
  - more：`(?:>|['"'])[^<'"']{0,40}(?:もっと読む|さらに読み込む|もっと見る)` — 「もっと読む」（ページ送りにする）
  - prev-next：`(?:>|['"'])[^<'"']{0,40}(?:前へ|次へ)`（持ち主の部品を読んでいないファイルだけ） — 前へ・次へを手で置く
  - (b) の割り当て：画面の CSS の上書きの selector が `pagination|pager` に当たればこの型
  - (c) の割り当て：直書きの selector が `pagination|pager|pageSize|perPage` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - hand-pager：文字 `^(前へ|次へ|もっと読む|‹|›)$` — ページ送りの手描き
  - 除く祖先：`^ページ送り`
- **決まり**：[§2](v8-design-rules.md)・[§6.8](v8-design-rules.md)・B-143
- **見張り**：`apps/web/src/components/ui/list-range-contract.test.ts`／**要る試験**：ページ送りのある一覧で件数の切り替え（10・20・50）が無い・定数を画面で持つと落ちる試験
- **10-09 の数**：(a) 222（v8 126）・(b) 0・(c) 12・(d) 手描き 8（6 板）／写し 0・効く範囲 155 ファイル／71 機能／Pen 56 板

- **10-11の追加**：[§6.30](v8-design-rules.md)・B-211・B-231。番号と次の矢印は同じ枠、今のページだけ薄い緑。部品 jX2Uw の番号・枠を画面の上書きで消さない。

<a id="detail-panel"></a>
## detail-panel 詳細のパネル・引き出し

- **役目**：行の詳細は右の DetailPanel 360、編集は Drawer 480/540
- **持ち主（コード）**：`apps/web/src/components/shared/detail-panel.tsx`・`apps/web/src/components/shared/detail-panel.module.css`・`apps/web/src/components/shared/drawer.tsx`・`apps/web/src/components/shared/drawer.module.css`（部品 `DetailPanel`・`Drawer`）
  - 読む変数：`--radius-panel`・`--shadow-float`
- **持ち主（Pen）**：**未定**
  - 注：Pen の部品 ID が対応表に無い（ZBjxY の「引き出し」は板の中の名前だけ）
- **見つけ方（コード）**：
  - fixed-right：CSS の規則に `position:\s*fixed` と `right:\s*0` と `width:\s*\d{3}px|width:\s*min\(` があり — 右から出るパネルを CSS で手書き
  - aside：`<aside\b`（持ち主の部品を読んでいないファイルだけ） — 右のパネルを aside で手書き
  - (b) の割り当て：画面の CSS の上書きの selector が `drawer|detailPanel` に当たればこの型
  - (c) の割り当て：直書きの selector が `drawer|panel|aside|sidePane|sheet` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - odd-width：名前 `引き出し|詳細パネル|右の欄`・style に `width: \d+px`・style に `width: (360|480|540|320|1160)px` が無い — 段にない幅のパネル（360・480・540・320・1160 以外）
- **決まり**：[§6.12-8](v8-design-rules.md)・B-158・B-160
- **見張り**：`apps/web/src/components/shared/detail-panel.test.tsx`／**要る試験**：Drawer の幅が 480/540 以外・手書きの固定パネルで落ちる試験
- **10-09 の数**：(a) 140（v8 73）・(b) 3・(c) 14・(d) 手描き 13（9 板）／写し 0・効く範囲 41 ファイル／29 機能／Pen 0 板

<a id="dialog"></a>
## dialog 窓（確かめ・編集）

- **役目**：確かめ・編集・選ぶを共通の窓で出す。短い確認は説明から操作まで24px・区切り線なし、作成・長い入力の窓は線を保つ。共通Dialogが確認用途と本文・手順の有無で判別する（2026-10-23オーナー決定B）。
- **持ち主（コード）**：`apps/web/src/components/shared/dialog.tsx`・`apps/web/src/components/shared/dialog.module.css`・`apps/web/src/components/shared/confirm-dialog.tsx`・`apps/web/src/components/shared/overlay-utils.ts`（部品 `Dialog`・`ConfirmDialog`・`DialogSteps`）
  - 窓の頭の任意の印は `Dialog.headerIcon`・`ConfirmDialog.headerIcon`・`Drawer.headerIcon`。淡い色の丸へ置き、説明は既存の `description` で題の下に出す。標準の頭には既定の線の印を補い、`false` なら省く。固定高さの頭には既定の印を足さない。危険な操作の `titleIcon` は独立して保つ。明るい面・角16・柔らかい影・薄い背景と軽いぼかしは共通値、開閉はtransformとopacityのみ。
  - 窓の閉じる印は薄い線の丸、取消の副操作は窓内だけ薄灰の塗り。フォームのまとまりは `DialogContentRow` の `tone="muted"` とフォルダ編集の共通部品が持ち、画面側で装飾を足さない。
  - 入力行：`shared/dialog-form-row.tsx` の `DialogFormRow` に既存の `Field` を渡す。独立した入力を本文幅へそろえ、保存・エラーは呼び出し側のまま保つ。
  - チェック・未設定情報の行：同じファイルの `DialogContentRow` に共通 `Checkbox` または名前・操作を渡す。チェック後も行の薄い線を保ち、未設定情報は `tone="muted"` の灰色の面で1行にまとめる。
  - 公開前の宛先：`shared/dialog-recipient-list.tsx` の `DialogRecipientList` へ実際の名前・役割・共通の通知方法の札を渡す。通常一覧の固定行高を持たず、役割を読めない時は「—」。
  - 作る種類を選ぶ窓：`shared/dialog-choice-cards.tsx` の `DialogChoiceCards` へ名前・説明・行き先を渡す。3列のカードの説明は安全に折り返し、名前は1行、クリック・キーボード・別タブで行き先を開ける。選択を保存するラジオとは分ける。
  - 使用先を示す窓：`shared/dialog-usage-table.tsx` の `DialogUsageTable` へ種類・名前・行き先を渡す。フォルダの丸を出さず、名前の省略と全文確認・外部の行き先の印1つを共通部品で保つ。
  - 確認の本文を全幅で並べる場合は `ConfirmDialog.contentLayout="form"` を選ぶ。既定の本文配置は維持する。
  - 確認の実行を左、取消を中央に分ける場合は `confirmPlacement="start"`。通常の文字幅は `actionWidthReserve="idle"` で指定し、既定の結果文の幅予約は保つ。
  - 独自の処理を持つ窓でも操作は `DialogActions` に渡す。`footerAlign` だけを指定して本文にボタンを直置きしない。
  - 補助操作がある帯は、共通部品が左の最大ボタン幅を左右とも確保し、主操作を中央で折り返す。理由の行が増えても左は最初のボタン行へそろえる。実幅が左右同幅の配置に足りない場合は、共通部品で補助操作を上・中央の組を下へ積み、間を8px以上にする。画面側で幅や上下位置を補正しない。
  - 未保存の確認は `UnsavedLeaveDialog` を使う。保存・破棄の意味が異なる場合のみ `saveLabel` / `discardLabel` / `error` / `onSavedLeave` を渡し、保存成功後の移動と破棄の処理を分ける。破棄だけの権限は `discardDisabled` / `discardLockedReason` で保存から分け、保持した操作も現在の権限を守る。省略時の表示と動きは変えない。
  - 参照だけの窓は右上の×で閉じ、下の帯に閉じるボタンを置かない。操作の帯は取消と主操作を中央、脇の操作を `leadingAction` へ。理由などの入力は本文に置く。全画面の検査は `scripts/visual-qa/dialog-footer-contract.test.ts`。
  - 読む変数：`--polish-radius-dialog`・`--polish-window-*`・`--card-edge`
- **持ち主（Pen）**：`q3DPdz`「ダイアログ/中」
- **見つけ方（コード）**：
  - raw-dialog：`role=["']dialog["']|aria-modal=|<dialog\b` — 窓を手書き
  - confirm：`\bwindow\.confirm\(|(?<![\w.])confirm\(\s*['"']` — ブラウザの confirm
  - half-q：`title=["'][^"']*\?["']` — 窓の題の「?」が半角（B-146 の 6）
  - (b) の割り当て：画面の CSS の上書きの selector が `dialog|modal|\[role=.?dialog|::backdrop` に当たればこの型
  - (c) の割り当て：直書きの selector が `dialog|modal|overlay|backdrop` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - hand-dialog：名前 `(の窓|窓$|小窓)`・名前が `選ぶ窓|窓を開く|窓で選ぶ` でない・style に `border-radius: 16px` — 窓の手描き（部品「ダイアログ/中」でない）
- **決まり**：[§5](v8-design-rules.md)・[§6.8](v8-design-rules.md)・[§6.12-8](v8-design-rules.md)・B-145・B-146
- **見張り**：`apps/web/src/components/shared/dialog-design-size-contract.test.tsx`・`apps/web/src/components/shared/confirm-dialog-design-size.test.tsx`・`apps/web/src/components/shared/dialog-design-header.react.test.tsx`／**要る試験**：窓の題の終わりが半角「?」・記号なしで落ちる試験
- **10-09 の数**：(a) 109（v8 32）・(b) 18・(c) 41・(d) 手描き 6（6 板）／写し 0・効く範囲 354 ファイル／109 機能／Pen 0 板

- **10-11の追加**：[§6.42](v8-design-rules.md)・B-180・B-240。確かめの窓は480／560／720／960の段、既定480。絵の520等を正にしない。選ぶ窓640は [picker-dialog](#picker-dialog) の例外、引き出し480／540は [detail-panel](#detail-panel)。既存の幅の試験と照合で区別する。

<a id="picker-dialog"></a>
## picker-dialog 選ぶ窓

- **役目**：作ってある物を、フォルダ・探す・見本付きの窓で選ぶ（受信箱の「テンプレートを選ぶ」の形1つ）
- **持ち主（コード）**：`apps/web/src/components/shared/entity-picker.tsx`・`apps/web/src/components/shared/entity-picker.module.css`・`apps/web/src/components/shared/entity-picker-sources.tsx`・`apps/web/src/components/shared/hq-account-picker.tsx`（部品 `EntityPickerDialog`・`EntityPickerWindow`・`EntityMultiPickerDialog`・`HqAccountPickerDialog`）
- **持ち主（Pen）**：`S2Vgi`「選ぶ窓（正の形・B-165）」・`A1eZS`「選ぶ窓（V8-B の写し）」
  - 部品の板の html に書き出されていない ID：`S2Vgi`・`A1eZS`（文書の記録 `~/lh-work/design/v8/review/PEN-UPDATE-1009.md`・`COMPONENT-MAP.md` にある。(d) の写しの比べはできない）
- **見つけ方（コード）**：
  - old-picker：`<(SourcePickerDialog|SelectionDialog)\b` — 古い選ぶ窓（EntityPickerDialog にする）
  - own-picker：`\b(function|const)\s+\w*(Picker|Chooser|Selector)(Dialog|Modal)\b` — 画面で選ぶ窓を自作
  - (b) の割り当て：画面の CSS の上書きの selector が `picker` に当たればこの型
  - (c) の割り当て：直書きの selector が `picker|chooser` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - old-window：名前 `選ぶ窓|を選ぶ窓|1つ選ぶ窓`・名前が `B-165|^10\. 選ぶ窓` でない — 正の形でない選ぶ窓（dJZ7Q など古い窓）
- **決まり**：[§6.10](v8-design-rules.md)・[§6.17](v8-design-rules.md)・B-155・B-163・B-165・B-133
- **見張り**：`apps/web/src/components/shared/entity-picker.test.tsx`・`apps/web/src/components/shared/select-window-react.test.tsx`／**要る試験**：選ぶ窓を SourcePickerDialog・自作の窓で出すと落ちる試験
- **10-09 の数**：(a) 2（v8 1）・(b) 1・(c) 1・(d) 手描き 3（3 板）／写し 0・効く範囲 2 ファイル／1 機能／Pen 0 板

<a id="picker-field"></a>
## picker-field 選ぶ欄（選ぶ前・選んだ後）

- 電話予約で検索した友だちの行は `shared/friend-match-row.tsx` の `FriendMatchRow`。選択の薄い帯、名前/補足、選ぶ/選び直すを1行で持ち、行の内側へ別の選択枠を重ねない。

- **役目**：選ぶ前は「〇〇を選ぶ」の副ボタン、選んだ後は見本・札＋「変える」
- 候補自身の印の色は `EntityPickerItem.color` から共通 `TagPill` へ渡す。基本の追加URLの青い印もこの口を使い、画面で札のCSSを上書きしない。
- **持ち主（コード）**：`apps/web/src/components/shared/entity-picker.tsx`（部品 `EntityPickerSummary`・`EntityPickerField`・`HqAccountPickerField`・`HqAccountSelectField`）
- **持ち主（Pen）**：**未定**
  - 注：Pen の欄の部品 ID が無い（決まりの板 MqqcW・aXUuh は見本。板では「選んだもの（B-163 窓で選ぶ）」の名前）
- **見つけ方（コード）**：
  - select-entity：`<(Select|Combobox|MultiSelect)\b(?:[^<>]|=>){0,500}?(label|aria-label|placeholder)=["'][^"']*(テンプレート|回答フォーム|タグ|シナリオ|リッチメニュー|予約メニュー|クーポン|スタンプカード|スタッフ|セグメント|アカウント|店舗|友だち情報)` — 作ってある物をプルダウンで選ばせる（B-155・B-163）
  - multi-select：`<(MultiSelect|EntityMultiSelect)\b` — 下に広がる複数選び（B-163 は窓）
  - (c) の割り当て：直書きの selector が `pickerField|picked|chosen` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - dropdown-entity：名前 `^欄 (テンプレート|回答フォーム|タグ|シナリオ|リッチメニュー|予約メニュー|クーポン|スタッフ|店舗|アカウント)` — 作ってある物を選ぶ欄がプルダウンの形
- **決まり**：[§2](v8-design-rules.md)・[§6.10](v8-design-rules.md)・[§6.17](v8-design-rules.md)・B-155・B-163
- **見張り**：`apps/web/src/components/shared/entity-picker.test.tsx`／**要る試験**：作ってある物（テンプレート・タグ…）の label の Select が出たら落ちる試験
- **10-09 の数**：(a) 137（v8 71）・(b) 0・(c) 2・(d) 手描き 64（19 板）／写し 0・効く範囲 7 ファイル／4 機能／Pen 0 板

<a id="select"></a>
## select プルダウン（許される範囲）

- 浮く面の位置・はみ出し・押した角からの開きは共通 `shared/menu-portal` と同CSSが持つ。絞り込みの入力と操作を置く面は `shared/filter-popover`。画面は入力・解除・閉じる操作だけを渡す。内側の日付候補はEscで先に閉じ、外側の面は残す。

- **役目**：数が決まっていて少ない選択（種類・並び・期間・件数・役割など7個まで）だけ
- **持ち主（コード）**：`apps/web/src/components/shared/select.tsx`・`apps/web/src/components/shared/select.module.css`・`apps/web/src/components/shared/select-menu.tsx`・`apps/web/src/components/shared/select-menu.module.css`・`apps/web/src/components/shared/menu-portal.tsx`（部品 `Select`・`SelectMenu`）
  - 読む変数：`--color-control-border`・`--radius-control`
  - 既存の栞付き絞り込み（axFrW／wjfLe）は `icon`・`valueAlign="start"`・`showChevron={false}`、狭い段は `iconOnly`。画面側でボタンの余白・矢印・値を上書きしない。
- **持ち主（Pen）**：`wMMk6`「選ぶ欄」・`StFE7`「選ぶ欄/開いた」
  - 部品の板の html に書き出されていない ID：`StFE7`（文書の記録 `~/lh-work/design/v8/review/PEN-UPDATE-1009.md`・`COMPONENT-MAP.md` にある。(d) の写しの比べはできない）
- **見つけ方（コード）**：
  - raw-select：`<select\b` — 素の select
  - own-listbox：`role=["'](listbox|option|menu|menuitem)["']` — 開いた一覧を手書き
  - head-prefix：`label:\s*['"'](並び|フォルダ|状態)：` — 選択肢に「並び：」などの頭（B-45）
  - (b) の割り当て：画面の CSS の上書きの selector が `select|dropdown|listbox` に当たればこの型
  - (c) の割り当て：直書きの selector が `select|dropdown|listbox|menuList` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - hand-open：名前 `^(開いた|メニュー|選択肢の一覧|候補)$` — 開いた中身の手描き（StFE7 でない）
- **決まり**：[§2](v8-design-rules.md)・[§6.17](v8-design-rules.md)・B-45・B-163
- **見張り**：`apps/web/src/components/shared/select-menu.react.test.tsx`・`apps/web/src/components/shared/select-width-text.test.tsx`・`apps/web/src/components/shared/menu-portal-rollout-contract.test.ts`
- **10-09 の数**：(a) 154（v8 88）・(b) 33・(c) 18・(d) 手描き 12（8 板）／写し 3・効く範囲 376 ファイル／111 機能／Pen 97 板

<a id="tap-action"></a>
## tap-action 押したら（TapActionField）

- 窓を開く要約欄は `shared/tap-action-summary` が共通の選択欄へ接続する。

- **役目**：ボタン・面を押したときの動き（URL・テキスト・予約・回答フォーム・予約履歴・来店スタンプ）を選ぶ
- **持ち主（コード）**：`apps/web/src/components/shared/tap-action-field.tsx`・`apps/web/src/components/shared/tap-action-field.module.css`・`apps/web/src/lib/tap-actions.ts`・`apps/web/src/components/shared/use-tap-action-sources.ts`（部品 `TapActionField`・`TapTargetPicker`）
- **持ち主（Pen）**：`Vx8Ny`「押したら（TapActionField）/閉じた」・`XVGg5`「押したら/開いた」・`c1qBx`「押したら/選んだ後」
  - 部品の板の html に書き出されていない ID：`Vx8Ny`・`XVGg5`・`c1qBx`（文書の記録 `~/lh-work/design/v8/review/PEN-UPDATE-1009.md`・`COMPONENT-MAP.md` にある。(d) の写しの比べはできない）
- **見つけ方（コード）**：
  - old-uri：`<UriTapActionField\b` — 古い押したらの欄
  - own-types：`['"](uri|postback|message|datetimepicker)['"]\s*[,:]`（持ち主の部品を読んでいないファイルだけ）（ファイル `\.tsx$`） — 押したらの種類を画面で並べる
  - own-label：`(?:>|['"'])[^<'"']{0,40}(?:押したときの動き|タップしたとき|押したら)`（持ち主の部品を読んでいないファイルだけ） — 押したらの欄を画面で組む
  - (b) の割り当て：画面の CSS の上書きの selector が `tapAction` に当たればこの型
  - (c) の割り当て：直書きの selector が `tapAction|actionType|tapType` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - hand-tap：名前 `^(欄 )?(押したら|押した時の動き|ボタンの動き)$` — 押したらの欄の手描き
- **決まり**：[§6.13](v8-design-rules.md)・B-129・B-135
- **見張り**：`apps/web/src/components/shared/tap-action-field.test.tsx`・`apps/web/src/lib/tap-actions.test.ts`
- **10-09 の数**：(a) 44（v8 29）・(b) 0・(c) 1・(d) 手描き 0（0 板）／写し 0・効く範囲 6 ファイル／6 機能／Pen 0 板

<a id="tap-extra"></a>
## tap-extra 押されたときにあわせて行うこと

- タグとスコアの行は `shared/tap-extras-rows` が共通の ActionList へ接続する。画面の保存値は変えない。

- **役目**：押したらに付けて、タグを付ける・スコアを足す
- **持ち主（コード）**：`apps/web/src/components/shared/tap-action-field.tsx`（部品 `TapActionField`）
- **持ち主（Pen）**：`A2gkiG`「あわせて行うこと/閉じた」・`TPuCf`「あわせて行うこと/開いた」・`b2hVaX`「あわせて行うこと/選んだ後」
  - 部品の板の html に書き出されていない ID：`A2gkiG`・`TPuCf`・`b2hVaX`（文書の記録 `~/lh-work/design/v8/review/PEN-UPDATE-1009.md`・`COMPONENT-MAP.md` にある。(d) の写しの比べはできない）
- **見つけ方（コード）**：
  - own-extra：`(?:>|['"'])[^<'"']{0,40}(?:タグを付ける|スコアを足す|スコアを加算|タグを追加する)`（持ち主の部品を読んでいないファイルだけ） — あわせて行うことを画面で組む
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - hand-extra：名前 `押した人に|タグを付ける行` — あわせて行うことの手描き
- **決まり**：[§6.17](v8-design-rules.md)・B-162・B-164
- **見張り**：`apps/web/src/components/shared/tap-action-field.test.tsx`
- **10-09 の数**：(a) 48（v8 27）・(b) 0・(c) 0・(d) 手描き 0（0 板）／写し 0・効く範囲 6 ファイル／6 機能／Pen 0 板

<a id="action-list"></a>
## action-list 行うことを足す

- **役目**：［＋ 行うことを足す］→種類→選ぶ窓→行で並べる（回答フォーム・カルーセル・質問・自動応答・友だち追加・リッチメニュー）
- **持ち主（コード）**：**未実装**
- **持ち主（Pen）**：**未定**
  - 注：未実装（B-169）。コードの部品も Pen の部品も無い。作ってから持ち主を書く
- **見つけ方（コード）**：
  - words：`(?:>|['"'])[^<'"']{0,40}(?:行うことを足す|行うことを追加|アクションを追加|答え終わったら|回答したときに付けるタグ|使われたときに行うこと|答え終わったときに行うこと)` — 「行うこと」を画面ごとに組んでいる
  - (c) の割り当て：直書きの selector が `actions?List|actionRow|addAction` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - hand-actions：名前 `行うこと`・名前が `押されたときに、あわせて行うこと` でない — 行うことの段の手描き（部品が無い）
- **決まり**：[§6.19](v8-design-rules.md)・B-169
- **見張り**：なし／**要る試験**：共通部品を作ったら：回答フォーム・カルーセル・質問・自動応答・友だち追加・リッチメニューがその部品を読む試験
- **10-09 の数**：(a) 34（v8 16）・(b) 0・(c) 8・(d) 手描き 24（16 板）／写し 0・効く範囲 0 ファイル／0 機能／Pen 0 板

<a id="media-slot"></a>
## media-slot 画像の枠（MediaSlot）

- **役目**：画像・動画・音声・ファイルを入れる所（真ん中に印・題「〇〇を追加」・ドラッグ・制限の文）
- **持ち主（コード）**：`apps/web/src/components/shared/media-slot.tsx`・`apps/web/src/components/shared/media-slot.module.css`・`apps/web/src/components/shared/media-picker-dialog.tsx`・`apps/web/src/components/shared/media-library-upload.ts`（部品 `MediaSlot`・`MediaPickerDialog`）
- **持ち主（Pen）**：**未定**
  - 注：Pen の部品 ID が無い（Z7vd2 は見本で消した。板では「画像を追加 空・小・入った」の名前）
- **見つけ方（コード）**：
  - file-input：`type=["']file["']` — 手書きの file 入力
  - old-upload：`<(ImageUploader|FileDropzone)\b` — 古い取り込み部品
  - limit-text：`(?:>|['"'])[^<'"']{0,40}(?:MB\s*(以内|以下|まで)|JPG|jpg\/)`（持ち主の部品を読んでいないファイルだけ） — 上限の文を画面で書く
  - dashed：CSS の規則に `border(-style)?:[^;]*dashed` があり — 点線の箱
  - (b) の割り当て：画面の CSS の上書きの selector が `media|upload|drop` に当たればこの型
  - (c) の割り当て：直書きの selector が `upload|dropzone|drop\b|media|thumb|imageBox` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - dashed-box：style に `dashed` — 点線の古い箱
- **決まり**：[§6.12-9](v8-design-rules.md)・[§6.13](v8-design-rules.md)・B-128・B-138・B-161
- **見張り**：`apps/web/src/components/shared/media-slot.test.tsx`／**要る試験**：type="file" を共通部品の外で書いたら落ちる試験
- **10-09 の数**：(a) 81（v8 41）・(b) 1・(c) 11・(d) 手描き 0（0 板）／写し 0・効く範囲 26 ファイル／16 機能／Pen 0 板

<a id="field"></a>
## field 欄（Field・必須・任意・文字数）

- **役目**：ラベル・必須/任意の札・文字数・補足 note を1つの形で出す
- **持ち主（コード）**：`apps/web/src/components/shared/form-controls.tsx`・`apps/web/src/components/shared/form-controls.module.css`・`apps/web/src/components/shared/text-field.tsx`・`apps/web/src/components/shared/text-field.module.css`・`apps/web/src/components/shared/field-context.ts`（部品 `Field`・`TextInput`・`TextArea`・`RequiredBadge`・`OptionalBadge`・`TextField`）
  - 読む変数：`--color-control-border`・`--radius-control`
- **持ち主（Pen）**：`Ume2U`「入力欄」・`i5BW8b`「入力欄/複数行」
  - 部品の板の html に書き出されていない ID：`i5BW8b`（文書の記録 `~/lh-work/design/v8/review/PEN-UPDATE-1009.md`・`COMPONENT-MAP.md` にある。(d) の写しの比べはできない）
- **見つけ方（コード）**：
  - optional-paren：`（任意）|\(任意\)` — 「（任意）」（札にする）
  - asterisk：`>\s*[＊*]\s*<` — 必須の「＊」
  - own-count：`\.length\s*\}?\s*\/\s*\{?\s*\w*(MAX|max|limit|Limit|\d+)`（ファイル `\.tsx$`） — 文字数を画面で数えて出す
  - half-ex：`['">]例:\s?` — 入力例が半角「例:」
  - raw-label：`<label\b(?![^>]*className=\{styles\.(check|radio|toggle))`（持ち主の部品を読んでいないファイルだけ） — ラベルを手書き
  - (b) の割り当て：画面の CSS の上書きの selector が `\b(input|textarea|label)\b|field` に当たればこの型
  - (c) の割り当て：直書きの selector が `field|label|input|textarea|formRow|control\b` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - paren-optional：文字 `（任意）` — 「（任意）」の文字（札でない）
- **決まり**：[§6.12-4](v8-design-rules.md)・[§6.12-16](v8-design-rules.md)・B-158
- **見張り**：`apps/web/src/components/shared/optional-badge.test.tsx`・`apps/web/src/components/shared/text-field-unified.react.test.tsx`／**要る試験**：「（任意）」「＊」を書いたら落ちる試験
- **10-09 の数**：(a) 804（v8 332）・(b) 52・(c) 196・(d) 手描き 1（1 板）／写し 4・効く範囲 269 ファイル／91 機能／Pen 104 板

- **10-12の追加（F組・B-260）**：`CreatePage`の`contentDisabled`／`contentLabel`で本文をネイティブfieldsetにする。余白と段間は型が持ち、保存中・比較中・閲覧のみの入力をまとめて止める。通知と下の帯はfieldsetの外へ渡す。レポート作成の動作試験で保存・失敗・競合・権限を保つ。

- **10-12の変わり形（F組・B-260）**：同じ入力欄の前後に固定文字を置く`AffixedTextField`は`text-field.tsx`／`text-field.module.css`が持つ。値は入力部分だけ、前後の文字は保存しない。Fieldの必須・誤り・説明・フォーカスと同じ契約を保つ。画面で別の枠や焦点の輪を作らない。
- 札や補助ボタンを含む入力の外枠は `text-field.tsx` の `InputFieldFrame`。線は `input-field-ring.css` と共通の `--polish-focus-*` が持ち、内側の文字欄に重ねない。焦点は青2px、誤りは赤2pxを枠の上に1本描く。
- 招待のメール欄は `shared/email-chip-field.tsx`。既存の TextField・Chip を使い、Enter・貼り付け・欄から離れる操作で1件を札にする。複数件は切り捨てず入力に残して理由を示す。送信値・名前・権限は画面が持つ。
- 言葉を足す欄は `shared/keyword-input.tsx`。枠と検索印は `AffixedTextField`、幅は既存の言葉入力用の値を使う。Enter・カンマ・離れる操作で確定し、日本語の変換中は確定しない。条件や重複の判断は画面が渡す。

- **10-12の色選択の変わり形（F組）**：固定色をその場で選ぶ欄は`FolderColorButton`の`appearance="palette"`。丸は24px、選んだ色に輪。保存色が候補外でも現在色の選択を出す。色の名前・選択・矢印キーは同じ正本が持つ。既定のフォルダ色メニューは保つ。

<a id="field-error"></a>
## field-error 欄の赤表示

- **役目**：誤りの欄を赤く・下に理由・最初の誤りへ移る。欄に結び付かない失敗だけ Notice danger
- **持ち主（コード）**：`apps/web/src/lib/use-form-errors.ts`・`apps/web/src/components/shared/validation-summary.tsx`・`apps/web/src/components/shared/error-count-badge.tsx`・`apps/web/src/components/shared/form-controls.tsx`（部品 `useFormErrors`・`FieldError`・`ValidationSummary`・`ErrorCountBadge`）
  - 読む変数：`--color-danger`
- **持ち主（Pen）**：`fDAyI`「入力欄/エラー」
  - 部品の板の html に書き出されていない ID：`fDAyI`（文書の記録 `~/lh-work/design/v8/review/PEN-UPDATE-1009.md`・`COMPONENT-MAP.md` にある。(d) の写しの比べはできない）
- **見つけ方（コード）**：
  - raw-alert：`role=["']alert["']` — 手書きの role="alert"
  - own-invalid：`aria-invalid=\{`（持ち主の部品を読んでいないファイルだけ） — 欄の誤りを画面で組む
  - (b) の割り当て：画面の CSS の上書きの selector が `error|invalid` に当たればこの型
  - (c) の割り当て：直書きの selector が `error|invalid|alert` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - red-band-only：名前 `^帯 (エラー|誤り|失敗)` — 上の赤い帯だけの誤り
- **決まり**：[§6.9](v8-design-rules.md)・B-154・B-139
- **見張り**：`apps/web/src/lib/use-form-errors.test.tsx`・`apps/web/src/components/shared/field-errors-controls.react.test.tsx`／**要る試験**：作る・編集の画面が useFormErrors を読まないと落ちる試験
- **10-09 の数**：(a) 704（v8 477）・(b) 14・(c) 31・(d) 手描き 0（0 板）／写し 0・効く範囲 43 ファイル／27 機能／Pen 0 板

<a id="sticky-bar"></a>
## sticky-bar 作る・編集の下の帯

- **10-13の追加（F6・Y4）**：通常/分割の帯の主保存・作成・公開の印は `shared/sticky-save-actions.tsx` がSaveへそろえる。文字・markup・押下・無効・refは保持。次へ/リンク/副操作はその役目の印、処理中/完了は共通Buttonの状態を保つ。実ReactとSVG故障対照で確認する。 **10-14 C14差し戻しの例外**：役目の印を保持する操作は`Button.icon`へ明示する（シナリオ・共通情報のCheck／競合のGitCompare）。帯は明示iconを置き換えず、指定なしの保存印と待機/完了の状態印は維持。 件数で保存文が変わる操作は`Button.widthReserve="dynamic"`を指定し現在の全文で測り直す。既定の`states`/`idle`の幅は保つ（合格済みの窓と競合の帯を動かさない）。

- **役目**：画面の下に追従。キャンセル・保存は中央、削除は左端
- **持ち主（コード）**：`apps/web/src/components/shared/sticky-bar.tsx`・`apps/web/src/components/shared/sticky-bar.module.css`・`apps/web/src/components/templates/create-page.tsx`・`apps/web/src/components/shared/create-page.tsx`（部品 `StickyBar`・`CreatePage`・`PageFooter`）
  - 読む変数：`--shadow-bar-float`
- **持ち主（Pen）**：**未定**
  - 注：Pen の部品 ID が無い（板では「下の帯（追従・常に画面の下）」の名前）
- **見つけ方（コード）**：
  - sticky-bottom：CSS の規則に `position:\s*(sticky|fixed)` と `bottom:\s*0` があり — 下の帯を CSS で手書き
  - back-in-bar：`(?:>|['"'])[^<'"']{0,40}(?:一覧へ戻る|一覧に戻る)` — 帯に「一覧へ戻る」
  - (b) の割り当て：画面の CSS の上書きの selector が `footer|sticky|bottomBar` に当たればこの型
  - (c) の割り当て：直書きの selector が `footer|bottomBar|stickyBar|actionBar|saveBar` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - fixed-bar：名前 `^下の帯（固定）$` — 「固定」の下の帯（追従でない名前）
- **決まり**：[§2](v8-design-rules.md)・[§6.8](v8-design-rules.md)・B-143
- **見張り**：`apps/web/src/components/shared/sticky-bar-contract.test.ts`・`apps/web/src/components/templates/create-page-spacing.test.tsx`／**要る試験**：帯に「一覧へ戻る」・削除が左端でない形で落ちる試験
- **10-09 の数**：(a) 260（v8 162）・(b) 5・(c) 15・(d) 手描き 30（30 板）／写し 0・効く範囲 126 ファイル／72 機能／Pen 0 板

<a id="tabs"></a>
## tabs タブ

- 選択の下線と切り替えの背景は共通 `shared/sliding-indicator` が動かす。寸法を一度だけ更新し、選び直しは現在位置からtransformで200ms。初回・同じ選択の幅調整・動きを減らす設定では即時。

- **役目**：中身を切り替える。?tab= と router.replace
- **持ち主（コード）**：`apps/web/src/components/shared/tabs.tsx`・`apps/web/src/components/shared/tabs.module.css`・`apps/web/src/components/layout/scrollable-tabs.tsx`・`apps/web/src/components/layout/merged-tabs.tsx`（部品 `Tabs`・`ScrollableTabs`・`MergedTabs`）
- **持ち主（Pen）**：`clV5c`「タブ」
- **見つけ方（コード）**：
  - raw-tab：`role=["'](tab|tablist)["']` — タブを手書き
  - push-tab：`router\.push\([^)]*tab=` — タブで履歴を積む（replace にする）
  - (b) の割り当て：画面の CSS の上書きの selector が `tab|\[role=.?tab` に当たればこの型
  - (c) の割り当て：直書きの selector が `tab\b|tabs\b|tabList|tabBar` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - hand-tab：名前 `^(タブの段|種類のタブ)$` — タブの段の手描き
- **決まり**：[§5](v8-design-rules.md)・[§6.12-3](v8-design-rules.md)・B-158
- **見張り**：`apps/web/src/components/shared/tabs-height-contract.test.ts`・`apps/web/src/components/shared/tabs-v8-indicator.react.test.tsx`・`apps/web/src/components/layout/scrollable-tabs-contract.test.ts`／**要る試験**：role="tab" を共通部品の外で書いたら落ちる試験
- **10-09 の数**：(a) 86（v8 52）・(b) 19・(c) 13・(d) 手描き 130（108 板）／写し 13・効く範囲 80 ファイル／51 機能／Pen 132 板

<a id="status-badge"></a>
## status-badge 状態の札

- **役目**：丸い札・12/600・左に6pxの丸・5色。言葉は状態の表から
- **持ち主（コード）**：`apps/web/src/components/shared/status-badge.tsx`・`apps/web/src/components/shared/status-badge.module.css`（部品 `StatusBadge`）
  - 読む変数：`--radius-pill`・`--color-success`・`--color-danger`・`--color-warning`・`--color-info`
- **持ち主（Pen）**：`mpVfY`「状態の札/送信済み・対応済み」・`ekmYd`「状態の札/予約中・案内」・`ii85L`「状態の札/対応中・注意」・`XwfSH`「状態の札/未対応・失敗」・`hQeAo`「状態の札/下書き・停止」
  - 注：状態の言葉の表は未実装（B-158 の 1）
- **見つけ方（コード）**：
  - own-badge：`\b(function|const)\s+\w*(StatusBadge|StatusPill|StatePill|StateBadge|Pill|Badge)\b\s*[=(]` — 状態の札を自作
  - old-pill：`<(StatusPill|StatusChip)\b` — 別の札の部品
  - words：`(?:>|['"'])[^<'"']{0,40}(?:稼働中|一時停止|保管|アーカイブ済み|予約済み|送信完了)` — 使わない状態の言葉（B-158 の 1）
  - (b) の割り当て：画面の CSS の上書きの selector が `badge|pill|status|\[data-tone` に当たればこの型
  - (c) の割り当て：直書きの selector が `badge|pill|status|state(Tag|Label)?\b` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - hand-badge：名前 `^札 (有効|公開中|下書き|停止中|予約中|送信済み|失敗|注意)` — 状態の札の手描き（「状態の札/…」の部品でない）
- **決まり**：[§6.5-4](v8-design-rules.md)・[§6.12-1](v8-design-rules.md)・B-152・B-158・B-160
- **見張り**：`apps/web/src/components/shared/status-chip.test.tsx`／**要る試験**：StatusBadge を自作・別の札で状態を出すと落ちる試験
- **10-09 の数**：(a) 436（v8 268）・(b) 81・(c) 54・(d) 手描き 306（65 板）／写し 10・効く範囲 125 ファイル／56 機能／Pen 178 板

<a id="list-state"></a>
## list-state 空・読めない・読み込み中

- **役目**：空・絞り込みで0件・読めなかった（もう一度読み込む）・骨組みを1つの形で出す
- ホームの待機は `AppShell` の `PagePendingLayout` が認証前からダッシュボードの型を渡す。役割・店舗・スタイルを待つ間も同じ見出しを保ち、判定が済むまで子画面は始めない。 既知の入口の題は `lib/route-pending.ts` を外枠と入口で共有し、任意の `title` を待機へ渡す。取得前の名前は言い切らない。
- **持ち主（コード）**：`apps/web/src/components/templates/page-pending.tsx`・`apps/web/src/components/shared/list-state.tsx`・`apps/web/src/components/shared/list-state.module.css`・`apps/web/src/components/shared/skeleton.tsx`・`apps/web/src/components/shared/skeleton.module.css`・`apps/web/src/components/shared/empty-list.tsx`・`apps/web/src/components/shared/retry-label.tsx`（部品 `PagePending`・`ListState`・`TableSkeleton`・`CardsSkeleton`・`Skeleton`・`DelayedSkeleton`・`EmptyList`）
  - 読む変数：`--radius-mini`
- **持ち主（Pen）**：`hNXm7`「空の表示」・`jr5Nl`「骨格の行」・`Dr8Wr`「状態/検索結果0件」・`deztM`「状態/取得失敗」・`q0z77i`「状態/読み込み中」
  - 部品の板の html に書き出されていない ID：`Dr8Wr`・`deztM`・`q0z77i`（文書の記録 `~/lh-work/design/v8/review/PEN-UPDATE-1009.md`・`COMPONENT-MAP.md` にある。(d) の写しの比べはできない）
- **見つけ方（コード）**：
  - state-card：`styles\.(stateCard|emptyState|empty|loading|errorState)\b` — 空・読めない表示を CSS で手書き
  - own-state：`\b(function|const)\s+(StateCard|PageState|EmptyState|LoadingState|ErrorState)\b` — 状態の部品を自作
  - retry-words：`(?:>|['"'])[^<'"']{0,40}(?:再読み込み|再試行|もう一度試す|リトライ)` — 押し口の言葉が「もう一度読み込む」でない
  - spinner：`animate-spin|<Spinner\b` — 回る印（保存中のボタンの中だけ）
  - account-words：`(?:>|['"'])[^<'"']{0,40}(?:アカウントを選択してください|アカウントを選んでください)` — アカウント未選択の言葉（「LINE公式アカウントを選んでください」）
  - (b) の割り当て：画面の CSS の上書きの selector が `empty|skeleton|state` に当たればこの型
  - (c) の割り当て：直書きの selector が `empty|stateCard|loading|skeleton|placeholder|error(State|Card)` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - hand-empty：名前 `^(空|空の表示（まだ1件も無い）|まだ無い)$` — 空の表示の手描き
- **決まり**：[§6.5-8](v8-design-rules.md)・[§6.6-8](v8-design-rules.md)・[§6.11-11](v8-design-rules.md)・[§6.12-18](v8-design-rules.md)・B-143・B-157
- **見張り**：`apps/web/src/components/shared/list-state-contract.test.tsx`・`apps/web/src/components/shared/list-state-retry-contract.test.tsx`・`apps/web/src/components/shared/skeleton-contract.test.tsx`
- **10-09 の数**：(a) 816（v8 475）・(b) 13・(c) 17・(d) 手描き 31（27 板）／写し 0・効く範囲 430 ファイル／115 機能／Pen 1 板

<a id="viewer-band"></a>
## viewer-band 閲覧のみの帯

- **役目**：閲覧のみの人に「閲覧のみで見ています。…」の帯を出す（型に readOnly）
- **持ち主（コード）**：`apps/web/src/components/shared/read-only-notice.tsx`・`read-only-notice.module.css`（部品 `ReadOnlyNotice`）
- **持ち主（Pen）**：**未定**（部品IDは司令塔の確定待ち）
- **見つけ方（コード）**：
  - own-band：`\b(ViewerBand|ReadOnlyBand|viewerBand|roBand|readonlyBand|readOnlyBand)\b` と `styles.readOnly` / `styles.readonly` / 同名の見た目CSS — 閲覧のみの帯を画面ごとに作る
  - words：`閲覧のみで(見て|ご覧)` — 閲覧のみの文を画面で書く
  - (c) の割り当て：直書きの selector が `viewer|readOnly|readonly|roBand` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - other-words：文字 `閲覧のみ`・文字が `^閲覧のみで見ています。変える操作は(オーナーか管理者|統括の管理者)に頼んでください。$|^閲覧のみ$` でない — 閲覧のみの帯の文が決まりと違う
- **決まり**：[§2](v8-design-rules.md)・[§6.6-7](v8-design-rules.md)・[§6.8](v8-design-rules.md)・B-146・B-159
- **見張り**：`apps/web/src/v8/viewer-hides-actions.test.ts`／**要る試験**：共通部品を作ったら：閲覧のみの文を画面で書くと落ちる試験
- **10-09 の数**：(a) 248（v8 239）・(b) 0・(c) 10・(d) 手描き 8（7 板）／写し 0・効く範囲 0 ファイル／0 機能／Pen 0 板

<a id="notice"></a>
## notice 知らせ（トースト・Notice）

- **役目**：保存できた＝トースト1つ。失敗は欄の赤か帯。種類は info・success・warn・danger
- **帯をまとめる配置**：`NoticeStack`（`notice.tsx`）が複数のNoticeと閲覧のみの帯を12px間隔に並べる。帯自身の外側の余白と段間を二重に足さない。通常のNotice単体は変えない。
- **持ち主（コード）**：`apps/web/src/components/shared/toast.tsx`・`apps/web/src/components/shared/toast.module.css`・`apps/web/src/components/shared/notice.tsx`・`apps/web/src/components/shared/notice.module.css`（部品 `Notice`・`notifyToast`・`Toast`）
- **持ち主（Pen）**：`Q6cQB`「知らせ/うまくいった」・`tnWX9`「知らせ/できなかった」・`ThDed`「帯/案内」
- **見つけ方（コード）**：
  - tone-error：`tone=["']error["']` — tone="error"（danger にする）
  - undo：`(?:>|['"'])[^<'"']{0,40}(?:元に戻す)` — 知らせの「元に戻す」（B-160 の 1）
  - alert：`(?<![\w.])alert\(` — ブラウザの alert
  - note-bar：`<NoteBar\b` — 別の帯の部品
  - (b) の割り当て：画面の CSS の上書きの selector が `notice|toast` に当たればこの型
  - (c) の割り当て：直書きの selector が `notice|toast|banner|alertBox|message(Box|Bar)` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - hand-toast：名前 `^知らせ$` — 知らせの手描き（部品の知らせでない）
- **決まり**：[§6.11-6](v8-design-rules.md)・[§6.12-20](v8-design-rules.md)・[§6.15-1](v8-design-rules.md)・B-157・B-158・B-160
- **見張り**：`apps/web/src/components/shared/toast.test.tsx`・`apps/web/src/components/shared/notice-info-contract.test.ts`・`apps/web/src/components/shared/toast-stack.regression.test.tsx`
- **10-09 の数**：(a) 195（v8 62）・(b) 0・(c) 20・(d) 手描き 23（23 板）／写し 0・効く範囲 394 ファイル／112 機能／Pen 23 板

<a id="save-conflict"></a>
## save-conflict ぶつかりの帯

- **役目**：ほかの人が先に保存したとき、入力を残して比べる・最新を読み込む
- **持ち主（コード）**：`apps/web/src/components/shared/save-conflict.tsx`・`apps/web/src/components/shared/save-conflict.module.css`（部品 `useSaveConflict`・`SaveConflictBand`・`SaveConflictCompareDialog`）
- **持ち主（Pen）**：**未定**
  - 注：Pen の部品 ID が無い（見本「ぶつかりの帯」は型の見本 aHrwg の中）
- **見つけ方（コード）**：
  - own-409：`status\s*===?\s*409[\s\S]{0,300}?(conflict|Conflict|競合|revision|Revision|version|更新され|先に保存|ほかの人)`（持ち主の部品を読んでいないファイルだけ） — 保存のぶつかり（409）を画面で扱う
  - old-bar：`<SaveConflictBar\b` — 古いぶつかりの帯
  - words：`(?:>|['"'])[^<'"']{0,40}(?:ほかの人が|他の人が|別の人が|他のユーザー)`（持ち主の部品を読んでいないファイルだけ） — ぶつかりの文を画面で書く
  - (b) の割り当て：画面の CSS の上書きの selector が `conflict` に当たればこの型
  - (c) の割り当て：直書きの selector が `conflict` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - hand-conflict：文字 `ほかの人が先に|他の人が` — ぶつかりの帯の手描き
- **決まり**：[§6.11-9](v8-design-rules.md)・B-157
- **見張り**：`apps/web/src/components/shared/save-conflict-wiring-contract.test.ts`・`apps/web/src/components/shared/save-conflict.react.test.tsx`
- **10-09 の数**：(a) 223（v8 131）・(b) 2・(c) 8・(d) 手描き 0（0 板）／写し 0・効く範囲 12 ファイル／11 機能／Pen 0 板

<a id="customer-info"></a>
## customer-info 顧客情報の欄

- **役目**：受信箱の右の欄と友だちの詳細の概要の左を同じ部品で（段ごとの見出し＋編集・決まった8つの欄・タグ・マイル…）
- **持ち主（コード）**：`apps/web/src/components/shared/customer-info-panel.tsx`・`customer-info-panel.module.css`（`CustomerInfoPanel`・`CustomerInfoRail`・左右のスクロール余白をそろえる `CustomerInfoViewport`）。マイルの数・記録・再試行は`customer-info-mileage.tsx`・同CSS。固定値は `fixed-friend-field-values.ts`、アレルギーの編集は `allergy-field.tsx`、表示項目は `display-items-dialog.tsx`。
- **持ち主（Pen）**：`GBTyR`「顧客情報の欄（B-167）」
  - 2026-10-11確認：両画面の入口は別でも欄の持ち主は CustomerInfoPanel。取得・保存・権限は呼び出す側が渡す。
  - 部品の板の html に書き出されていない ID：`GBTyR`（文書の記録 `~/lh-work/design/v8/review/PEN-UPDATE-1009.md`・`COMPONENT-MAP.md` にある。(d) の写しの比べはできない）
- **見つけ方（コード）**：
  - two-panels：`\b(CustomerPanel|FriendInfoSidebar|OverviewTab|customerPanel|friendInfo)\b` — 顧客情報の欄を画面ごとに作る
  - words：`(?:>|['"'])[^<'"']{0,40}(?:顧客情報をすべて表示|表示項目)` — 顧客情報の欄の組み立て
  - (c) の割り当て：直書きの selector が `customer|friendInfo|profile(Panel|Card)` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - hand-customer：名前 `顧客(情報|カルテ)|右の列|概要の左`・名前が `B-167` でない — 顧客情報の欄の手描き（GBTyR でない）
- **決まり**：B-167・B-166（7つは B-235 で置き換え）・[§6.33](v8-design-rules.md)・[§6.40](v8-design-rules.md)・B-212・B-219・B-234・B-235・B-238
- **見張り**：`apps/web/src/components/shared/customer-info-panel.test.tsx`。顔32・見出し72・出どころの印・タグ2つ＋+N・［表示項目を編集］を共通で出す。列と固定8つの動作は下の [display-items](#display-items) も読む。
- **10-09 の数**：(a) 20（v8 9）・(b) 0・(c) 0・(d) 手描き 20（15 板）／写し 0・効く範囲 0 ファイル／0 機能／Pen 0 板

<a id="phone-preview"></a>
## phone-preview スマホのプレビュー

- **役目**：LINE のトークは LinePreview 1つ。LIFF の画面は LIFF のスマホ枠1つ
- **持ち主（コード）**：`apps/web/src/components/shared/line-preview.tsx`・`apps/web/src/components/shared/line-preview.module.css`（部品 `LinePreview`・`LinePreviewMessage`・`LinePreviewCard`）
- クーポンの中身と状態の見本は `shared/coupon-preview.tsx`。外枠は LinePreview、値は shared の couponPresentation、使用済み・期限切れでは写真とコードを描かない。
- **持ち主（Pen）**：`cfVyj`「LINEの見え方/スマホ」
  - 注：LIFF のスマホ枠は未実装（B-158 の 10）
- **見つけ方（コード）**：
  - own-phone：`\b(function|const)\s+\w*(Phone|PhoneFrame|PhonePreview|Preview|MockPhone|Talk)\b\s*[=(]` — スマホの見本を自作
  - phone-frame：CSS の規則に `border-radius:\s*(3\d|4\d|5\d)px` があり — スマホの外枠を CSS で描く
  - (b) の割り当て：画面の CSS の上書きの selector が `phone|preview|bubble` に当たればこの型
  - (c) の割り当て：直書きの selector が `phone|preview|bubble|talk` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - hand-phone：名前 `^スマホ( |$)` — スマホの手描き（部品 cfVyj でない）
- **決まり**：[§6.12-10](v8-design-rules.md)・B-158
- **見張り**：`apps/web/src/components/shared/line-preview.test.tsx`・`apps/web/src/components/shared/line-preview-bubble.test.ts`／**要る試験**：トークの見本を LinePreview の外で描くと落ちる試験
- **10-09 の数**：(a) 76（v8 37）・(b) 3・(c) 88・(d) 手描き 29（8 板）／写し 0・効く範囲 58 ファイル／31 機能／Pen 2 板

<a id="period"></a>
## period 期間の選択

- **役目**：「過去7日／過去30日／過去90日／期間を指定」の1つの部品
- **持ち主（コード）**：**未実装**
- **持ち主（Pen）**：**未定**
  - 注：未実装（B-158 の 5：部品を作る）
- **見つけ方（コード）**：
  - days-list：`\[\s*['"]?(7|28|30)['"]?\s*,\s*['"]?(28|30|90)['"]?\s*(,|\])` — 画面ごとの期間の並び
  - words：`(?:>|['"'])[^<'"']{0,40}(?:直近\s*\d+\s*日|この\s*\d+\s*日|過去\s*28\s*日|28日間)` — 期間の言葉が決まりと違う
  - (c) の割り当て：直書きの selector が `range|period|days` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - other-period：文字 `直近\s*\d+日|この\d+日|28日` — 期間の言葉が決まりと違う
- **決まり**：[§6.12-5](v8-design-rules.md)・[§6.15-7](v8-design-rules.md)・B-158・B-160
- **見張り**：なし／**要る試験**：部品を作ったら：期間を画面で並べると落ちる試験
- **10-09 の数**：(a) 166（v8 95）・(b) 0・(c) 3・(d) 手描き 73（46 板）／写し 0・効く範囲 0 ファイル／0 機能／Pen 0 板

<a id="chart"></a>
## chart グラフ

- **役目**：棒・線・漏斗を共通部品で。色・吹き出し・軸は部品が持つ
- **持ち主（コード）**：`apps/web/src/components/shared/bar-chart.tsx`・`apps/web/src/components/shared/bar-chart.module.css`（部品 `BarChart`・`BarChartEmpty`）
- **持ち主（Pen）**：**未定**
  - 注：線・漏斗は未実装。Pen の部品 ID が無い
- **見つけ方（コード）**：
  - own-chart：`\b(function|const)\s+\w*(Chart|Graph|Funnel|Sparkline|Bars)\b\s*[=(]` — グラフを自作
  - svg-line：`<(polyline|path)\b[^>]*\b(points|d)=\{` — SVG で線を手描き
  - (b) の割り当て：画面の CSS の上書きの selector が `chart|graph` に当たればこの型
  - (c) の割り当て：直書きの selector が `chart|graph|bar\b|bars\b|funnel|spark` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - hand-chart：名前 `グラフ|棒$` — グラフの手描き
- **決まり**：[§6.12-11](v8-design-rules.md)・B-158
- **見張り**：`apps/web/src/components/shared/bar-chart.test.tsx`
- **10-09 の数**：(a) 16（v8 7）・(b) 0・(c) 22・(d) 手描き 108（31 板）／写し 0・効く範囲 2 ファイル／1 機能／Pen 0 板

<a id="external-link"></a>
## external-link 外へのリンク

- **役目**：新しいタブ・↗ の印・rel="noreferrer" を部品が付ける
- **持ち主（コード）**：`apps/web/src/components/shared/text-link.tsx`・`apps/web/src/components/shared/button.tsx`（部品 `TextLink`）
- **持ち主（Pen）**：`g5Db8`「リンク」
  - 注：external は未実装（TextLink・Button に足す）
- **見つけ方（コード）**：
  - blank：`target=["']_blank["']` — 新しいタブを画面で指定
  - open：`window\.open\(` — window.open
  - (c) の割り当て：直書きの selector が `link|external` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - no-arrow：文字 `(を開く|サイトへ|ページへ)$`・文字が `↗` でない — 外へ出る文に ↗ が無い
- **決まり**：[§6.12-12](v8-design-rules.md)・B-158
- **見張り**：なし／**要る試験**：external を作ったら：target="_blank" を画面で書くと落ちる試験
- **10-09 の数**：(a) 85（v8 47）・(b) 0・(c) 48・(d) 手描き 57（46 板）／写し 0・効く範囲 4 ファイル／1 機能／Pen 13 板

<a id="csv"></a>
## csv CSV

- **役目**：「CSVで書き出す」・ファイル名「機能名_YYYY-MM-DD.csv」（日本時間）を共通の関数で
- **持ち主（コード）**：**未実装**
- **持ち主（Pen）**：**未定**
  - 注：未実装（共通の関数を作る）
- **見つけ方（コード）**：
  - blob：`text\/csv` — CSV を画面で組む
  - name-utc：`toISOString\(\)\.slice\(0,\s*10\)[^\n]{0,60}\.csv|\.csv[^\n]{0,60}toISOString` — ファイル名の日付が世界時
  - words：`(?:>|['"'])[^<'"']{0,40}(?:CSV ?出力|CSVダウンロード|CSVをダウンロード|CSV で書き出す|CSVエクスポート|エクスポート)` — ボタンの言葉が「CSVで書き出す」でない
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - space-words：名前 `^CSV で書き出す$` — 「CSV で書き出す」（空きあり。決まりは「CSVで書き出す」）
- **決まり**：[§6.12-7](v8-design-rules.md)・B-158
- **見張り**：なし／**要る試験**：関数を作ったら：text/csv を画面で書くと落ちる試験
- **10-09 の数**：(a) 158（v8 93）・(b) 0・(c) 0・(d) 手描き 80（80 板）／写し 0・効く範囲 0 ファイル／0 機能／Pen 0 板

<a id="primary-button"></a>
## primary-button 主ボタン・ボタン

- アカウントの［入る・詳細・設定・戻す］は `shared/button.tsx` の `AccountActionButton`。文字と印を対応表で決め、詳細には印を付けない。要対応の数は `shared/attention-count.tsx` の `AttentionCount`。通常は黒、急ぐ数だけ赤の札、0件は灰の「—」にする。

- 設定行の操作は `Button` の `presentation="row-action"`（白地・欄と同じ細枠）。注意行は `textTone="accent"` で緑の枠と文字。札と操作の並びは `RowStatusActions` が中央と操作幅をそろえる。通常の副操作は灰色を保つ（2026-10-23オーナー）。

- **役目**：主＝文字の幅・高さ36・濃い緑の縁＋カードの影・角丸8。言葉は「〇〇を作る」「〜する」
- **持ち主（コード）**：`apps/web/src/components/shared/button.tsx`・`apps/web/src/components/shared/button.module.css`・`apps/web/src/components/shared/icon-button.tsx`・`apps/web/src/components/shared/icon-button.module.css`（部品 `Button`・`IconButton`）
  - 読む変数：`--card-shadow`・`--radius-control`
- **持ち主（Pen）**：`doYdE`「ボタン/主」・`u101P`「ボタン/副」・`LrB2L`「ボタン/危険」・`wDPmk`「ボタン/文字」・`KspUx`「アイコンボタン」
  - 注：主ボタンの縁 #06612f・角丸8の変数は未実装（§6.4）
- **見つけ方（コード）**：
  - raw-button：画面の JSX にある `<button>` を拾う。共通部品の実装・文字列の見本・コメントは数えない。
  - green-fill：CSS の規則に `(button|btn|primary|cta|create|submit|save|action)[^{]*\{` と `background(-color)?:\s*(var\(--color-(primary|accent|brand|action-primary)[\w-]*\)|#087a3e|#06c755)` があり、`hover|:disabled` が無い — 緑の主ボタンを CSS で手書き
  - words：`(?:>|['"'])[^<'"']{0,40}(?:新規作成|作成する|新しく作る|変更を保存(?!する)|コピーする)` — ボタンの言葉が決まりと違う（B-146）
  - (b) の割り当て：画面の CSS の上書きの selector が `\bbutton\b|btn|primary` に当たればこの型
  - (c) の割り当て：直書きの selector が `button|btn|primary|cta|action\b` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - green-hand：名前が `^(ボタン\/主|印|字|丸|点)` でない・style に `background-color: #087a3e` と `height: (32|36|40)px` — 緑の主ボタンの手描き（ボタン/主 でない）
- **決まり**：[§6.4](v8-design-rules.md)・[§6.6](v8-design-rules.md)・B-151・B-146・B-159
- **見張り**：`apps/web/src/components/shared/primary-green-contract.test.ts`・`apps/web/src/components/shared/button-migration-contract.test.ts`・`apps/web/src/components/shared/control-dimensions-contract.test.ts`
- **10-09 の数**：(a) 96（v8 49）・(b) 279・(c) 81・(d) 手描き 464（354 板）／写し 18・効く範囲 698 ファイル／151 機能／Pen 277 板

<a id="date-time"></a>
## date-time 日付・時刻の欄

- **役目**：DateField・TimeField・DateTimeField。高さ36・日本時間
- 待機設定の組み合わせは `apps/web/src/components/automations/wait-fields.tsx` の `WaitFields` が持つ。通常の自動化と共通アクションで同じSelect・TextField・TimeFieldを使い、分数と翌日の時刻を保存する。
- **持ち主（コード）**：`apps/web/src/components/shared/date-field.tsx`・`apps/web/src/components/shared/date-time-field.tsx`・`apps/web/src/components/shared/time-field-v8.tsx`（部品 `DateField`・`DateTimeField`・`TimeField`・`TimeFieldV8`）
- **持ち主（Pen）**：**未定**
  - 注：Pen の部品 ID が対応表に無い（YCOoR は提案の板）
- **見つけ方（コード）**：
  - native：`type=["'](date|time|datetime-local)["']` — 素の日付・時刻の入力
  - utc-today：`new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)` — 「今日」を世界時で作る
  - (b) の割り当て：画面の CSS の上書きの selector が `date|time` に当たればこの型
  - (c) の割り当て：直書きの selector が `date|time|calendar` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：目印なし（写しの比べだけ）
- **決まり**：[§2](v8-design-rules.md)・[§6.11-15](v8-design-rules.md)・B-157
- **見張り**：`apps/web/src/components/shared/date-field.test.tsx`・`apps/web/src/components/shared/time-field-v8.test.tsx`・`apps/web/src/components/shared/date-time-field-width-contract.test.ts`／**要る試験**：type="date|time" を画面で書くと落ちる試験
- **10-09 の数**：(a) 86（v8 43）・(b) 7・(c) 12・(d) 手描き 0（0 板）／写し 0・効く範囲 102 ファイル／48 機能／Pen 0 板

<a id="toggle"></a>
## toggle オン・オフ・選ぶ部品

- 星のような印の選択操作は共通 `IconButton` の `pressed` へ状態を渡し、画面は取得済みの真偽値と操作だけを持つ。新しいトグル形を描かない。従来の直接ARIA指定も受け付ける（L7バナー）。

- **10-12の差し戻し（axFrW）**：一覧の選択は共通Checkboxの16px・角4（`--choice-checkbox-radius`）。画面のCSSで丸みを上書きせず、クリック・Space・一部選択・権限の動きは維持。絵の16px・角4と司令塔の16:47 JST判定に従う。

- **役目**：設定のオン・オフ＝Toggle、複数選択・同意確認＝Checkbox、3つ以上の択一＝SegmentedControl か RadioCard。保存して反映する設定は、既存の保存操作を保つ。
- **持ち主（コード）**：`apps/web/src/components/shared/toggle.tsx`・`apps/web/src/components/shared/checkbox.tsx`・`apps/web/src/components/shared/segmented.tsx`・`apps/web/src/components/shared/radio-card.tsx`・`apps/web/src/components/shared/radio.tsx`・`apps/web/src/components/shared/check-card.tsx`（部品 `Toggle`・`Checkbox`・`UnavailableSelection`・`SegmentedControl`・`RadioCard`・`RadioCardGroup`・`CheckCard`）
  - 読む変数：`--shadow-controls-toggle`
- **持ち主（Pen）**：`bkjTv`「トグル/オン」・`LxHpj`「トグル/オフ」・`dQCCN`「チェック/オン」・`S9U7v`「チェック/オフ」・`dtJVi`「切り替え（3つ）」・`fNPdg`「選ぶカード/オン」・`r3xz1W`「選ぶカード/オフ」
- **見つけ方（コード）**：
  - pressed：`aria-pressed=` — aria-pressed の自作
  - switch：`role=["'](switch|radio|radiogroup)["']` — オン・オフを手書き
  - raw-check：`type=["'](checkbox|radio)["']` — 素のチェック・ラジオ
  - (b) の割り当て：画面の CSS の上書きの selector が `toggle|switch|segment|checkbox|radio` に当たればこの型
  - (c) の割り当て：直書きの selector が `toggle|switch|segment|checkbox|radio` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：目印なし（写しの比べだけ）
- **決まり**：[§6.12-14](v8-design-rules.md)・B-158
- **見張り**：`apps/web/src/components/shared/checkbox.test.tsx`・`apps/web/src/components/shared/segmented-size.test.tsx`・`apps/web/src/components/shared/radio-card-contract.test.tsx`／**要る試験**：aria-pressed を画面で書くと落ちる試験
- **10-09 の数**：(a) 247（v8 162）・(b) 26・(c) 18・(d) 手描き 0（0 板）／写し 0・効く範囲 265 ファイル／98 機能／Pen 87 板

- **L4 差し戻しH**：一覧のまとめて操作がある場合、全行で選択枠をそろえる。対象外・閲覧のみは `UnavailableSelection` の枠と理由を使い、変更処理を持たせない。まとめて操作が無い一覧に列・機能を足さない。

<a id="copy"></a>
## copy コピー

- **役目**：ボタンの文字が「コピーしました」に1.5秒、失敗は「コピーできませんでした」
- **持ち主（コード）**：`apps/web/src/components/shared/copy-text-button.tsx`・`apps/web/src/components/ui/copy-text-button.tsx`（部品 `CopyTextButton`）
- **持ち主（Pen）**：**未定**
  - 注：Pen の部品 ID が無い
- **見つけ方（コード）**：
  - clipboard：`navigator\.clipboard\.writeText` — コピーを画面で組む
  - (c) の割り当て：直書きの selector が `copy` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：目印なし（写しの比べだけ）
- **決まり**：[§6.11-13](v8-design-rules.md)・B-157
- **見張り**：`apps/web/src/components/shared/copy-feedback.regression.test.tsx`／**要る試験**：navigator.clipboard を画面で書くと落ちる試験
- **10-09 の数**：(a) 47（v8 25）・(b) 0・(c) 0・(d) 手描き 0（0 板）／写し 0・効く範囲 2 ファイル／1 機能／Pen 0 板

<a id="steps"></a>
## steps 手順

- 完了した入力の要約は `Steps.summaries`。変える口は既存の `onSelect` へ渡す。現在・未完の段には要約を出さない。方向の動きは同じ持ち主の `StepContent` と `CreatePage.step` / `CreateStepColumns.step`。入力を作り直さず transform だけを150ms動かし、動きを減らす設定では即時に替える。
  - 手順を進めたら `StepContent.elementRef` の内側にある現在の段の題（h2/h3、`tabIndex={-1}`）へ焦点を移す。題は文字の幅に収め、共通の焦点枠を出す。本文全体へは焦点を当てず、輪を消す指定も足さない。

- **役目**：題のすぐ下・左寄せ・1行。済みの段だけ押して戻れる
- **持ち主（コード）**：`apps/web/src/components/templates/steps.tsx`・`apps/web/src/components/templates/steps.module.css`（部品 `Steps`）
- **持ち主（Pen）**：`NUOgw`「手順」
- **見つけ方（コード）**：
  - old-stepper：`<(Stepper|DialogSteps)\b` — 別の手順の部品
  - own-steps：`styles\.(steps|stepper|wizard|stepList)\b`（持ち主の部品を読んでいないファイルだけ） — 手順を CSS で手書き
  - (b) の割り当て：画面の CSS の上書きの selector が `step` に当たればこの型
  - (c) の割り当て：直書きの selector が `step|stepper|wizard` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - hand-steps：名前 `^作る手順$` — 手順の手描き（部品「手順」でない名前）
- **決まり**：[§2](v8-design-rules.md)・q1xNMz
- **見張り**：`apps/web/src/components/templates/steps.test.tsx`・`apps/web/src/components/shared/stepper-contract.test.ts`
- **10-09 の数**：(a) 34（v8 23）・(b) 9・(c) 77・(d) 手描き 85（85 板）／写し 2・効く範囲 20 ファイル／19 機能／Pen 19 板

<a id="bulk-bar"></a>
## bulk-bar まとめて選ぶ（一括バー）

- **役目**：下から出る白いバー：操作を選ぶ→確かめる→結果。「〇件すべてを選ぶ」
- **持ち主（コード）**：`apps/web/src/components/shared/bulk-bar.tsx`・`apps/web/src/components/shared/bulk-bar.module.css`（部品 `BulkBar`）
  - 読む変数：`--shadow-float`
- **持ち主（Pen）**：`q1tCSK`「一括操作バー」
  - 部品の板の html に書き出されていない ID：`q1tCSK`（文書の記録 `~/lh-work/design/v8/review/PEN-UPDATE-1009.md`・`COMPONENT-MAP.md` にある。(d) の写しの比べはできない）
- **見つけ方（コード）**：
  - own-bulk：`(?:>|['"'])[^<'"']{0,40}(?:件を選択中|件選択中|件を選んでいます|件選択)`（持ち主の部品を読んでいないファイルだけ） — 一括の帯を自作
  - (b) の割り当て：画面の CSS の上書きの selector が `bulk` に当たればこの型
  - (c) の割り当て：直書きの selector が `bulk|selection(Bar)?` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - hand-bulk：名前 `^一括バー$` — 一括バーの手描き
- **決まり**：[§2](v8-design-rules.md)・[§6.11-14](v8-design-rules.md)・B-157
- **見張り**：`apps/web/src/components/shared/bulk-bar.test.tsx`・`apps/web/src/components/shared/bulk-bar-sticky-contract.test.ts`
- **10-09 の数**：(a) 11（v8 7）・(b) 0・(c) 6・(d) 手描き 3（3 板）／写し 0・効く範囲 12 ファイル／9 機能／Pen 0 板

<a id="back-link"></a>
## back-link ページ内の戻る（置かない）

- **役目**：戻るはパンくずと［キャンセル］だけ。「← 〇〇へ」を置かない
- **持ち主（コード）**：`apps/web/src/components/shared/breadcrumb.tsx`・`apps/web/src/components/layout/breadcrumb.tsx`（部品 `Breadcrumb`）
- **持ち主（Pen）**：**未定**
  - 注：置かない型（持ち主はパンくず）。Pen の部品 ID は外側 zUg8S の中
- **見つけ方（コード）**：
  - arrow-back：`['"'>]\s*←\s*[^<'"']{1,24}(へ|に戻る)` — ページ内の「← 〇〇へ」
  - (c) の割り当て：直書きの selector が `back(Link)?\b` に当たればこの型
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：
  - arrow-back：文字 `^←` — ページ内の「← 〇〇へ」
- **決まり**：[§2](v8-design-rules.md)・[§6.8](v8-design-rules.md)・B-143
- **見張り**：なし／**要る試験**：「← 〇〇へ」を画面に書くと落ちる試験
- **10-09 の数**：(a) 53（v8 43）・(b) 0・(c) 6・(d) 手描き 0（0 板）／写し 0・効く範囲 11 ファイル／6 機能／Pen 0 板

<a id="folder-select"></a>
## folder-select 所属フォルダを選ぶ欄

- **役目**：作る・直す画面の「どのフォルダに入れるか」。その場で作れる
- **持ち主（コード）**：`apps/web/src/components/shared/folder-select.tsx`・`apps/web/src/components/shared/folder-select.module.css`（部品 `FolderSelect`）
- **持ち主（Pen）**：`dLffh`「FolderSelect」・`iBuZH`「新しいフォルダを作る」
  - 部品の板の html に書き出されていない ID：`dLffh`・`iBuZH`（文書の記録 `~/lh-work/design/v8/review/PEN-UPDATE-1009.md`・`COMPONENT-MAP.md` にある。(d) の写しの比べはできない）
- **見つけ方（コード）**：
  - select-folder：`<Select\b(?:[^<>]|=>){0,400}?(label|aria-label)=["'][^"']*フォルダ` — フォルダをプルダウンで選ぶ（FolderSelect にする）
  - 除くもの：試験・モック・`app/visual-qa/`・`globals.css`・コメントの行・持ち主のファイル（表の `global.code`）
- **見つけ方（Pen）**：目印なし（写しの比べだけ）
- **決まり**：[§2](v8-design-rules.md)・[§6.13](v8-design-rules.md)・B-127・B-147
- **見張り**：`apps/web/src/components/shared/folder-select.react.test.tsx`・`apps/web/src/components/shared/folder-select-rollout-contract.test.ts`
- **10-09 の数**：(a) 61（v8 45）・(b) 0・(c) 0・(d) 手描き 0（0 板）／写し 0・効く範囲 25 ファイル／18 機能／Pen 0 板


<a id="message-insert-row"></a>
## message-insert-row 本文の差し込みの行（2026-10-11追加）

- **役目**：本文枠の内側の下端で、差し込む項目と文字数を同じ形で見せる。
- **持ち主（コード）**：`apps/web/src/components/shared/message-insert-row.tsx`・`message-insert-row.module.css`（`MessageBody`・`MessageInsertRow`・`MessageInsertButton`）。本文中の札は `insert-text-field.tsx`・`insert-tokens.ts`、統括の種類の受け渡しは `hq-message-inserts.tsx`。
- **閲覧のみ（2026-10-12 F3）**：MessageInsertRow.readOnly は差し込む操作と案内を置かず、文字数だけを同じ共通の行で表示する。既定の編集用の行は変えない。
- **入力の大きさ（2026-10-12 F3）**：`InsertTextField.editorSize=message|code`。本文88／コード264の既存の高さと、共通の内側10/12を部品が持つ。保存する文字・札・カーソルの口と、既定／compactは変えない。
- **持ち主（Pen）**：リマインダの採用形（B-221）。共通の部品IDは司令塔の確定待ち。V6xAo・U5rxyH・Bb8xi・pIHp3 等は画面の板のIDで、部品IDと混同しない。
- **決まり**：[§6.34](v8-design-rules.md)・B-221・B-238。「差し込む」11px＋印付き文字ボタン＋右端の文字数。狭い時はその他にまとめ文字数は枠下。統括の項目は店名／電話／予約ページ／名前＋固定8つ。
- **見つけ方**：枠外の「＋ 名前」の札・「差し込み：」・古い編集部品・同じ役目の自前行を探す。本文中の札と保存する {{…}} は違反ではない。
- **見張り**：`message-insert-row.test.tsx`・`hq-message-inserts.test.tsx`・`insert-text-field.test.tsx`、V8の崩れ検査。機械の対応表への新型登録は次の道具更新で行う。

<a id="choice-card"></a>
## choice-card 選ぶカード（2026-10-11追加）

- **役目**：カード全体を押して1つを選び、右上のラジオでも選択状態を示す。
- **持ち主（コード）**：`apps/web/src/components/shared/radio-card.tsx`・`radio-card.module.css`（`RadioCard`・`RadioCardGroup`）。複数は共通 Checkbox。デザインの型は `customer-design-picker.tsx` が同じカードを使う。
- **持ち主（Pen）**：B-203案A・B-229。共通の部品IDは司令塔の確定待ち。
- **決まり**：[§6.30](v8-design-rules.md)。選択＝緑2px枠・薄い緑地・右上16のラジオ、未選択＝灰1px枠・白地。LIFFの素のラジオと見本は18＋点9（B-223）。ブロック追加と卓の表はこの型ではない。
- **見つけ方**：ラジオ無しの選ぶ箱・青枠・灰枠の選択・説明へ重なる丸・カード型の上書きを探す。
- **見張り**：`radio-card-contract.test.tsx`・`apps/web/scripts/v8-guard/pendec2-rules.test.mjs`（選ぶ箱の右上ラジオ）。機械の表では既存 toggle の対象だが、この文書では選ぶカードの役目を分けて示す。

<a id="display-items"></a>
## display-items 顧客情報と友だち一覧の表示項目（2026-10-11追加）

- **役目**：決まった8つと、お店が実際に作った情報欄を選び、出す・隠す・並べ替える。
- **持ち主（コード）**：`apps/web/src/components/shared/display-items-dialog.tsx`・`display-items-dialog.module.css`（共通の窓）、`fixed-friend-field-values.ts`（決まった値）、`allergy-field.tsx`。受信箱と概要は CustomerInfoPanel、友だち一覧は `apps/web/src/v8/friends/list/list.tsx`、情報欄タブは `apps/web/src/v8/friend-detail/info-tab.tsx` がデータと保存する設定を渡す。
- **持ち主（Pen）**：CustomerInfoPanelの部品GBTyRとB-234〜B-238の採用板。表示項目の窓の共通部品IDは司令塔の確定待ち。
- **決まり**：[§6.33](v8-design-rules.md)・[§6.40](v8-design-rules.md)。名前以外の列は1440で7・1152で4。お店の情報欄は固定の例ではなく実際の項目数、検索と縦送り・管理へのリンクを出す。列は鍵で保存、新項目を次の開き直しで反映、削除済み項目を列から外す。
- アレルギーは固定8つ目・複数の札・店の選択肢＋自由入力。フォームの「書いてもらう」3行目で、保存先を変えない（B-235・B-238）。
- **見つけ方**：固定7つ・1152で5列・仮の「お店の情報欄」の固定候補・一覧に無制限の列・横送り・アレルギー1行テキストを探す。
- **見張り**：`customer-info-panel.test.tsx`・`display-items-dialog.test.tsx`、V8の列数・はみ出し検査。**要る動作確認**：追加・削除した項目、列上限、並べ替え、値の出どころ、複数アレルギー、店と統括のフォームの継承。文書の掲載だけで実装合格とはしない。

<a id="list-date-time"></a>
## list-date-time 一覧の日時

- **役目**：時刻を持つ記録を今年 `MM/DD HH:mm`、別年 `YYYY/MM/DD HH:mm` で1行に出す。日時の列は文字の実寸を確保し、日付と時刻の間は共通の4pxにそろえる（L5差し戻しU1）。期限・年月日型の業務値・繰返しの曜日はこの役目ではない。
- **持ち主（コード）**：`apps/web/src/lib/format.ts` の `formatListTimestamp`、`apps/web/src/components/shared/list-date-time.tsx`・同 CSS。年・時間帯・無効な値の扱いは日付の正本、段分けは `ListDateTime` が持つ。
- **決まり**：B-260・B-262 差し戻し E。保存値・CSV は変えない。
- **見つけ方・増殖の見張り**：`formatListTimestamp(...).split(...)` を画面で書かず、共通部品へ日時を渡す。
- **見張り**：共通の書式と部品の試験（別年の時刻、SQL UTC、店舗時間帯、無効値）と一覧の実幅測定。Pen の変更は司令塔へ渡す。

- **F4 一覧型の既定**：PageFrame(kind=list)は一覧の標準寸法と検査対象を既定で持つ。画面側の任意のskeleton指定に依存しない。一般の表を持つ作成・詳細の型には適用しない。

## list-status-cell 一覧の状態の列

- **役目**：公開状態と後処理の未完など、同じ記録の状態を名前と分けて表示する。複数の札は縦に並べ、共通4pxを挟む。余分な上下のセル余白を重ねず、行の52/60を守る。
- **持ち主**：`components/shared/table.tsx` の `StatusCell` と `data-table.module.css`。札の正本はStatusBadge。文字の実寸はDataTableの内容による列配分が確保する。
- **見張り**：状態の列と名前の列の動作試験、実物CSSの複数札60px・切れ0・余分padding故障注入。

- **L4 差し戻しI**：操作の「直す／編集」は `shared/action-words.ts` が「編集する」へ統一し、Button（actionWording）・ActionMenu・FolderEditorDialog・KpiCard が読む。任意の値・名前を出すボタンや窓の題はそのまま保つ。「読み直す／作り直す／最新を取り込んで直す」は別の動きのため保つ。KPIの操作は共通 `action` へ渡す（リンク・既存の処理の両方を受ける）。

- **L4 差し戻しJ**：数の帯に行メニューを置かず、絞り込みと行き先は `KpiCard.action`／`valueAction` へ。別の行き先の入口は残す。行の登録は共通 `Button` の `size="compact"` を使い、表の52/60を変更しない。CIの `pendec2-rules` が帯の中の行メニューを検出する（故障注入あり）。

## 認証の画面（B-263）

- 持ち主：`components/templates/auth-page.tsx`。ログインの確認・初回登録を同じ型で組む。
- 補足は `AuthHelp`（共通の小さい文字）、設定の見出しと値は `AuthDetailRow`（薄い見出しと太い値）。操作は共通の本文リンク、印はログインと同じ緑地・白文字を使う。
- 形と値：BOj1aと修正案A〜E（2FA-PEN-1012）を使う。欄・トグル・確認は共通部品。幅いっぱいの主ボタンは `Button.fullWidth` で中央文字（B-264）。
- 見張り：`v8-pattern-audit.mjs` と二段階認証の操作試験。

## 受信箱の列・入力・補助面（inbox-frame）

- **役目**：受信箱の3列、会話の媒体、返信入力、保存した検索と内部メモの補助面。
- 絞り込みと並びの操作は `InboxFilterSlot`・`InboxSortSlot` に入れ、`InboxFilterControls` の中で内容幅を保つ。未読名は `InboxListName`。`InboxFilterPanel` の `value.quickFilter` は一覧と同じ期限条件、`slaEnabled` は期限超過／1時間以上待ちの区別、`auxiliaryActions` は対応ルール等の操作、`unassignedUnreadCount` は未割り当ての集計値（未取得はnull、0件は0）を受ける。取得・保存・URL更新は画面が持つ。
- **持ち主（コード）**：`components/templates/inbox-page.tsx`、`components/shared/inbox-conversation-head.tsx`・同CSSと`inbox-head-menus.tsx`（会話の頭・担当・対応・検索・顧客欄の開閉）、`components/shared/inbox-thread.tsx`・同CSS（日付・吹き出し・時刻・送り手・引用、送信状態と `InboxThreadLoading` の骨組み）、`components/shared/inbox-list.tsx`・同CSS（題・札・探す欄・担当と経路、`InboxListRow` の選択表示）、`components/shared/inbox-composer.tsx`・同CSS、`components/shared/inbox-content.tsx`・同CSS。欄の保存・送信・開閉は画面が渡す。
- **持ち主（Pen）**：受信箱 eovoG。媒体と補助面の従来寸法は共通トークンへ移し、画面から上書きしない。
- **確認**：送信・引用・添付・予約・遅延応答・入力時の確認を既存試験で守る。見た目の候補は測定と左右画像の確認後だけ記録する。

### 下の帯の左端の操作（F組4回目・Q）
- 持ち主：`components/shared/sticky-bar-action.tsx` の `StickyBarAction`（`sticky-bar.tsx` からも公開）。確認窓を開く副ボタン・印・禁止時の理由を同じ口で出す。帯自身は配置だけを持ち、実際の削除・保管の処理と確認窓は呼び出す画面が保つ。危険な削除入口は `destructive` を渡し、共通 `Button` の `danger-outline`（白地・枠・赤い文字と印）で表示する。確認窓の確定操作は `danger`（赤い地）のままにする。

- 作成段の任意の題は `CardHeader` の `optional`。窓の題の横は既存の `Dialog.titleHelp` に共通 `OptionalBadge` を渡す。括弧付きの題を画面ごとに描かない。

- 名前とフォルダの2列は `SettingsFormRow layout="name-folder"`。名前2・フォルダ1の比率で行の幅を埋め、間は共通12。フォルダは既存 `FolderSelect size="full"`。文字数・再試行・社内メモは各入力の共通部品へ渡す。

- 固定の保存項目しか持たない行うことは `FixedActionList` から既存 `ActionList` へ渡す。種類は保存できる物だけ、順序は固定。対象の選択を確定するまで行を作らず、保存形式は画面の既存の口へ戻す。

- 条件を足す種類も `ConditionBuilder` の `EntityPickerDialog` で選ぶ。種類の制限・AND/ORの保存形を保ち、取消では条件を追加しない。条件のかたまりの箱と頭は共通 `Card` / `CardHeader`。
<a id="b244"></a>
## B-244 必須・任意、行の組、狭い板の道具

- **持ち主**：`shared/form-controls`のField・RequiredBadge、`lib/form-requirement`と`use-form-errors`の検査定義。行の組は`shared/action-menu`（RowMenuも同じ順を使う）、道具は`shared/list-toolbar`とListPageBodyが渡す先頭の口。
- **決まり**：§6.43・B-244。必須と検査を共有、欄下の理由と読み上げ、見る→整理→停止・削除と線・5項目から見出し、狭い白い板の2段と右端の件数。
- **見張り**：`b244-behavior.test.tsx`、`action-menu-v7-contract.test.tsx`（V8へ更新）、`list-toolbar-contract.test.tsx`、`apps/web/scripts/v8-guard/rules-browser.mjs`。既存の頭・道具・表の値はmatch2が持ち、新しい口だけを追加する。

<a id="screen-explanation"></a>
## screen-explanation この画面の説明（B-245）

- **持ち主**：`shared/screen-explanation.tsx`・CSS、型のPageHeading（一覧・作る・詳細・設定・分析から共通に使う）。画面全体の説明はexplanation、短い言葉の説明はhelp、必要ならexplanationKeyを渡す。
- **形と動き**：題の横に青い文字と矢印、下に灰色・角8・12pxの文。初回は開き、担当者IDと画面・タブごとに開閉を保存。今だけの知らせと危ない操作の確認は残す。
- **Pen**：B-245採用見本pkrzG。部品IDと合格の記録は司令塔。
- **見張り**：`b244-behavior.test.tsx`、`page-heading-rules.test.tsx`、verify:design。

<a id="save-feedback"></a>
## save-feedback 保存の4つの状態（B-246 D1）

- **持ち主**：`shared/save-feedback.tsx`。useSaveFeedbackが二重開始と状態、SaveFeedbackが結果とやり直しの口を持つ。画面は工程の完了記録と最新の版を持ち、入力を残して残りだけ送る。
- **見張り**：共通動作試験、予約ルールのpartial-save、イベントcreate-recovery、マイルreward-partial-save。成功分のAPIを再送しないことを実行回数と版で確かめる。
- **Pen**：B-246採用見本y45k2。今回の対象はD1。

<a id="friend-filter-band"></a>
## friend-filter-band お客さまで絞った一覧の帯（B-247 E1）

- **持ち主**：`shared/friend-filter-band.tsx`・CSS。顔・絞り込み対象・全員を見る・右端の友だち詳細へ戻る。名前は表示だけ、URLはIDだけ。
- **適用**：取得済みの登録IDで全ページから絞るリマインダ。APIの無い一覧は機能待ち表へ。API・DBは作らない。
- **見張り**：共通動作試験と`lib/friend-reminder-list`の全ページ・途中失敗の試験。
- **Pen**：B-247採用見本ggPZt。共通部品IDは司令塔。

<a id="aggregation-status"></a>
## aggregation-status 集計の状態（B-247 E2）

- **持ち主**：`shared/aggregation-status.tsx`。未集計・集計中・失敗・完成、開始時刻・データの時点と再試行。ファネル・クロス分析・成果レポートは状態と実行の口だけを渡す。
- **見張り**：共通動作試験、分析の404と同時開始の試験。データの時点が無い応答は未取得と表示し、時刻を捏造しない。
- **Pen**：B-247採用見本ggPZt。共通部品IDと合格の記録は司令塔。

受信箱の取得カーソルによる続きの操作は `shared/inbox-list` の `InboxHistoryButton` が形を持つ。会話・メール・古い本文の取得処理は画面に残し、ページ数が返らない履歴に全ページ数を作らない。画面から色・文字・影を上書きしない。

- 行うことの種類データは `ActionList.choices` / `FixedActionList.options` へ渡す。型監査は、実在する持ち主へのimportとJSXのデータの口を確かめ、同じ語を自前のボタンへ描いた場合は引き続き検出する。
- 作成・編集の横並びの入力は `SettingsFormRow`。2列以上の格子も同じ部品が持ち、白い板が1100未満なら1列へ戻す。名前＋フォルダは既存の `name-folder`、4欄以上の2列は `columns`、3欄の期間は列数3の口で広い時の並びを保つ。日時1欄の内部の時・分や、ラジオの選択肢の並びは独立した入力欄の格子と区別する。

- **B-266 道具の2段**：ListToolbarFrameは狭い白い板で先頭と検索を同じ段へ、残りを次の段へそろえる。左列の作るボタンの全幅指定は先頭の口へ持ち込まない。ListToolbarOptional(collapse=overflow)は入りきらない組だけを操作名つきの入口に畳み、元の操作と入力は保持する。文字だけを小さくしたり無名の「…」へ消したりしない。
### 下の帯の左端の操作（F組4回目・Q）
- 持ち主：`components/shared/sticky-bar-action.tsx` の `StickyBarAction`（`sticky-bar.tsx` からも公開）。確認窓を開く副ボタン・印・禁止時の理由を同じ口で出す。帯自身は配置だけを持ち、実際の削除・保管の処理と確認窓は呼び出す画面が保つ。危険な削除入口は `destructive` を渡し、共通 `Button` の `danger-outline`（白地・枠・赤い文字と印）で表示する。確認窓の確定操作は `danger`（赤い地）のままにする。

- 作成段の任意の題は `CardHeader` の `optional`。窓の題の横は既存の `Dialog.titleHelp` に共通 `OptionalBadge` を渡す。括弧付きの題を画面ごとに描かない。

- 名前とフォルダの2列は `SettingsFormRow layout="name-folder"`。名前2・フォルダ1の比率で行の幅を埋め、間は共通12。フォルダは既存 `FolderSelect size="full"`。文字数・再試行・社内メモは各入力の共通部品へ渡す。

- 独立した入力の2列・3列は `SettingsFormRow layout="columns"` と `columns`。白い板1100未満では共通の行が1列へ畳む。エラーを出すID・焦点のref・入力値はそのまま渡す。郵便番号など一つの入力の内部は別の口として保つ。「押したら」の種類と中身も `TapActionField` が同じ板幅で縦へ並べ、保存する動きは変えない。

- 並べ替えの矢印の禁止理由は `reorderMoveReason` または `useReorder.moveReason`。先頭・末尾・保存中・閲覧などの理由を共通の並びから出し、矢印の共通ボタンの `title` へ渡す。画面の保存順・API・動かせる条件は保つ。

- 固定の保存項目しか持たない行うことは `FixedActionList` から既存 `ActionList` へ渡す。種類は保存できる物だけ、順序は固定。対象の選択を確定するまで行を作らず、保存形式は画面の既存の口へ戻す。

- 条件を足す種類も `ConditionBuilder` の `EntityPickerDialog` で選ぶ。種類の制限・AND/ORの保存形を保ち、取消では条件を追加しない。条件のかたまりの箱と頭は共通 `Card` / `CardHeader`。

## G9：共通表の人の欄（Z1）

- 名前と、既存APIが返す質問数などの補足は `NameCell` の `description` で分ける。名前そのものは1行を保つ。格子の名簿は `GridTable columnSizing="content"` で全行の内容から幅を配り、短い状態・日時の余りを長いメールへ回す。

- 役目：顔と名前を横並び1行で読む。持ち主は shared/table.tsx の PersonCell、顔は shared/avatar.tsx。名前と既存の行き先を name、表示名を avatarName へ渡す。幅が狭い時は名前だけ省略し全文を title で読む。フォルダ付きの NameCell とは役目を分ける。
- 件数は shared/pagination.tsx の range（total/first/last）へ。手書きの件数文を足さない。

### 日別グラフの基準線と出来事

- 持ち主は`shared/bar-chart.tsx`・CSS。`distribution="diverging"`で同じ人数の単位を基準線の上（増加）と下（減少）へ。指定のない形は保つ。
- `BarChartLegend`の`layout="analytics"`とtoneの`broadcast`/`scenario`、`BarChartEventMark`は出来事の青/紫を共有する。`toBarChartItems`へ渡すcampaignsのkindから日付の印を出す。人数の緑/灰と分け、名前は読み上げに残す。
- 寸法の見張りは`apps/web/scripts/v8-guard/bar-chart-layout-browser.mjs`、数と日選択の描画は`shared/bar-chart.test.tsx`。画面接続前の部品検査を板の合格へ数えない。

<a id="verification-list"></a>
## verification-list 接続のチェックの行

- 役目：入力した接続情報の検査結果。一般の表ではなく、検査の印・題・説明・状態を並べる。
- 持ち主：`shared/verification-list.tsx` の `VerificationList`。箱は共通Card、状態はStatusBadge、行は文字と上下12の自然高。
- 失敗の説明は全文を折り返して高さを増やす。その他は1行で省略し、titleで全文を残す。使用先：LINEアカウント登録の接続確認（v2KMj）。

## 月の盤・複数画像・固定分類の共通口（2026-10-16）

- 月の盤は `shared/month-calendar.tsx` の `MonthCalendarGrid`。曜日7列・月外・休み・今日・予約数と日付を選ぶ操作を持つ。時間盤の空き枠・凡例・人物名は `shared/calendar-parts.tsx`。
- 複数画像の一覧は `shared/image-multi-select.tsx` の `ImageMultiSelect`、手元の画像の追加は `shared/image-multi-upload.tsx`。選択順・上限・選択解除を共通で扱い、取得・用途・上限の値は呼び出し側が渡す。
- 固定分類は `shared/category-panel.tsx` の `CategoryPanel`。フォルダ管理の追加・変更・削除を持たず、既存の分類を選ぶ。操作と直前の知らせを本文列の下端に置く場合は `StickyBarRegion`。
- 友だち一覧の表は `DataTable cellPresentation="friends"`。チェック・注目・操作の端の余白は共通セルの `columnKind`、ひな形の通常セルは `Td presentation="template-plain"`。
- LIFFの見出し・欄の失敗・切替は `apps/liff/src/components/ui/` の `PageHeading`・`FieldError`・`Button variant="switch"`。監査は実際の読み込み先を照合し、生の手書きと部品の上書きは引き続き止める。

## ログの記録とカレンダーの期間移動

- ログの中身とコピーは `shared/log-entry-details.tsx` の `LogEntryDetails` / `LogEntryCopy`。時刻・相手・結果・表示用の理由だけを渡し、本文・URL・秘密値・生のエラーを渡さない。コピーは既存 `CopyTextButton` の固定幅と失敗時の手動選択を使い、成功の印は1600ms。
- カレンダーの期間移動は `shared/calendar-period.tsx` の `CalendarPeriod`。日付順のキーで方向を決め、transformだけを共通200msで動かす。初回・同期間の再取得・表示方式の切替では動かさず、次の移動で前の動きを中断し、動きを減らす設定では即時表示する。
- 月の日付は `shared/month-calendar` が今日（文字・aria-current）と選択（枠・aria-selected）を分ける。空き枠は既存 `BookingSlot` の表示を保ち、閲覧のみには変更操作を出さない。
- 見張り：`log-entry-details.test.tsx`、`calendar-period.test.tsx`、既存の月表示・予約枠・ログの権限と再実行の試験。

## 予約の状態・種類・現在時刻（2026-10-23）

- 予約の内容は `shared/booking-presentation.tsx` の BookingCardContent（名前と時刻／メニュー、電話だけの札）、担当の受付説明は BookingStaffHeading、休憩は BookingRest を使う。
- 持ち主：`shared/booking-controls.tsx` の BookingBlock、`shared/booking-state.ts` と同CSS、`shared/booking-presentation.tsx`。札・一覧の状態・凡例は同じ面を使う。来店中は濃い緑と白字、確定は白と細線、終了は灰。要対応（承認待ち）は赤の2px点線、期限付きの仮押さえは灰の点線、無断キャンセルは薄赤と赤の2px実線。予約の重なりの要対応は薄赤と赤い点線、注意は薄琥珀。状態は文字でも伝える。
- 種類の色：BookingCategoryとReservationSourceは既存TagPillのTagColorDotを名前の前へ置く。丸は装飾、名前は文字。経路を札の地色へ混ぜない。BookingNowLineは中間の灰の線と、同じ灰に白字の時刻の札。
- 使用先：ReservationBoard（時間×卓・一覧・月）、ReservationPeopleGrid、CalendarTimeEntries、スタイル別StaffBoard。月の日付の今日／選択と空き枠の操作は既存の口を保つ。
- 短い札の高さは `shared/use-calendar-time-scale.ts` が時間軸全体の倍率で確保する。CalendarTimeEntriesは既定のカレンダー軸、StaffBoardは `board` の軸を使い、隣の予約へ札を伸ばさない。
- 見張り：`booking-presentation.test.tsx` と既存の予約の移動・失敗・権限・印刷・日付選択の操作試験。絵との合否は司令塔が判定する。

<a id="style-choice"></a>
## style-choice スタイルを選ぶ画面

- 役目：使い方のスタイルを「見る」切り替えと「選ぶ」ボタンを分け、見本の枠で中身を見せて選ばせる（SPEC-11・SPEC-12 の共通節 S）。
- 持ち主：`apps/web/src/v8/onboarding/style-choice-step.tsx` の `StyleChoiceStep`（下の帯の 1 行は `StyleChoiceStatus`）。切り替えは共通 `SegmentedControl`、枠は共通 `Card`、選んだ印は `StatusBadge`。
- 見本の枠の中は style-experience スタイル体験プレビュー（`StyleExperiencePlayer`・口は S-4）。枠の大きさはプレイヤーが持ち、並べた時は最小版と全部版で同じ高さ、白い板が 1100 未満では縦に積む。
- 使用先：はじめの質問の 1 問目（ダッシュボードの窓）と登録④・登録再開。
- 最初のメニュー選択は `onboarding/initial-menu-choice.tsx` の `InitialMenuChoice` が画像・行き先・できることを持つ。登録・再開・はじめの質問・選び直しで共通。画像内の文字は12px以上、欄が800px以上なら見本と説明を左右に並べる。狭い欄は縦に積む。
- 初期メニューの読みやすさと配置は `scripts/visual-qa/initial-menu-layout.mjs` で実際の表示寸法を見張る。

<a id="style-experience"></a>
## style-experience スタイル体験プレビュー

- 役目：スタイルごとに、お客さまのスマホ・ダッシュボード・予約の盤を同じ段で自動で流し、使い方を見せる（SPEC-12）。中は押せない見本で、読み上げは場面の 1 行だけ。
- 持ち主：`apps/web/src/v8/onboarding/style-experience-player/` の `StyleExperiencePlayer`（台本は `STYLE_EXPERIENCE_SCRIPT`）。切り替えは共通 `SegmentedControl`、手順は型 `Steps`。
- 口（S-4）：`script`・`style`・`onStyleChange`・`switcher`（`external` は上の切り替えとできること 3 行を出さない）・`variant`（最小版＝スマホ＋数の帯、全部版＝3 画面＋手順）・`data`・`record`。
- 自動再生とクロスフェードは決まり §6.15 の 11 の例外で、この部品の中だけ。
- 使用先：スタイルを選ぶ画面の見本の枠（style-choice）。
- 見張り：`player.test.tsx`・`script.test.ts`・実ブラウザの `apps/web/scripts/v8-guard/style-experience-player.test.mjs`。

## CSVのひな形と比較項目の表示

- CSV取り込みのひな形は `shared/csv-template-download.tsx` の `CsvTemplateDownload`。取り込みで使う列定義から見出しだけのUTF-8 CSVを作り、各画面に列名を重複させない。
- 同じ人の比較は `shared/differences-filter.tsx` の `DifferencesFilter`。既定で違う項目を見せ、表示の切り替えで選択・保存対象を変えない。未取得・マスク済みの値は一致と断定せず表示を残す。

## mobile-frame モバイルの外枠（電話の専用の画面 /m）

- **役目**：電話の専用の画面（`/m`）の上の帯・本文・下のタブ。段の題（`MobileSection`）・一覧の上の道具（`MobileListTools`：探す欄と表示の切り替え）・カード 1 列（`MobileCardList`・`MobileCardLink`・`MobileCard`）もこの型が持つ。管理画面を縮めた物ではなく、機能をしぼった別の外枠。
- **持ち主（コード）**：`components/templates/mobile-frame.tsx`・同CSS（形と値）、`components/mobile/mobile-shell.tsx`（ログインの確認・アカウント・代理ログインの帯・セッション切れ・閲覧のみの帯・タブの出し入れ）、`components/mobile/mobile-screen.tsx`（画面 1 枚の題・戻る・返信欄と、権限・店の未選択の表示）。住所の判定とタブの表は `lib/mobile-shell.ts`。
- **決まり**：[§6.48](v8-design-rules.md)。値は外枠の型 `mobile-frame.module.css` の `--phone-*`（外枠の中だけで効く）。画面で高さ・余白・文字の大きさを書かない。タブは作った画面だけを出す。
- **見つけ方（コード）**：own-tab-bar（`BottomTabs`・`TabBar`・`BottomNav` を自作）。
- **見張り**：`templates/mobile-frame.test.tsx`・`lib/mobile-shell.test.ts`、崩れの見張り `apps/web/scripts/v8-guard/layout-overflow.mjs` の電話の段（`MOBILE_ROUTES` × 390・430）。

## mobile-talk-list モバイルの会話の一覧

- **役目**：電話の画面のトークの一覧と、対応の「返事を待っているトーク」を同じカード 1 列で出す。顔・名前・時刻・最後のメッセージ。未読は顔の赤い点と名前の太字（色だけに頼らない）。
- **持ち主（コード）**：`components/templates/mobile-talk-list.tsx`・同CSS。一覧の 1 件の形へ直すのは `v8/inbox-chat/mobile-talk-item.ts`（公開名は `v8/inbox-chat/public/mobile-talk-item`）、最後のメッセージの言葉は PC と同じ `v8/inbox-chat/list-preview.ts`。
- **決まり**：[§6.48](v8-design-rules.md)。取得・並び・押した時の既読は画面が持つ。会話の中の吹き出しは PC と同じ `v8/inbox-chat/message-row.tsx`（`InboxMessageRow`）、送る前の見本は `LinePreview`。新しい吹き出しを作らない。
- **見つけ方（コード）**：own-talk-card（`MobileChatList`・`TalkCard`・`ChatCard` を自作）。
- **見張り**：`templates/mobile-frame.test.tsx`・`v8/inbox-chat/mobile-talk-screen.test.tsx`。

## mobile-booking-card モバイルの予約のカード

- **役目**：電話の画面の「今日」の予約 1 件（時刻・お客さまの名前・人数・卓や担当・状態の札・［来店］などの操作）。
- **持ち主（コード）**：段②（今日）で `components/templates/mobile-booking-card.tsx` に作る（まだ無い）。状態の札は `StatusBadge`、予約の状態の色と言葉は `shared/booking-state.ts`・`booking-presentation.tsx` を使う。
- **決まり**：[§6.48](v8-design-rules.md)。版（`expectedVersion`）と `requestId` は PC と同じ口へ渡す。閲覧のみには操作を出さない。
- **見つけ方（コード）**：own-booking-card（`MobileBookingCard`・`PhoneBookingCard`・`ReservationCard` を自作）。


### 初期設定の共通カードと選んだ機能の設定

- 持ち主：`v8/dashboard/first-steps.tsx`の`FirstStepsCard`。選んだ機能の行は`v8/onboarding/setup-card.tsx`の`SetupTasks`、取得は`useStyleSetup`を使う。
- 使用先：標準・ECの共通ダッシュボードと、飲食・サロン・面談・教室の専用ダッシュボード。カードの数と進み線は基本の手順にそろえ、選んだ機能の案内と操作を同じカードへ差し込む。
- 操作：質問・まとめは`v8/onboarding/use-setup-wizard.tsx`（公開名`public/setup-wizard`）で選択中のホームに開く。QRは`v8/dashboard/friend-add.tsx`（公開名`public/friend-add`）をカードと窓だけの両方で使い、選択アカウントの経路だけを読む。権限のない設定入口は共通の灰色と理由で残し、質問の書き込みを許可しない。

### 初期設定の共通の行

- 持ち主：`components/shared/setup-step-row.tsx` と同名のCSS。`SetupStepList` / `SetupStepRow` / `SetupStepLabel` を基本の手順と選んだ機能の設定で共用する。
- 高さ・間隔・左右の余白・済みと次の状態はこの部品に集める。説明がある行もない行も同じ高さを保つ。
- 閲覧だけでも欄は出し、既存のGETで取得できた内容だけ表示する。変更操作は共通の灰色と理由、内容の参照は保存や有効化を伴わない窓で行う。

## 操作する対象の要約

持ち主は `components/shared/operation-target-summary.tsx`。呼び出し側が実際の操作先のIDと名前を渡し、既存の詳細項目の型でLINEアカウント・店舗（店舗の操作のみ）・動いている環境を表示する。名前と環境を推測しない。正本は [操作する対象の確認](v8-requirements/confirmation-targets.md)。

- スタンプのマスの数と描画用データは visit-stamps/public/preview が公開し、既存displayのslotCount/previewSlotsを再利用する。別のマス数の計算を作らない。
