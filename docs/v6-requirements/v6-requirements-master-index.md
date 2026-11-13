> 文書：V6 全34機能 要件定義 正本索引｜区分：今の正本｜最終確認：2026-10-19（日本時間）

> **2026-10-05**：この索引と34本は **動き（できること・合格条件）の正本** として残す。**見た目の指定は ★V8 の絵が勝つ**（`docs/v8-design-rules.md`）。本文中の「V6 の画面・ノード」「V5/V6 の見た目」の記述は見た目の根拠にしない。
>
> **2026-10-07**：V8 で足した機能（F-1〜F-25・予約の追加）・お客さまの画面（LIFF）・本番の切り替えの決まりは `docs/v8-requirements/`（[索引](../v8-requirements/README.md)）。V6 の正本化の決定・実装ロードマップ・32 機能の進捗表はリポジトリから外した（git の履歴に残る）。権限で使えないボタンは隠さず、灰色の押せないボタン＋理由の吹き出しで出す（2026-10-26 オーナー。`docs/v8-design-rules.md` §2）。

# V6 全34機能 要件定義 正本索引

更新日: 2026-09-03
状態: **34 / 34 完了**(2026-09-03 改訂: 横断契約の1本化、01・25 の書き直し、33・34 の追加)
対象外: V6複製後の追加デザイン変更、コード変更、DB更新、本番反映

## 0. この索引以外を要件として読まない

要件の正本は、この索引が指す34本と§5の横断契約、`docs/v8-requirements/` だけである。V2〜V5世代の要件・仕様は2026-09-03に`docs/archive/`へ移し、2026-10-11 に残っていた旧設計画像と旧表も含め、リポジトリからすべて外した。`AGENTS.md`「古い要件定義は読まない」も参照する。

## 1. 結論

全32機能は要件定義へ進める品質にある（2026-09-03 時点の判断）。当時は Pencil 上の V6実Node 260画面を機能別に再集計して各要件に実Node IDを書いたが、その表と ID は当時どの画面を調べたかの記録で、見た目の根拠にしない。**見た目は画面ごとの Pencil ★V8 の板と `docs/v8-design-rules.md`、動きはこの索引の34本・§5 の横断契約・`docs/v8-requirements/` が正本**（2026-10-05〜。V6 を版の正本とした当時の決定と、正本化の決定の文書は 2026-10-07 にリポジトリから外した）。画面に描かれた数字・自動処理・連携が現行データで実現できるとは限らないため、各要件で次を分けた。

- そのまま実装できるもの
- 既存DB/APIを安全に拡張すれば実装できるもの
- 外部契約・API仕様が決まれば実装できるもの
- 取得不能または危険なので除外するもの

採点の範囲は、V6 UI/UXが概ね94〜99点、Lステップ・Liny等への対抗力が概ね94〜100点である。現行実装完成度は38〜91点、データ安全性は21〜79点と差が大きい。したがって、見た目を一括載せ替えするのではなく、共通安全基盤を先に作り、機能単位で縦に通す。

## 2. 32機能の索引

| # | 機能 | 要件定義 | 実装前の主な条件 |
|---:|---|---|---|
| 1 | ダッシュボード | [詳細](./v6-01-dashboard-requirements-draft.md) | 共通集計、鮮度、account境界。各機能の後に仕上げる |
| 2 | 受信箱 | [詳細](./v6-02-inbox-requirements-draft.md) | 担当・対応状態・検索・権限・送受信台帳 |
| 3 | 友だち | [詳細](./v6-03-friends-requirements-draft.md) | account境界、PII、重複候補、CSV |
| 4 | 友だち属性 | [詳細](./v6-04-friend-attributes-requirements-draft.md) | schemaとvalueの分離、削除影響、監査 |
| 5 | シナリオ配信 | [詳細](./v6-05-scenario-delivery-requirements-draft.md) | 公開版、待機job snapshot、共通送信台帳 |
| 6 | 一斉配信 | [詳細](./v6-06-broadcast-requirements-draft.md) | audience snapshot、枠、停止、再送防止 |
| 7 | リマインダ | [詳細](./v6-07-reminder-requirements-draft.md) | 起点時刻、timezone、版、取消 |
| 8 | 自動応答 | [詳細](./v6-08-auto-reply-requirements-draft.md) | 競合優先順位、再帰防止、実行台帳 |
| 9 | 友だち追加時配信 | [詳細](./v6-09-friend-add-delivery-requirements-draft.md) | follow/refollow、account、版、重複防止 |
| 10 | ウェビナー | [詳細](./v6-10-webinar-requirements-draft.md) | 動画方式、公開版、視聴計測の限界 |
| 11 | テンプレート | [詳細](./v6-11-template-requirements-draft.md) | content version、利用先、媒体検査 |
| 12 | リッチメニュー | [詳細](./v6-12-rich-menu-requirements-draft.md) | 画像版、表示条件、LINE反映差分 |
| 13 | 回答フォーム | [詳細](./v6-13-response-form-requirements-draft.md) | 公開版、回答snapshot、同意、失敗回復 |
| 14 | 共通情報 | [詳細](./v6-14-common-information-requirements-draft.md) | 共通値と個別override、secret非格納 |
| 15 | 登録メディア | [詳細](./v6-15-media-library-requirements-draft.md) | private原本、派生asset、参照・削除 |
| 16 | 成果・アフィリエイト | [詳細](./v6-16-affiliate-requirements-draft.md) | 報酬台帳、締め、口座、会計判断 |
| 17 | マイル・行動スコア | [詳細](./v6-17-mileage-score-requirements-draft.md) | 2概念分離、版、冪等、交換原子性 |
| 18 | 流入と計測 | [詳細](./v6-18-inflow-measurement-requirements-draft.md) | site key、広告secret、送信冪等、費用取込 |
| 19 | コンバージョン | [詳細](./v6-19-conversion-requirements-draft.md) | 共通event、attribution、金額snapshot |
| 20 | 分析 | [詳細](./v6-20-analytics-requirements-draft.md) | 読取event、日別集計、時系列、保存snapshot |
| 21 | NEN配信 | [詳細](./v6-21-nen-delivery-requirements-draft.md) | EC起点、版、job snapshot、coupon saga |
| 22 | 写真審査 | [詳細](./v6-22-photo-review-requirements-draft.md) | privacy修正、人の最終判断、同意、point saga |
| 23 | EC連携 | [詳細](./v6-23-ec-integration-requirements-draft.md) | connector、未照合identity、event/action台帳 |
| 24 | LINE通知 | [詳細](./v6-24-line-notification-requirements-draft.md) | 顧客/運用者を分離、共通送信台帳 |
| 25 | オートメーション | [詳細](./v6-25-automation-requirements-draft.md) | 共通action、公開版、実行snapshot、retry |
| 26 | 外部連携 | [詳細](./v6-26-external-integrations-requirements-draft.md) | secret暗号化、SSRF/replay防止、Queue |
| 27 | 予約管理 | [詳細](./v6-27-booking-management-requirements-draft.md) | 代理予約、競合、通知、Google同期 |
| 28 | 予約設定 | [詳細](./v6-28-booking-settings-requirements-draft.md) | menu/resource/calendar版、例外日 |
| 29 | イベント予約 | [詳細](./v6-29-event-booking-requirements-draft.md) | 定員、待ち、期限付き繰上げ、通知 |
| 30 | ログインユーザー | [詳細](./v6-30-login-users-requirements-draft.md) | deny-by-default、三段階権限、session失効 |
| 31 | 機能設定 | [詳細](./v6-31-feature-settings-requirements-draft.md) | 契約/会社/個人を分離、server強制 |
| 32 | 運用状態 | [詳細](./v6-32-operations-status-requirements-draft.md) | server監視、kill switch、復旧、追記履歴 |
| 33 | アカウント設定 | [詳細](./v6-33-account-settings-requirements-draft.md) | LINE公式アカウントの登録・検証・切替、Webhook URL突合、Lステップからの乗り換え |
| 34 | はじめの設定と案内 | [詳細](./v6-34-onboarding-guidance-requirements-draft.md) | 初回セットアップの順路、レシピ、マニュアル導線、エラー文面 |

## 3. 実装判断

### 実装する

- 全32機能の主タスクと、V6に描かれた実現可能な状態
- 共通部品、版、event、action、job、audit、account境界
- 既存データを履歴として残した段階移行
- ★V8 の板との照合（1440・1152。`docs/v8-design-rules.md` §3）と遷移確認

### 条件付きで実装する

| 領域 | 条件 |
|---|---|
| 動画 | 管理動画と外部動画の方式を分け、外部動画の個人視聴区間は出さない |
| 広告 | 各広告APIの契約・token・event mappingが確定した接続先だけ |
| EC | provider adapterと利用shopのscopeが確定した接続先だけ |
| 決済 | providerを選定し、取消・返金・webhook・冪等を別要件で確定後 |
| Google Calendar | 既存認証・event ID・双方向競合規則を固定後 |
| 写真AI | 人の確認補助だけ。公開・不採用を自動確定しない |
| 税・源泉 | 法務・会計確認後。初期は入力・表示・明細まで |

### 除外する

- LINE個人単位の既読・未読・到達保証
- follow eventだけからの正確な流入経路判定
- 送信済みLINEメッセージの取消
- 名前だけ、AI類似度だけによる人物の自動名寄せ
- 外部providerと自社DBを単一transactionとみなすこと
- 公開済み定義や確定金額の直接上書き
- 履歴・監査・支払・審査記録の物理削除
- 外部動画URLからの正確な個人視聴区間取得
- 到着eventなしの配送到着断定
- AIだけによる写真公開・不採用、顔による本人特定
- 相関を因果として断定する分析
- 取得できない数値を0として表示
- 無限再試行、成功済み副作用の強制再送
- この管理画面からの銀行振込実行

## 4. 要件定義から実装へ渡せる状態か

**渡せる。** ただし、32機能を同時に画面実装へ渡すのではなく、次の5点を共通正本にしてから機能別Issueへ切る。

1. organization / LINE account / friend / operatorの境界
2. definition / version / publication / snapshot
3. receipt / domain event / action execution / job attempt
4. 権限、監査、secret、PII、同意
5. 移行、shadow実行、cutover、rollback、画像比較

共通正本は[横断整合レビュー](./v6-32-feature-cross-review.md)と[共通基盤要件](./v6-shared-platform-requirements.md)にまとめる。

## 5. 2026-09-03 改訂で1本化した横断契約

- 権限で使えない操作の見せ方は、各要件に「隠す・置かない・出さない」とあっても、V8 の決まり（2026-10-26 オーナー：灰色の押せないボタン＋理由の吹き出し）で読み替える。根拠は `docs/v8-requirements/README.md` の共通の決まり。データを見せない記述と API の 403 はそのまま。

機能別要件より優先する正本を次に固定した。機能別要件に別の流儀が残っていたら、正本側が勝つ。

| 契約 | 正本 | 内容 |
|---|---|---|
| 共通アクションのカタログ | [25 接続契約](./v6-25-automation-action-contract.md) | 第1期6・第2期7・第3期2の15処理。名称と順番を全文書で共有 |
| 新版公開後の既存利用先 | [横断レビュー §2](./v6-32-feature-cross-review.md) | 参照型 / スナップショット型の2分類だけ |
| 権限モデル | [30 ログインユーザー §7〜§8](./v6-30-login-users-requirements-draft.md) | `edit` / `view` / `none` ＋ 重要操作permission(`domain.resource.action`)＋項目マスク。役割表は既定bundle |
| 再試行の既定 | [共通基盤 §6-2](./v6-shared-platform-requirements.md) | 外部API 3回、送信Webhook 8回・24時間(例外)、内部処理は再試行なし |
| 外部呼出し・結果不明・サガ・cache | [段2の共通契約 §3〜§6](../v8-requirements/cleanup-stage2-contract.md#retry)・[共通基盤 §6-2・§6-4・§9-1](./v6-shared-platform-requirements.md) | B-365。既定の回数を増やさず共通化、結果不明は照合、各段を記録→実行→結果で更新、表示用集計だけ短い cache |
| 店舗の予約・クーポンの設定 | [段2の共通契約 §2](../v8-requirements/cleanup-stage2-contract.md#store-flags) | B-358。店舗の設定を正本にし、はじめの質問は初期値だけを1回書く |
| 未取得の表示文言 | [共通基盤 §9](./v6-shared-platform-requirements.md) | 値は `—`、ラベルは 未取得 / 取得失敗 / 権限不足 / 未接続 |
| 画像比較 | [共通基盤 §10 工程ゲート](./v6-shared-platform-requirements.md) | 要件の完了条件から外し、PRの工程条件で担保 |
| Pencilへの修正依頼 | [横断レビュー §7](./v6-32-feature-cross-review.md) | 02/03/04/09/10/13/16 に散在していた依頼を1表に集約 |
| 完了条件の書き方 | 各要件書 | 「動く」「分かる」を禁止し、4状態の契約テスト・3経路の自動テスト・画面一覧一致の定型3行＋検証できる文だけ |
| テナント分離 | この索引 §5-1 | **当面は 1 デプロイ = 1 組織。** `tenants` は将来用として残し、いま実装しない。所属で絞る必要が出た機能は LINE 公式アカウント単位(`accountId`)で絞る |
| 主ボタンの文字色 | この索引 §5-2 | 白文字が乗る緑は既存トークン `$accent-deep`(#087A3E、白文字と 5.44:1)。`$accent`(#06c755)は文字が乗らない用途だけ。状態の札の色と主ボタンの縁の色だけは V8 で変数を足してよい(2026-10-09 B-160 の ⑩) |

書き直した要件書: 01 ダッシュボード(メトリクス契約とカラム定義を追加)、25 オートメーション(画面別状態仕様とLステップとの差を追加、カタログは接続契約へ)。
新規: 33 アカウント設定、34 はじめの設定と案内。1人運用への配慮として、06 の二者承認と 30 のTOTP復旧を緩和した。

### 5-1. テナント分離(2026-09-03 決定)

**当面は 1 デプロイ = 1 組織として扱う。** `tenants` にあたる機能は将来用として残し、いまは実装しない(S5 のコードは書かない)。

- 多テナント運用の顧客がまだいない
- 顧客契約に関わるため、方針を変えるときは人が決め直す
- `tags` をはじめ、所属で絞る必要が出た機能は LINE 公式アカウント単位(`accountId`)で絞る。組織をまたぐ絞り込みは作らない
- 運用上の位置づけは `docs/organization-account-access-policy.md` に従う

### 5-2. 主ボタンの文字色(2026-09-03 決定)

**白文字が乗る緑は、既存トークン `$accent-deep`(#087A3E)を使う。新しい色トークンは作らない。**

> **例外(2026-10-09 オーナー B-160 の ⑩)**：V8 の**状態の札の色**(良い＝緑 #16a34a／文字 #087a3e、注意＝橙 #f97316／#c2410c、だめ＝赤 #ef4444／#b91c1c、案内＝青 #2563eb／#1d4ed8、止め・下書き＝灰 #94a3b8／#475569、地は各色の 10%)と、**主ボタンの縁の色**(#06612f)は、`globals.css` に変数として足してよい。画面に直書きはしない。値と使い方の正本は `docs/v8-design-rules.md` §6.4・§6.5 の 4・§6.15 の 10。それ以外の新しい色は、これまでどおり作らない。

| 色 | 白文字との比 | 判定 |
|---|---|---|
| `$accent` #06c755 | 2.26:1 | AA 不合格 |
| 検討した #06a94a | 3.10:1 | ボタンのラベル(13px・太字 600)には不合格 |
| 検討した #068a3c | 4.46:1 | 合格だが Pencil のトークン表に無い新色 |
| `$accent-deep` #087A3E | **5.44:1** | 合格。既存トークン |

AA が求めるのは、18.66px 未満の太字・24px 未満の並字で 4.5:1。ボタンのラベルは `$size-label` = 13px なので 3.10:1 では届かない。#068a3c も届くが、Pencil の決まり「色は S6umap のトークンだけを使う」に反するため、既にある `$accent-deep` を採る。

`$accent`(#06c755)は文字が乗らない用途(札の地、選択状態、チップ、アイコン、バッジ、有効表示)に残す。LINE らしさが要る場所で、文字を乗せていないため基準の対象外。

実装側は `--color-accent-deep`(#087a3e、`docs/v8-design-rules.md` §5)をそのまま主ボタンに使い、同値の別名トークンを増やさない。Pencil 側の反映(白文字が緑に乗る箇所)は lane:pen の修正 40 番で行い、反映日は横断レビュー §7 に書く。

## 6. 次工程の成果物

- [横断整合レビュー](./v6-32-feature-cross-review.md)
- [共通基盤要件](./v6-shared-platform-requirements.md)
- データ移行・切り替え・巻き戻しの安全条件：[共通基盤 §16](./v6-shared-platform-requirements.md)（旧「データ移行・API・受け入れテスト計画」から 2026-10-08 に書き写した。旧計画は履歴として残し、要件として読まない）

## 7. V7 の追加（2026-09-23 採用）

点検（kentavndng/line-harness-board#1064〜#1069）でオーナーが採用した4つ（A・B・D・E）の動きと合格条件は、2026-10-08 に下の各要件へ書き写した。正本はその節で、旧「V7 追加要件」は履歴として残し、要件として読まない。

見た目は画面ごとの ★V8 の板（`docs/v8-design-rules.md`）に従う。当時の「既存の V6 画面は変えず、Pencil に ★V7 として新しく描く」「★V7 の順位」は 2026-10-07 に失効した。新しく描く画面は ★V8 の Pencil に描く。V8 で足した機能・LIFF・切り替えの要件の入口は [`docs/v8-requirements/`](../v8-requirements/README.md)。

| 記号 | 追加 | 正本 |
|---|---|---|
| A | 流れ図（まず見るだけ） | [05 §3-11](./v6-05-scenario-delivery-requirements-draft.md)（09 §4-5・25 §4-2 も同じ決まり） |
| B | 受信箱のキー操作 | [02 §5-9](./v6-02-inbox-requirements-draft.md) |
| D | 写真の連続審査 | [22 §6](./v6-22-photo-review-requirements-draft.md) |
| E | 処理の進み・骨組み表示・保存結果の通知 | [共通基盤 §15](./v6-shared-platform-requirements.md) |

## 8. 未実装機能の確定（2026-09-25）

後段階にしていた9つと、突き合わせで「満たさない」が残った13のまとまりは、すべて**作ることに決めた**。決めた動きと合格条件は、2026-10-08 に下の各要件の節へ書き写した（各要件の「確定」の注記はその節を指す）。正本はその節で、旧「未実装機能の確定」は履歴として残し、要件として読まない。

- 旧資料と今の要件が食い違うところは、今の要件に従う（アカウント停止は手動で再開、共通情報の知らせは 1・3・7日前から選ぶ、版は下書きの保存と公開時の固定版を分ける、写真の報酬は投稿×報酬の種類で1回、大事な操作の再確認は TOTP 必須、見張りは1回で警告・認証の異常はすぐ知らせる、リッチメニューは切り替え後に照合・修復）
- 旧資料にだけあった数値（マイル承認の数・鍵の併用期間・動画の保管日数・再確認の猶予・視聴開始の秒数・異常な速度の倍率など）は書き写さず、各要件で「未決定（オーナー確認）」とした
- 当時の Pencil ★V7 の板（`p0RBam`・`ZQnlD`）・migration 番号（454〜501）・PR の分け方は履歴で、今の根拠にしない。migration は AGENTS.md の採番規則（最新の次の番号・番号ごとにオーナー承認）に従う

| 要件定義 | 作る機能 | Issue | 書き写した節 |
| --- | --- | --- | --- |
| [v6-06 一斉配信](./v6-06-broadcast-requirements-draft.md) | 二者承認・宛先台帳・監査ログ・状態 | #816 | §13 |
| [v6-22 写真審査](./v6-22-photo-review-requirements-draft.md) | 画像の重複検出・報酬ポリシーの版（危険なファイルの検査は共通基盤 §7-1） | #817 | §17 |
| [v6-18 流入と計測](./v6-18-inflow-measurement-requirements-draft.md) | 広告費の取り込み・サイト計測の同意 | #818 | §18 |
| [v6-19 コンバージョン](./v6-19-conversion-requirements-draft.md) | Web 計測の公開口・取消の追記イベント | #819 | §23 |
| [v6-11 テンプレート](./v6-11-template-requirements-draft.md) | 版の履歴・参照表 | #820 | §15 |
| [v6-10 ウェビナー](./v6-10-webinar-requirements-draft.md) | 離脱判定・動画の準備・定員・見逃し配信・保管 | #821 | §18 |
| [v6-12 リッチメニュー](./v6-12-rich-menu-requirements-draft.md) | 公開の saga・照合と修復・公開前の確認 | #822 | §17 |
| [v6-16 アフィリエイト](./v6-16-affiliate-requirements-draft.md) | 帰属の判定・案件の率/期間/上限/版 | #823 | §20 |
| [v6-01 ダッシュボード](./v6-01-dashboard-requirements-draft.md) | 通知台帳との接続・今後の予定・止めた経路の QR | #824 | §15 |
| [v6-13 回答フォーム](./v6-13-response-form-requirements-draft.md) | P 一覧の数・公開前の試し・読みにくい色 | — | §14 |
| [v6-14 共通情報](./v6-14-common-information-requirements-draft.md) | Q 状態・変える理由・期限の知らせ・秘密の値 | — | §24 |
| [v6-17 マイル・行動スコア](./v6-17-mileage-score-requirements-draft.md) | R 確定待ち・高額の調整の承認・付与の決まりを試す | — | §18 |
| [v6-26 外部連携](./v6-26-external-integrations-requirements-draft.md) | S 受信の試し・鍵の入れ替え・複数一致の保留 | — | §23 |
| [v6-28 予約設定](./v6-28-booking-settings-requirements-draft.md) | T 予約の設定の版と予約の写し | — | §9（今の本文のまま。旧案の「保存のたびに新しい版」は採らない） |
| [v6-29 イベント予約](./v6-29-event-booking-requirements-draft.md) | U URL・状態・開催回の変更・URL の限定 | — | §5・§6-1・§7-3・§8・§11-2（今の本文のまま） |
| [v6-30 ログインユーザー](./v6-30-login-users-requirements-draft.md) | V 大事な操作の再確認・いつもと違うログイン（26・33 も従う） | — | §22 |
| [v6-32 運用状態](./v6-32-operations-status-requirements-draft.md) | W 送れる数・裏の仕組みの見張り | — | §5-3 の注記（本文は §5-1〜§5-3・§6） |
| [v6-33 アカウント設定](./v6-33-account-settings-requirements-draft.md) | X 止める・再開・自動切り替え・Lステップの引っ越し・鍵の暗号化 | — | §24 |
| [v6-34 はじめの設定と案内](./v6-34-onboarding-guidance-requirements-draft.md) | Y 失敗の文の対応表・追跡番号・はじめの進み・レシピ | — | §6・§7-5・§9・§10（今の本文のまま） |
| [共通基盤](./v6-shared-platform-requirements.md) | B 危険なファイルの検査・共通の記録と試験 | — | §7-1・§13 |
