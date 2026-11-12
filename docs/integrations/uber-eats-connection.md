> 文書：Uber Eats 接続台帳｜区分：今の説明｜最終確認：2026-10-23（日本時間）

# Uber Eats 接続台帳

対象：デリバリー受注（`/restaurant-test/delivery`）へ Uber Eats の注文を取り込む連携。
記録日：2026-10-12。秘密値（client_secret・トークン・合言葉）はこの文書に書きません。

## 本番移行までの現在の進め方（2026-10-23）

問い合わせ先については、Masatoから「従来のGoogleフォームは使われていないとUberから案内された」との共有がある。
Masatoが日本の窓口へメールを送付済みであり、その返信で現在の担当部署・技術窓口を確認する。
過去の記録にあるフォームの案内だけを根拠に、同じフォームを再度使えるとは判断しない。

連携対象は、自社の受注集約サービスmusuboと **Uber Eats Marketplace API**。
自社サイト等の注文を配達員へ依頼するUber Directは別の製品であり、認証情報や申請を共用しない。

1. musubo側の実装・模擬通信での検証を仕上げ、開発統合版を検証環境へ配備する。
2. Uberに、申請中の連携範囲・必要な権限・承認されたテスト店舗・通し試験の担当者を確認する。
3. 承認されたテスト環境で、店舗認可、店舗選択、注文受信、受け付け・拒否・取消、接続確認・解除を通して検証する。
4. UberとのIntegration Verificationを完了してから、本番用アカウント・本番アプリを用意する。
5. 本番アプリのclient_idに対する権限付与をUberへ依頼し、許可された権限と本番用通知URLを設定する。
6. 対象店舗と開始日をUberの担当者へ少なくとも1週間前に共有し、Masatoの承認後に自社店舗でパイロットを開始する。
7. 少なくとも3日間、注文投入成功率98%以上というUberのパイロット基準を満たしたことを確認してから、追加店舗への展開を調整する。

自社の実店舗はパイロット候補にできると考えられるが、採用可否と日程はUberとの確認事項。
店舗アカウントの所有は、本番アプリへの権限付与や連携検証を済ませた証拠にはならない。
管理画面で本番アプリを作るだけで本番利用が承認されるわけでもない。
注文連携に加えて営業状態・メニュー操作をどこまで求められるかは、Uberとの合意範囲を確認する。

根拠：[Uberの本番移行手順](https://developer.uber.com/docs/eats/guides/going-live)、
[Sandbox](https://developer.uber.com/docs/eats/guides/sandbox)、
[Uber Direct](https://developer.uber.com/docs/deliveries/overview)。

### Uberと行う通し試験の確認表

以下は実接続でこれから確認する項目。自動試験の合格を実接続の合格とは扱わない。
対象はUberが承認したテスト店舗とテスト注文に限定し、実行日・対象版・各結果を記録する。

| 操作・条件 | 確認する結果 |
| --- | --- |
| 店舗のログイン、認可、対象店舗の選択 | 正しいmusubo店舗だけに接続され、別店舗へ注文が入らない |
| 注文通知、同じ通知の再送 | 注文内容が反映され、重複注文が作られない |
| 受け付け、拒否、取消 | Uber側とmusubo側の注文状態が対応する |
| Uber側での取消と店舗操作の競合 | 終了した注文を誤って先へ進めない |
| 通信断やタイムアウト | 結果不明を表示し、店舗へ確認せず再送しない |
| 接続状態の確認 | 店舗・注文管理者・有効状態の照合結果が表示される |
| 確認画面からの連携解除 | 解除が確認できた場合だけ解除済みとなり、その後の注文操作が止まる |
| 店舗認可の期限切れ | 必要な再認可を案内し、期限切れの権限で解除しない |

メニュー更新、売り切れ、受付停止・再開は申請範囲をUberと確認して試験表へ追加する。

## 現在の実装範囲（PR #1800）

対象は開発・検証環境。Uberとの実接続試験と本番承認はまだ完了していない。
以下は後続の過去記録にある「注文機能は未実装」という状態を更新するもの。

- 公式の注文通知を署名検証し、固定されたUber APIから詳細を取得して保存する。通知本文にあるURLへはアクセスしない。
- 注文の受け付け・拒否・取消を公式APIへ送る。同じ注文の通知処理と操作を排他し、重複操作と通信結果が不明な操作の再送を止める。明確な429だけ待機時間と回数上限を設け、手動で再試行できるようにする。
- 準備完了・受け渡し済みは店舗内の進行記録として更新する。準備完了は作業中の一覧に残し、受け渡し件数へ含めない。取消通知や結果不明の送信が残る注文は先へ進めない。Uberへ追加通知を送ったという表示はしない。
- 注文一覧が `orderActionsEnabled: true` を返した店舗だけ個別注文操作を表示する。接続無効・送信停止・認証設定不足・一覧の取得失敗では操作を止める。別アカウントの古い応答は使わない。
- 店舗の連携開始・解除通知は注文とは異なる形式として処理する。店舗照合・イベント重複・再接続との競合を検査する。開始通知だけで接続済みとせず、現在のUber側の設定を照合する。
- APIトークンは暗号化して再利用し、注文用と店舗照合用の権限を分ける。期限切れ前の更新競合と一時的な取得失敗の集中を防ぐ。

自動試験では通信を模擬し、実店舗・実注文・検証環境の認証設定は変更しない。
新しいDBマイグレーションは不要。画面・API・通知の変更を同じ版で検証する。
管理画面のビルド後の出力で、1152px・1440pxの一覧と詳細、操作可・不可を確認し、横はみ出しとブラウザー例外がないことを確認した。

接続確認・解除の管理操作は、下記の追加実装で対応する。
残る工程は、営業状態・メニュー連携などUberの審査で求められる範囲の確認、
承認されたテスト店舗による通し試験、Uberの本番権限付与と自社店舗でのパイロット。
実店舗アカウントの所有だけでSandbox検証や本番承認を省略できるとは扱わない。
本番への切替はMasatoの承認を別に受ける。

仕様の確認先：[注文連携](https://developer.uber.com/docs/eats/guides/order-integration)、
[品質・性能要件](https://developer.uber.com/docs/eats/quality-and-performance)、
[本番移行](https://developer.uber.com/docs/eats/guides/going-live)。

## 接続確認・解除の追加実装

設定の「接続を確かめる」は、Uberの現在の設定を問い合わせて店舗と注文管理者を照合する。
画面を開いただけではUberへ問い合わせない。状態が変わらない確認で接続バージョンを変更し、
処理中の注文を無用に結果不明にすることも避ける。

「連携を解除する」は確認画面で確定した場合だけ実行する。権限のある管理者、対象アカウント、
店舗の所属、接続バージョンをサーバーで検査し、解除開始前に新しい注文操作を止める。
送信中・結果不明の注文操作が残る場合は、接続解除を先に進めない。
解除成功を確認してから店舗認可トークンを消去する。注文・履歴は削除しない。

タイムアウト、接続断、サーバー障害などで解除結果が確定しない場合は、結果不明を保存して再送を止める。
404だけを解除成功の根拠にしない。遅れて届いた接続開始通知や、解除前に開かれた認可画面の結果で
解除済み・解除結果不明の状態を上書きしない。復旧が必要な状態はmusubo側で確認する。
Uber側の一時的な無効化に続く正式な再開通知は、既存の店舗と現在の設定を照合して扱う。
musuboから完全解除した記録は別に保持し、その店舗は新しい認可手順を経ずに復活させない。

接続確認にはアプリの `eats.store`、解除には店舗の認可で取得した `eats.pos_provisioning` を用いる。
店舗認可トークンが無い・期限切れの場合は、解除を送信せず再認可が必要と案内する。
「Uber Eats にログインし直す」から再認可できる。既に選択した店舗を保持し、認可の更新だけで
店舗を再有効化したり、解除を送信したりしない。戻った後は接続状態を確認し、必要な解除を
確認画面から改めて実行する。認可中に店舗の所属や接続状態が変わった場合は保存を拒否する。

この追加実装はDBスキーマや配備先のOAuth・Webhook設定を変更しない。
通信を模擬した確認とUberの実接続試験は区別して記録する。
配備用ビルドに模擬APIを接続し、375・1152・1440pxで接続確認、解除確認、解除成功、
結果不明、再認可への遷移、再認可後の確認待ちを検証した。横はみ出しと画面例外は0件。
確認前のDELETEは0回、物理的なダブルクリックでもDELETEは1回だけで、結果不明の再送と
再認可後の自動DELETEも0回だった。ここでは実際のUberへ通信していない。

根拠：[接続状態の取得](https://developer.uber.com/docs/eats/references/api/v1/get-eats-stores-storeid-posdata)、
[連携の解除](https://developer.uber.com/docs/eats/references/api/v1/delete-eats-stores-storeid-posdata)、
[連携無効化の通知](https://developer.uber.com/docs/eats/references/api/webhooks/store-deprovisioned)。

## 1. 店舗が自分で鍵を発行できるか

**できません（公式資料に該当する仕組みの記載なし）。**

Uber Eats Manager や加盟店向けポータルから、店舗が APIキー・アクセストークン・連携コードを発行して
第三者の画面に貼り付ける方式は、公式ドキュメントに存在しません。
連携サービス側の資格情報は `client_id` と `client_secret` の1組だけで、これは**連携サービス（musubo）
のアプリ単位**に発行されます。店舗ごとには発行されません。

- https://developer.uber.com/docs/eats/guides/authentication
- https://developer.uber.com/docs/eats/guides/integration-activation-flows

## 2. 店舗が自分で設定画面から連携を完了できるか

**できます。ただし方式は「ログインして許可する」の一通りだけです。**

公式の "Merchant Authentication Workflow" ＋ "Third-Party Activation Workflow"（上記
integration-activation-flows ページ）に、連携サービスの画面から店舗が連携を開始する手順が定義されています。

| 手順 | 操作する人 |
| --- | --- |
| 1. 連携サービスが自分のポータル画面（POS Portal Microsite）を出す | musubo |
| 2. 「Login to UberEats」を押す（権限 `eats.pos_provisioning` の認可画面へ） | 店舗 |
| 3. Uber の画面でログインして許可する | 店舗 |
| 4. 戻ってきた1回だけ使える認可コードをトークンに交換する | musubo（サーバ間） |
| 5. `GET /v1/eats/stores` で店舗一覧を取得する（外部店舗IDは単独の照合キーにしない） | musubo |
| 6. つなぐ店舗を選ぶ（Select Stores to Provision） | 店舗 |
| 7. `POST /v1/eats/stores/{store_id}/pos_data` で有効化する | musubo |
| 8. 解除は店舗が対象を選び、`DELETE /pos_data`（一時停止は `PATCH` で `integration_enabled: false`） | 店舗＋musubo |

状態の変化は `store.provisioned` ／ `store.deprovisioned` の webhook で届きます。
**どの手順にも、店舗が鍵を写して貼る操作はありません。**

このほかに「Uber が加盟店の登録時にあらかじめ紐付ける」「店舗が Uber の Tech Support Form から依頼する」
という経路もありますが、どちらも設定画面からの自己完結にはならないため、必須条件（店舗が自分で
設定画面から連携）を満たすのは上の OAuth ログイン方式だけです。

## 3. musubo 側の事前手続き（1回だけ・店舗ごとではない）

- 開発者アカウント登録（Sandbox から開始）
- NDA と API 利用契約
- Uber Eats のパートナー担当者の承認
- 本番前の Integration Verification（Uber 立ち会いの通し試験）
- 本番アプリの作成と Scope Whitelisting（`client_id` を申請して権限を開放）
- パイロット店舗で**最低3日**の稼働、注文投入成功率 98% 以上、全面展開は1週間前に事前通知

出典：https://developer.uber.com/docs/eats/guides/getting-started ／
https://developer.uber.com/docs/eats/guides/going-live

**この手続きは musubo 1回で済みます。店舗ごとに Uber と打ち合わせる必要はありません。**
手続き後に店舗ごとに必要なのは、上の表の 2・3・6（ログインと店舗選択）だけです。

## 4. 検証環境（2026-10-17 訂正）

テスト用アプリの作成と Sandbox の権限付与は自分でできます。弊社は
**`Sandbox Access Granted` まで4つすべて完了済み**（Application Created／Organization Linked／
Legal Agreement(s) Signed／Sandbox Access Granted）。
出典：https://developer.uber.com/docs/eats/guides/sandbox

### 「テスト店舗の払い出し」を前提として扱っていたのは誤りでした

公式の手引きに**払い出しの手順は書かれていません。** 書かれているのは
"What happens next" の箇条書きの1行 `Request test stores from Integration Tech Support`
だけで、申請書式・所要日数・受け取り方の定義はありません。同じページは
Sandbox で **「模擬の店舗と注文（simulated stores and orders）が使える」**とも書いています。

にもかかわらず、この台帳は「テスト接続の待ち物はテスト店舗の払い出し1つ」（§4-2）と書き、
残作業全体の前提にしていました。**これは誤りです。** 実際には権限は付与済みで、
トークン取得（§6-4）も受信の確認（§6-5）もテスト店舗を待たずに成功しています。

| 残る工程 | 店舗IDが要るか |
| --- | --- |
| 店舗を選ぶ画面の設計と承認（新規UI） | **要らない** |
| 30日で切れるトークンの取り直し | **要らない** |
| 注文の取り込み（通知→台帳）の実装と試験 | **要らない** |
| `GET /v1/eats/stores` の実データ確認 | 要る（模擬店舗が返るなら不要） |
| `POST /pos_data` の実行 | 要る |

**Uber の返信を全体の待ち物にしません。** 上の「要らない」3つを先に進めます。

## 4-2. 弊社の本番 Uber アカウント（店舗）をテストに使えるか（2026-10-16 判定）

利用者からの問い：**「本番アカウントに繋げられるのか。店舗IDがあれば問題ないのか」**

**答え：店舗IDだけでは繋がりません。足りないのは店舗側の情報ではなく、弊社アプリ側の資格です。**
壁は2つあり、どちらも店舗IDでは越えられません。

### 壁1：弊社アプリがまだ本番側の登録簿にいない

| 根拠 | 出典 |
| --- | --- |
| 弊社アプリ `musubo POS Integration` は開発者画面の表示が **TEST APP**。`Create Prod App` は押せない | §5-2 |
| 本番の権限（`eats.pos_provisioning`）は「Uber の個別審査が先」 | §5-2・§3 |
| 開発者画面の **Integration Verification Result が未完了** | §7 |
| 実機で本番側 `auth.uber.com` へ繋いだ結果は `invalid_client`（＝本番の登録簿から弊社の `client_id` を引けない） | §7-2 |

**つまり本番の店舗IDを持っていても、いまのアプリでは認可画面すら出ません。**
これは設定の不足ではなく、審査前という状態そのものによる仕様どおりの結果です（§5-2 の訂正）。

### 壁2：Sandbox と本番は別の世界で、店舗IDは行き来しない

接続先が認証・API ともホスト単位で分かれており（§5-2）、
**本番に登録された店舗は Sandbox の `test-api.uber.com` 側には存在しません。**
Sandbox で `GET /v1/eats/stores` に出るのは Uber が払い出すテスト店舗だけです（§4）。
本番の店舗IDを Sandbox 設定（`RT_DELIVERY_UBEREATS_ENVIRONMENT=sandbox`）のまま渡しても、
相手側に該当する店舗が無いため照合できません。

### 仮に本番側へ向けた場合に起きること（だから今はやりません）

- 本番で繋ぐには §3 の手続きが順に必要です。Integration Verification（Uber 立ち会いの通し試験）
  → 本番アプリ作成 → Scope Whitelisting → パイロット店舗で最低3日・注文投入成功率 98% 以上。
- `POST /pos_data` で有効化した本番店舗には、**実際のお客様の注文が musubo へ流れ始めます**（§5）。
  試験のために本番店舗を繋ぐのは、実注文を試験に巻き込むことになります。
- したがって `RT_DELIVERY_UBEREATS_ENVIRONMENT` を本番へ切り替える作業は、
  審査が通るまで行いません。

### 本番アカウントが要るのはこの後の工程

無駄にはなりません。**Integration Verification の通し試験とパイロット店舗の3日稼働**で、
弊社の本番 Uber アカウントと実店舗が必要になります。
いまの段階で使う先が無いだけで、順番が後ろにあるという関係です。

### 結論（待ち物の書き方を 2026-10-17 に訂正）

**本番アカウントは Sandbox の代わりになりません。** これは上の壁1・壁2のとおりで変わりません。

ただし当初ここには「テスト接続の待ち物は Sandbox のテスト店舗の払い出し1つ」と書いていました。
**この書き方は誤りでした**（§4 の訂正）。Uber からの返信が要るのは
`GET /v1/eats/stores` の実データ確認と `POST /pos_data` の2つだけで、
残りの工程はいま進められます。利用者の操作は不要です。

## 4-3. Uber の連絡先（2026-10-16 調査・出典の有無で分けた）

利用者からの問い：**「問い合わせ先がフォームしかない。開発のメール窓口はないか」**

**Uber は開発者向けのメールアドレスを公開していません。** 公式ページが示す人への経路は
**フォーム**と**パートナー担当者**の2つだけです。

### Uber 自身のページで確認できたもの

| 窓口 | 値 | 出典 |
| --- | --- | --- |
| Integration Tech Support フォーム | `http://t.uber.com/integration-support` | https://developer.uber.com/docs/eats/guides/getting-started（「Technical questions and issues」） |
| Uber Eats パートナー担当者 | 個別（弊社の担当者） | 同上。`Partner Approval` の前提として「Speak with your Uber Eats partner manager」 |
| Uber Eats Japan 代表メール | `uber.japan@uber.com` | 特定商取引法に基づく表示（help.uber.com）。会員・一般窓口で開発用ではない |
| Uber Eats Japan 代表電話 | `03-4588-5452`（10:00–19:00） | 同上。総務／Eats JP 共通と記載 |

developer.uber.com の該当ページには**メールアドレス・電話番号・Slack 等は一切載っていません**。
加盟店向けの POS 連携のヘルプ記事（help.uber.com）も、連絡手段はフォームだけでした。

### 検索では出るが Uber の公式ページで裏が取れなかったもの（使用前に要確認）

`eats-partner-tech-support@uber.com` ／ `restaurants@uber.com`。
いずれも第三者サイトや検索結果の要約にのみ現れ、Uber 自身のページでは確認できませんでした。
**実在・現役である保証がないため、重要な依頼の唯一の宛先にはしません。**

### フォームより確実な経路（弊社の状況に固有）

§3 の事前手続きには「**Uber Eats のパートナー担当者の承認**」が含まれ、これは
フォームではなく**担当者を通す工程**です。弊社はすでに本番の Uber Eats 加盟店アカウントを
持っているため（§4-2）、**その加盟店に付いているアカウント担当者が、そのまま開発側の
取次ぎ役になり得ます。**

依頼する内容は次の2点で、フォームへ送った内容（§7-2 の控え）と同じです。

1. Sandbox のテスト店舗の払い出し
2. Integration Verification と本番アプリの権限開放（Scope Whitelisting）の進め方

担当者が分からない場合の確認先は、Uber Eats Manager（加盟店管理画面）のヘルプ、
または上記の代表窓口です。**フォームの返信を待ちながら並行して当たれます**（二重依頼には
ならない。フォームは技術窓口、担当者は営業・契約窓口）。

## 5. 公式仕様の要点（実装の根拠）

出典：https://developer.uber.com/docs/eats/guides/authentication ／
https://developer.uber.com/docs/eats/guides/integration-activation-flows ／
https://developer.uber.com/docs/eats/api/webhooks

| 項目 | 仕様 |
| --- | --- |
| 接続先 | **アプリの種類で分かれる**（下の §5-2） |
| 権限（店舗の認可） | `eats.pos_provisioning`（店舗一覧の取得と連携の有効化だけ） |
| 権限（日々の運用） | `eats.store`／`eats.store.status.write`／`eats.order`／`eats.store.orders.read` |
| 2種の認可 | `authorization_code`（店舗の認可）と `client_credentials`（運用）。**権限を混ぜて要求できない** |
| 有効期間 | `expires_in = 2,592,000`（30日） |
| 更新 | **更新用のトークンは返らない**（`refresh_token` は空文字）。切れる前に取り直す |
| 回数の上限 | トークンの口は1時間100回。超えると 429 で、古いトークンが無効になる |
| 受信の署名 | 見出し `X-Uber-Signature`／本文の HMAC-SHA256・鍵は `client_secret`・小文字16進 |
| 受信の応答 | 200 と空の本文。失敗時は 10秒・30秒・60秒・120秒で最大7回届く |
| 店舗一覧 | `GET /v1/eats/stores`（外部店舗IDは変わりうるので単独の照合キーにしない） |
| 連携の操作 | `POST`（有効化・本文なしの200）／`GET`（状態）／`PATCH`（一時停止）／`DELETE`（解除）`/v1/eats/stores/{store_id}/pos_data` |

## 5-2. 接続先は「アプリの種類」で分かれる（2026-10-15 判明）

出典：https://developer.uber.com/docs/eats/guides/sandbox

Uber は審査前の **TEST APP（Sandbox）** と審査後の **PRODUCTION APP** で接続先そのものを分けています。

| | TEST APP（Sandbox） | PRODUCTION APP |
| --- | --- | --- |
| 認証 | `https://sandbox-login.uber.com` | `https://auth.uber.com` |
| API | `https://test-api.uber.com` | `https://api.uber.com` |
| 権限 | Sandbox のホストに限り**自動で付く** | Uber の個別審査が必要 |

公式の注意書き：

- 「トークンを取る先」と「APIを呼ぶ先」は必ず同じ側に揃える。混ぜると認証が落ちる。
- TEST APP は Sandbox のホストを使わなければならない。
- Sandbox が通っても本番が通るとは限らない。

公式の切り分け表は、誤った組み合わせの例として
**「テスト用アプリで `auth.uber.com` を使う」**を名指ししています。

弊社のアプリ（`musubo POS Integration`）は開発者画面の表示が **TEST APP** で、
`Sandbox Access Granted` は済み、`Create Prod App` は押せません。
つまり**いま使える側は Sandbox だけ**です。

### 以前の「解決済み」の訂正

2026-10-13 に「認可画面のURLは `auth.uber.com`、**コードの変更は不要**」と記録しましたが、
**これは誤りでした。** TEST APP と PRODUCTION APP でホストが分かれることを見落としており、
`auth.uber.com` と `api.uber.com` は**本番側の値**です。審査前の弊社アプリから本番側のホストを
呼んでいたため、認証が通らないのは仕様どおりの結果でした（§7-2 のエラーもこれで説明が付きます）。

なお `login.uber.com` が乗り手側の別ホストであることは変わりません。
Sandbox 側の**認可画面**のURLは公式の手引きに載っていないため、認証ホストから組んだ
推定値を使っており、まだ実際には確かめていません（`uber-eats-hosts.ts` の説明書きに明記）。
最初の接続確認は `client_credentials`（トークンの口だけ）で行うため、そこでは推定値を踏みません。

### 以前の未確認点（2026-10-13 解決・Uber への問い合わせは不要）

1. **戻り先URL（`redirect_uri`）は Uber の開発者画面に自分で登録します。** 申請は不要でした。
   利用者が開発者画面で該当欄を見つけて設定済みです（2026-10-13）。
   登録した文字列は上の組み立て結果と同じ
   `https://stg-api.musubo.jp/api/restaurant-test/delivery/ubereats/oauth/callback` のため、
   上書き用の `RT_DELIVERY_UBEREATS_REDIRECT_URI` は**使いません**（未設定のままにします）。

開発者画面で残っているのは **Integration Verification Result**（§7）だけです。

## 6. いまの実装状況

- Uber との通信の層：`apps/worker/src/services/uber-eats.ts`（**追加済み**）。
  認可画面のURL生成・2種のトークン取得・許された権限の確認・30日の期限と取り直しの判定・
  店舗一覧・`pos_data` の有効化／状態／一時停止／解除・受信の署名検証。
  DBを触らず、`fetch` を受け取るだけの層です。試験は `uber-eats.test.ts`（16件）。
- 接続用の設定の受け口（**追加済み**。値そのものは Git にも会話にも書きません）。
  Cloudflare Worker の**暗号化された秘密設定**として環境ごとに入れます。変数名だけ記します。

  | 変数名 | 入れるもの |
  | --- | --- |
  | `RT_DELIVERY_UBEREATS_CLIENT_ID` | Uber の開発者画面の Application ID |
  | `RT_DELIVERY_UBEREATS_CLIENT_SECRET` | 同じアプリの Client Secret（受信の署名の鍵も兼ねる） |

  これに加えて、接続先を選ぶ**秘密でない**設定が1つあります（§5-2）。

  | 変数名 | 入れるもの |
  | --- | --- |
  | `RT_DELIVERY_UBEREATS_ENVIRONMENT` | `sandbox` のときだけ TEST APP 側へ向ける。未設定・`production` は本番側 |

  検証環境（`nen-line-stg`）は弊社アプリが TEST APP のため **`sandbox`** を入れます。
  想定外の文字列（`stg`・`test` など書き間違い）は本番側へ落とさず「連携の設定ができていない」
  として扱い、連携の口を開けません。黙って本番の店舗へ出てしまうより、つながらないことで
  配備の誤りに気づける方を選んでいます。

  **秘密設定として入れるのは上の2つだけです。** 戻り先URLは配備の設定 `WORKER_PUBLIC_URL` と決まった道
  `/api/restaurant-test/delivery/ubereats/oauth/callback` から組み立てます（Google 接続と同じ考え方で、
  呼び出し元のホストからは作りません。入口と戻り先が1文字でも違うと Uber 側ではじかれるためです）。
  検証環境では `https://stg-api.musubo.jp/api/restaurant-test/delivery/ubereats/oauth/callback` になります。
  Uber のアプリ登録が別の文字列のときだけ `RT_DELIVERY_UBEREATS_REDIRECT_URI` で上書きします。

  読み取りは `uberOAuthClient(env)`／`uberWebhookSecret(env)`
  （`apps/worker/src/services/restaurant-delivery.ts`、試験 `src/services/restaurant-delivery.test.ts` 6件）。
  2つそろわない環境、または戻り先が `https://` で始まらない環境では連携の口を開けません。
  静的なトークンの経路（`RT_DELIVERY_*_API_TOKEN`／`_WEBHOOK_SECRET`）とは別の値で、混ぜません。
- 店舗ごとの接続の保存先（**追加済み**）：移行 `packages/db/migrations/636_restaurant_delivery_uber_connections.sql`。
  4つの表を作ります。`rt_delivery_uber_connections`（1店舗1件。暗号化したトークン・期限・
  許された権限・Uber の店舗ID・状態・版）／`rt_delivery_uber_oauth_states`（認可中の一時状態）／
  `rt_delivery_uber_store_candidates`（つなぐ店舗の候補）／`rt_delivery_uber_app_tokens`
  （アプリ単位のトークンの控え）。更新用トークンの欄は作りません（公式仕様どおり返らないため）。
  時刻はミリ秒の整数、トークンは `v1.…` の暗号化した形式だけを保存します。
  4表の退会後の扱いは `packages/db/src/data-retention-tables.json` に登録済みです。
  一時状態と接続はその統括のものとして消し（`account_id` で紐づけ）、店舗の候補は店舗の子として
  店舗より先に消します。アプリ単位のトークンだけは統括に紐づかないので消す対象に入れません。
- 認可の入口と戻り先の受け口（**追加済み**）：`apps/worker/src/routes/restaurant-delivery.ts`。

  | 道 | 役割 |
  | --- | --- |
  | `POST /api/restaurant-test/delivery/ubereats/connect/start` | 認可画面のURLを作って返す。店舗管理者以上だけ |
  | `GET /api/restaurant-test/delivery/ubereats/oauth/callback` | 戻ってきた認可コードをトークンへ交換して保存する |
  | `GET /api/restaurant-test/delivery/ubereats/connection` | いまの接続状態を画面へ返す。Uber へは問い合わせない |
  | `GET /api/restaurant-test/delivery/ubereats/stores` | ログイン済みの店舗の一覧を Uber から取り、候補として控える |
  | `POST /api/restaurant-test/delivery/ubereats/stores/select` | 選ばれた1店舗で Uber 側の連携を有効にし、接続中にする |

  入口は `state` を1件作り、1回使い切り・10分で失効させます（Cookie `lh_uber_state` は
  `HttpOnly`／`Secure`／`SameSite=Lax`／`Max-Age=600`）。すでにつながっている店舗からの開始は
  「つなぎ直し」として扱い、行を増やさず同じ1件を書き換えます。
  戻り先の受け口は、`state` が無い・食い違う・期限切れ・使用済み・別の担当者、のいずれでも
  接続せず、符号の交換そのものを試しません。店舗が許可しなかった場合、権限が足りない場合、
  交換に失敗した場合は、接続情報を作らず（または状態を変えず）理由の符号だけを残します。
  サービスからの自由文とトークンは、台帳にも記録にも残しません。
  操作は監査台帳へ `restaurant.delivery.ubereats.connect.start`／`…connect` として残します。
  管理画面へは `/settings/delivery?ubereats=…` の形で結果だけを返します。
  同じ `state` の戻りが同時に二度来ても通るのは片方だけです。使用済みへの更新を
  「まだ使われていない」条件付きで行い、**1件書き換えられたときだけ**符号の交換へ進みます
  （Google Sheets 連携の R448 と同じ形）。更新が0件だった側は交換を試さず `invalid_state` で終わります。
- つなぐお店を選ぶ道（**追加済み**・2026-10-17）。ログイン（`pending_store`）から
  接続中（`connected`）へ進む最後の1段です。
  - 一覧は**加盟店のトークン**（`authorization_code` で得たもの）で `GET /v1/eats/stores` を叩きます。
    アプリ単位のトークンは使いません。権限の追加も不要です（`eats.pos_provisioning` のまま）。
  - 取れた店舗は `rt_delivery_uber_store_candidates` へ**控え**として入れ替えます（取り直すと前回分は残らない）。
    店舗IDが無い行は候補にしません。住所は「郵便番号 市区町村 住所」をつないだ1行だけを持ちます。
  - 確定では、画面から来た店舗IDを**その控えと突き合わせ**、入っていなければ Uber へ送らずに
    `store_not_candidate`（404）で止めます。控えにある場合だけ
    `POST /v1/eats/stores/{id}/pos_data`（`is_order_manager: true`）で連携を有効にします。
    この送信は**再試行しません**（二重に送ると連携が重なるため）。
  - 成功したら `status='connected'`・`provisioned_at` を入れ、控えを消します。`connected_at` は
    最初の値を保ちます（`COALESCE`）。失敗したら接続中にせず理由の符号だけを残し、
    控えは**消しません**（取り直さずにもう一度選べるように）。
  - トークンの期限が3日前を切っていれば Uber へ問い合わせず、`auth_expired`（409）で
    状態を `expired` に入れ替えて、ログインのやり直しを促します（更新用トークンは返らないため）。
  - 鍵が無い環境は `encryption_key_missing`、ID・Secret が無い環境は `oauth_not_configured`（503）。
    いずれも Uber へは送りません。
  - 操作は監査台帳へ `restaurant.delivery.ubereats.store.select` として残します。
  - 試験は `src/routes/restaurant-delivery.test.ts`（デリバリー受注と合わせて**100件**。
    うち Uber のログイン連携が33件＝認可の往復16件・接続状態の読み取り5件・つなぐお店を選ぶ12件。
    同時に来た戻りの試験2件を含む。別に Sandbox 接続確認の口が7件）。
    2026-10-17 実測：`npx vitest run src/routes/restaurant-delivery.test.ts` → 100 passed。
    画面側は `src/v8/settings/delivery/delivery.test.tsx` → 16 passed。型検査は両方とも通ります。
- 通知の受け口は `apps/worker/src/routes/restaurant-delivery.ts`
  （`/api/restaurant-test/delivery/webhooks/:service`）。Uber Eats 向けの署名の確かめ方は
  **2026-10-16 に Uber の仕様へ差し替え済み**（詳細は 8-4(d)）。自社方式のサービスは従来の方式のままです。
- 設定画面（設定 › デリバリー連携）は**実装済み**。
  `apps/web/src/app/settings/delivery/page.tsx`／`apps/web/src/v8/settings/delivery/delivery.tsx`。
  基準は `新規デザイン/2026-10-12_デリバリー管理_デリバリー連携/デリバリー連携_v03.pen`
  （**2026-10-12 承認済み**・DL-1 `dF4Ov`／DL-2 `OIY4Z`／DL-3 `kJLks`／DL-4 `X5d8UF`）。
  飲食店向け（テスト）が使える環境だけに出ます。
  - **Uber Eats**：承認済みの DL-4 `X5d8UF`（つなぐお店を選ぶ）まで**中身がつながっています**。
    「つなぐ」→ Uber のログイン → 戻り → お店の一覧 → 確定、までが動きます。
  - **出前館・ロケットナウ**：承認された範囲のとおり「つなぐ」は**押せない状態**のままです。
    回答が来た会社から中身をつなぎます。

## 7. Uber 開発者ダッシュボードの進み（2026-10-17 時点）

利用者がダッシュボードを操作し、こちらは手順をご案内しています。秘密値（`client_secret`）と
Application ID はこの文書にも会話にも書きません。
2026-10-17 に利用者からダッシュボードの画面を3枚いただき、以下を読み取りました。
（画面には `client_id` と `client_secret` が写っていたため、値は一切書き写していません。
 同じ画像をこれ以上ほかへ共有しないよう利用者へお伝え済みです。）

| 手順 | 状態 |
| --- | --- |
| API Suite の選択（Eats Marketplace） | 済み |
| アプリの登録（musubo POS Integration／TEST APP） | 済み |
| 認証方式の選択（Client Secret） | 選択済み |
| Sandbox Access | **付与済み** |
| Integration Verification Requested | **緑（申請済み）** |
| 6手順のうち5つ | 緑（完了） |
| Integration Verification Result | **未完了**（残り1つ・Uber 側の審査待ち） |

### 7-1. 画面に出ていた権限（2026-10-17）

| 認証の種類 | 許されている権限 |
| --- | --- |
| `client_credentials`（アプリとして使う） | `eats.store`／`eats.report`／`eats.store.orders.read`／`eats.store.orders.cancel`／`eats.store.orders.restaurantdelivery.status`／`eats.store.status.write`／`eats.order` |
| `authorization_code`（店舗の代理で使う） | `eats.pos_provisioning` |

読み取れたこと。

- **つなぐお店を選ぶ流れに足りない権限はありません。** 一覧（`GET /v1/eats/stores`）と
  有効化（`POST /v1/eats/stores/{id}/pos_data`）は `authorization_code` の
  `eats.pos_provisioning` で行うため、`client_credentials` 側の権限を広げる必要はありません。
- 2026-10-16 に実機で得たトークンの権限が `["eats.order"]` 1つだけだったのは、
  こちらの下見の口が `UBER_PROBE_SCOPES`（`eats.order` のみ）で要求しているからです。
  **権限が足りないわけではありません。** 画面の一覧のほうが広いことが裏付けになります。
- Playground には「Token generation is not supported for sandbox apps」と出ます。
  つまり TEST APP のトークンは**画面からは作れず**、こちらの Worker の口から取るのが正しい手順です。
  （実際に 2026-10-16 01:43 JST に `client_credentials` のトークンを取得できています。§6-4）

## 7-2. 実機で出た認可エラー（2026-10-13）

staging（`https://stg-admin.musubo.jp/settings/delivery`）で Uber Eats の「つなぐ」を押したところ、
`auth.uber.com` へは遷移しましたが、認可画面ではなくエラー画面になりました。

```
https://auth.uber.com/oauth/errors?error=invalid_client
  &error_description=we+were+unable+to+fetch+client+metadata...
Authorization Error / Invalid client
```

### 切り分け（コードと設定の読み取りのみ。秘密値は見ていません）

| 確認したこと | 結果 |
| --- | --- |
| musubo 側が「設定が無い」と判断していないか | **設定はある**。`oauth_not_configured`（503）が出ず認可URLまで作れている＝`client_id`／`client_secret` は `nen-line-stg` に存在し空でない |
| 認可URLの組み立て | **公式仕様どおり**。`client_id`／`redirect_uri`／`response_type=code`／`scope=eats.pos_provisioning`（＋`state`）。`services/uber-eats.ts` の `buildAuthorizeUrl` |
| 設定の読み取り | **前後の空白は除去済み**（`uberOAuthClient` が `.trim()`）。改行混入による不一致は起きない |
| 戻り先URL | 不一致なら Uber は `redirect_uri` の文言で返すのが通例。今回の文言は「クライアントの情報を引けない」で別の種類 |

公式のエラー表（https://developer.uber.com/docs/eats/guides/authentication）では
`invalid_client` は「client ID または secret が不正。開発者画面で確認する」。
つまり **musubo 側のコードと配備設定の不具合は否定**され（Jev 判定 C＝1%）、
Uber の認可サーバが `client_id` を自分の登録簿から引けていない状態です。

### 残る原因候補（どちらも Uber 開発者画面の確認が必要）

| 候補 | Jev 判定 |
| --- | --- |
| **B：アプリがまだ `authorization_code`／`eats.pos_provisioning` で認可を受けられる状態になっていない**（Integration Verification・Scope Whitelisting 未了のため認可サーバ側にクライアントが未登録） | **64%** |
| A：`RT_DELIVERY_UBEREATS_CLIENT_ID` に入っている文字列が OAuth 用の Client ID ではない（別欄の Application ID をコピー、切れ、別アプリ） | 35% |

公式資料では本番の `eats.pos_provisioning` は「Uber Eats チームの承認とホワイトリスト登録が先」と
明記されており（§3・§5）、§7 の **Integration Verification Result が未完了**であることと符合します。

### 利用者の確認結果（2026-10-13）

Cloudflare の `RT_DELIVERY_UBEREATS_CLIENT_ID` へ入れた値は、Uber 開発者画面の
**`Client ID` という欄**からコピーしたものでした（値は確認していません）。
したがって候補 A（別欄の取り違え）は後退し、**候補 B が残ります**。

### 結論（2026-10-13 時点・この後 2026-10-15 に訂正）

当時は「**musubo 側に直す箇所はありません**。Scope Whitelisting 未了が原因」と判断し、
Integration Tech Support への依頼を次の1手としていました。

### 原因の訂正（2026-10-15）

**上の結論は誤りでした。musubo 側に直す箇所がありました。**

公式の Sandbox の手引き（§5-2）に、審査前の TEST APP は Sandbox のホストを使わねばならず、
**テスト用アプリで `auth.uber.com` を使うのは誤った組み合わせ**だと明記されています。
弊社アプリは TEST APP で `Sandbox Access Granted` が済んでいるため、認可を受けられない状態
ではなく、**向ける先が本番側だったために本番の登録簿から引けなかった**と読むのが筋が通ります。

当時の切り分けで見落としたのは次の2点です。

- 候補を A（値の取り違え）と B（Uber 側の未承認）の2つに絞り、
  **C：アプリの種類と接続先の不一致**を立てていなかった。
- 開発者画面に `Client ID` という欄は無く、あるのは `Application ID` と `Client Secret` です。
  §7-2 の「利用者の確認結果」が指す `Client ID` の欄は実在しないため、候補 A の後退も
  根拠が弱いままでした（なお `client_id` に Application ID を入れる前提自体は変えていません）。

したがって Integration Tech Support への依頼（下の下書き）は、**まず Sandbox で接続を試す前の
必須ではなくなりました**。残る用途は §4 の **Sandbox のテスト店舗の払い出し依頼**だけです。

次の1手は `RT_DELIVERY_UBEREATS_ENVIRONMENT=sandbox` を検証環境へ入れ、
`client_credentials` で Sandbox のトークンを1回取ることです（§8）。

### Integration Tech Support への依頼文（送信済み・以下は送った内容の記録）

> **この依頼は送信済みです。** 利用者が Integration Tech Support Form から送信しており、
> **2026-10-16 現在 Uber からの返信はありません**（送信日の記録は台帳に残していません）。
> 以下は送った内容の控えで、**これから送るための下書きではありません。再送は不要です。**

2026-10-13 版の下書きは「権限の許可（whitelisting）と Integration Verification を依頼する」
内容でしたが、原因が接続先の不一致だと分かったため**用途を1つに絞りました**。
いま頼むことは §4 の **Sandbox のテスト店舗の払い出し**だけです。
`Client ID` の欄は開発者画面に存在しないため、`Application ID` と書き換えています。
この依頼は Sandbox の接続確認（§8-6）より先に出す必要がなく、実際に §6-4 の
トークン1回の確認はこの返信を待たずに成功しています。

```
Subject: Request to provision a Sandbox test store

Company / Integrator: musubo (<legal entity name>)
Integration name: musubo POS Integration
App name in Developer Dashboard: <app name> (TEST APP)
Application ID: <paste from Developer Dashboard>
Region / Market: Japan
Contact: <email>

Current status
- API Suite: Eats Marketplace selected
- App registered, authentication method: Client Secret
- Sandbox Access Granted
- OAuth redirect URI registered:
  https://stg-api.musubo.jp/api/restaurant-test/delivery/ubereats/oauth/callback
- Implemented and unit-tested on our side: authorization-code flow (authorize URL,
  callback, token exchange, 30-day re-acquisition), GET /v1/eats/stores,
  POST/GET/PATCH/DELETE /v1/eats/stores/{store_id}/pos_data,
  webhook signature verification (X-Uber-Signature, HMAC-SHA256)
- Our client now targets the sandbox domains (sandbox-login.uber.com /
  test-api.uber.com) for this testing application.

Request
Please provision a Sandbox test store for this application so that we can complete
end-to-end testing (store listing, POS data activation, and order webhooks) before
requesting production access.
```

## 8. 残件と次の1手

1. ~~利用者が設計案（v03）を承認する。~~ → 2026-10-12 承認済み。設定画面も実装済み。
2. 開発者アカウント登録・NDA・API 利用契約・パートナー担当者の承認（利用者の署名が必要）。
   → ダッシュボード上は 6手順のうち5つが完了。残るのは Integration Verification Result。
   **これは本番アカウント（PRODUCTION APP）を開くための手順で、Sandbox の接続確認の
   前提ではありません**（§5-2）。`Sandbox Access Granted` は済んでいます。依頼の口は
   Integration Tech Support Form（`http://t.uber.com/integration-support`）で、
   Uber 立ち会いの通し試験を経て本番アカウントが開きます。
3. Sandbox のテスト店舗を Integration Tech Support へ依頼（上の控え）。
   → **送信済み**。2026-10-13 ごろのやりとりで利用者が Integration Tech Support Form から
   送信しており、**2026-10-17 現在 Uber からの返信はありません**（送信日の記録は残していません）。
   **再送・利用者への再依頼は不要**です。返信が来たら店舗IDを受け取ります。

   **この返信は残作業の前提ではありません**（§4 の訂正・2026-10-17）。
   店舗IDが実際に要るのは `GET /v1/eats/stores` の実データ確認と `POST /pos_data` の2つだけです。
   それ以外は返信を待たずに進めます。
4. ログイン連携の裏側（認可画面への受け渡し、戻り先の受け口、トークンの保存と30日ごとの更新、
   店舗一覧の取得、`POST /pos_data`）を実装。
   → **通信の層・設定の受け口・接続の保存先・認可の入口と戻り先まで実装済み**（上の 6 節）。
   (a) 店舗ごとの接続の保存先（移行 `636_restaurant_delivery_uber_connections.sql`：暗号化した
   トークン・期限・権限・Uber の店舗ID・状態・版。更新用トークンの欄は作らない）→ **済み**。
   (b) 1回使い切り・10分で切れる `state` の置き場 → **済み**。
   (c) 認可の入口と戻り先の受け口 → **済み**。
   (d) 受信の署名を Uber の方式へ差し替え
   → **済み（2026-10-16）。検証環境への配備と配備後確認まで完了**。詳しくは §8-4(d) と §6-5。
   (e) つなぐ店舗を選ぶ道（`GET /v1/eats/stores` の一覧→選択→`POST /pos_data`）
   → **済み（2026-10-17）。ローカル試験まで完了**（§6 の該当項目）。画面は 2026-10-12 に
   承認済みの DL-4 `X5d8UF` をそのまま使うため、新しい Pencil の承認は不要だった。
   残るのは、30日で切れるトークンの取り直しと、Sandbox／検証環境での実接続の確認。
5. ~~利用者が Cloudflare の画面で秘密設定**2件**を自分で登録する~~ → **済み**。
   `nen-line-stg` の Settings → Variables and Secrets に **Encrypted** で2件登録済み
   （値はエージェントを通していません。暗号化で入れているので再配備で消えません）。
   Uber のアプリ登録側の戻り先URLも利用者が設定済みで、上の1行と同じ文字列です。
   したがって上書きの変数 `RT_DELIVERY_UBEREATS_REDIRECT_URI` は使いません。
6. 最小の実接続（トークンを1回取得する）→ アプリ連携 → 異常系 → 検証環境での配備後確認、
   の順に1操作ずつ確認する。

   `RT_DELIVERY_UBEREATS_ENVIRONMENT=sandbox` の検証環境への配備は
   **済み**（Worker Version `d74cf03c-0062-4a60-90b5-aa6074ac32aa`）。

   進み具合（2026-10-16 時点）。
   最小の実接続（トークン1回）→ **済み**（§6-4）。
   受信の確かめ方の差し替えと検証環境での配備後確認 → **済み**（§8-4(d)・§6-5）。

   異常系の確認（503・403・413）→ **済み**（§8-5）。

   上の 3（Sandbox テスト店舗の払い出し依頼）は送信済みで Uber の返信待ちだが、
   **これを残作業全体の前提にしない**（§4 の訂正・2026-10-17）。
   返信が要るのは `GET /v1/eats/stores` の実データ確認と `POST /pos_data` だけ。

   ### 次の1手（2026-10-17・Uber の返信に依存しない順）

   | 順 | 作業 | 要るもの | 状態 |
   | --- | --- | --- | --- |
   | 1 | ~~つなぐ店舗を選ぶ画面を新しい Pencil で設計し承認を得る~~ | — | **不要だった**。2026-10-12 承認の DL-4 `X5d8UF` がその画面。新規UIではない |
   | 2 | つなぐ店舗を選ぶ道の実装（`GET /v1/eats/stores` の一覧→選択→`POST /pos_data`） | なし | **済み（2026-10-17）**。ローカル試験 100件／画面16件／型検査 |
   | 3 | 検証環境・Sandbox での実接続の確認（一覧が実データで取れるか、確定が通るか） | Uber のテスト店舗 | **Codex へ引き継ぎ**（遠隔は Claude が触らない） |
   | 4 | 30日で切れるトークンの取り直し（期限前の自動取得） | なし | 未着手 |
   | 5 | 注文の通知を受けてデリバリー受注の台帳へ取り込む経路の試験 | なし（模擬の本文で確認） | 未着手 |

   1 を「新規UIなので承認が先」としていたのは誤りで、承認済みフレームの中身をつなぐ作業でした
   （2026-10-17 訂正）。
   4 の対象である §6-4 のトークンは 2026-10-16 取得・有効 2,592,000 秒で
   **期限は 2026-11-15 ごろ**。実害が出る前に入れる。

   出前館 手順2（連携希望の連絡）は Uber とは独立に並行して進む。

   ### 6-1. 接続確認（トークン1回）の口

   Application ID と Client Secret は Cloudflare の暗号化された秘密設定で読み戻せないため、
   外から `curl` で叩くには秘密値を取り出すことになる。取り出さずに
   **「配備先の中から1回だけ送る」** ための口を用意した。画面は持たない。

   - 宛先: `POST /internal/ubereats/sandbox-token-probe`
   - 守り: 合言葉 `RT_DELIVERY_UBEREATS_PROBE_SECRET`（32文字以上）の HMAC-SHA256 署名。
     見出しは `x-nen-timestamp`（通算秒10桁）と `x-nen-signature`（`${timestamp}.${body}` の16進）。
     合言葉が使えないときは 503、署名違い・時刻が5分以上ずれていれば 401 で、送らない。
   - 合言葉が使えない理由は 2026-10-16 に分けた（§6-3）。`probe_secret_missing` は
     その要求を受けた配備先に値が届いていない、`probe_secret_too_short` は値はあるが
     32文字未満。**長さも値も返さない**（この分岐は署名の確認より前に通るため）。
   - 本文が `{"mode":"check"}` のときは**下見**。署名を確かめたあと、Uber へは送らずに
     接続先（`sandbox` / `other` / `unknown`）と OAuth の設定が揃っているかだけを返す。
     トークンの口の回数も冷却時間も使わないので、合言葉と署名の確認を何度でも行える。
   - 接続先が Sandbox でないときは 403 で止める。**本番の Uber へは送らない。**
   - 冷却時間10分。送る**前**に時刻を残すので、途中で落ちても1回分として数える
     （Uber のトークンの口は1時間100回まで）。
   - 返すのは `success` / `environment` / `scope` / 残り秒だけ。失敗時はHTTP状態と
     分類済みの符号だけ。**トークンの値と Client Secret は返さない・記録しない。**
   - 実装: `apps/worker/src/services/ubereats-token-probe.ts`、
     口は `apps/worker/src/routes/restaurant-delivery.ts`。

   ### 6-2. 検証環境で1回実行した結果（2026-10-16 00:21 JST）

   PR #1736 をマージし、Git SHA
   `008063dac1d9fb1c8ed8969f565291b8b7cd7072` を Worker と管理画面へ配備した。
   配備 run は `38758489168` で成功し、両方の公開SHAも一致した。

   検証Workerに32バイトの乱数から作った
   `RT_DELIVERY_UBEREATS_PROBE_SECRET` を暗号化した秘密設定として登録した。
   値は表示・記録していない。登録で作られた Worker Version
   `1e9c043e-7976-4545-a29a-e6b7378a0049` は100%配備中で、読み取り確認では次が揃っていた。

   - 上の Git SHA
   - `RT_DELIVERY_UBEREATS_ENVIRONMENT=sandbox`
   - 既存の Application ID / Client Secret と、新しい probe secret の**名前**

   その直後、本文を `{}` の2文字にし、現在時刻と
   `${timestamp}.{}` の HMAC-SHA256 署名を付けて**1回だけ** POST した。
   応答は次のとおりだった。

   ```json
   {"httpStatus":503,"success":false,"code":"probe_not_configured"}
   ```

   この符号は、署名の検査や Uber への送信より前の「probe secret を使えない」分岐で返る。
   そのため、**Uber のトークン取得口へは到達しておらず、`scope` も未確認**。
   停止条件に従って再送は行っていない。トークン、Client Secret、
   probe secret の値は応答・ログ・リポジトリのどこにも残していない。

   **次の1手**：100%配備中の版に秘密設定の名前がある一方、
   登録直後の実要求だけが未設定応答になった原因を切り分ける。
   原因を確定してから、別の明示的な再検証として次の1回を行う。
   この失敗記録に対して盲目的に再送しない。

   ### 6-3. `probe_not_configured` の切り分け（2026-10-16）

   **コード側は原因ではない**（読み取りで確定）。

   - この符号は `routes/restaurant-delivery.ts` の合言葉の分岐だけが返す
     （文字列はこの口とその試験にしか無い）。したがって要求は新しい束を積んだ
     Worker に届き、飲食店向け（テスト）の判定も通り、合言葉だけが読めなかった。
   - 「`src/index.ts` の環境変数の型に `RT_DELIVERY_UBEREATS_PROBE_SECRET` を
     書き忘れたせいで値が隠れた」という見立ては**外れ**。`src/index.ts` の既定の書き出しは
     `fetch: app.fetch` で、環境をそのまま渡しており絞り込みも作り直しもしていない。
     型の宣言は動くときの振る舞いに影響しない。
   - 残る候補は配備側で、こちらからは読めない。(a) POST の宛先ホストを受けている Worker が
     秘密設定を入れた Worker と別、(b) `wrangler secret put` の直後で版の入れ替わりが
     間に合わず前の版が応答した、(c) 作った値が符号化・空白落としのあと32文字未満、
     (d) 名前の綴り違い。

   **直した内容**：どれが起きているかを応答そのものから分かるようにした。

   1. 503 を `probe_secret_missing`（値が届いていない）と
      `probe_secret_too_short`（32文字未満）に分けた。長さと値は返さない。
   2. 下見の本文 `{"mode":"check"}` を足した。署名を確かめたあと **Uber へは送らず**、
      冷却時間も使わずに接続先と設定の有無だけを返す。これで
      「合言葉と署名は通るのか」を、Uber の1時間100回の口を使わずに確かめられる。

   **次の1回の手順**（Codex 担当・この順で）。

   1. POST と**同じホスト**へ `GET /api/health`。どの Worker が応答しているかを突き合わせる。
   2. `RT_DELIVERY_UBEREATS_PROBE_SECRET`（32文字以上）を入れ直し、版が入れ替わるのを待つ。
   3. 本文 `{"mode":"check"}` で署名付き POST。Uber へは送られず冷却時間も使わない。
      `probe_secret_missing` / `probe_secret_too_short` が返れば上の候補が絞れる。
   4. 3 が `success: true` で `environment: "sandbox"` のときだけ、本文 `{}` で実のトークン取得を1回。
      失敗したら再送せず、HTTP状態と `code` / `uberCode` / `status` を返す。

   ### 6-4. Sandbox の実トークン取得に成功（2026-10-16 01:43 JST）

   PR #1739 をマージし、Git SHA
   `af2c2bf0e6ab339e4722fc8607b5a4d3ecf4b08b` を Worker と管理画面へ配備した。
   配備 run `38770186820` は成功し、両方の公開SHAも一致した。
   Worker Version は `95e674a7-e188-4ed4-8e9d-2bc81ab057d0`。

   指定順で次を確かめた。

   1. POST と同じ `https://stg-api.musubo.jp` の `GET /api/health` は HTTP 200 で、
      `git_commit` は上のマージSHAと一致した。
   2. 32バイトの乱数から probe secret をメモリ内で作り直し、
      検証Workerの暗号化された秘密設定へ登録した。値は表示・保存していない。
      登録で作られた Version `d5c4f5be-0e81-42ca-9ad5-69049b2e49df` が100%になり、
      マージSHA、`sandbox` 設定、3つのUber関連secretの名前が揃っていることを確かめた。
   3. 本文 `{"mode":"check"}` の署名付きPOSTは HTTP 200 で次を返した。
      この下見は Uber へ送らず、冷却時間も使っていない。

      ```json
      {"success":true,"mode":"check","environment":"sandbox","oauthConfigured":true}
      ```

   4. 下見の成功後だけ、本文 `{}` で実のトークン取得を**1回だけ**実行した。
      HTTP 200、`success: true`、`environment: "sandbox"`、
      `scope: ["eats.order"]`、`expiresInSec: 2592000` だった。
      トークン値、Client Secret、probe secret、署名値は会話・ログ・Gitへ残していない。
      再送も行っていない。

**Sandbox の `client_credentials` による最小の実接続は成功しました。**
利用者のログインを伴う認可画面と、実際の注文API操作は別工程であり、今回は実行していません。

### 8-4(d). 受信の署名を Uber の方式へ差し替えた（2026-10-16）

Uber から届く注文の通知を「本物か」確かめる方法が、これまで自社の方式のままだった。
公式仕様と違うので、実物の通知は**すべて 401 で落ちる**。これを Uber の方式へ合わせた。
画面は作っていない（受け口の中だけの変更）ので、新しい Pencil の承認は要らない。

**Uber の方式**（公式仕様）。

- 見出しは `x-uber-signature`。
- 署名は**本文だけ**の HMAC-SHA256（小文字16進）。自社方式のように時刻を混ぜない。
- 鍵は同じアプリの **Client Secret**。静的なトークン用の合言葉
  `RT_DELIVERY_UBEREATS_WEBHOOK_SECRET` は Uber では**使わない**（設定しても無視される）。
- Uber は時刻の見出しを送らないので、**時刻のずれ（±5分）は見ない**。
  見てしまうと本物の通知を落とすため、この確認は Uber だけ外した。

**変えていないところ。**

- 出前館・ロケットナウは自社の方式（`x-nen-timestamp` と `x-nen-signature`、
  `${通算秒}.${本文}` の署名、±5分のずれ確認）をそのまま使う。
- 送信元IPの許可確認は、鍵を読む前・署名を確かめる前のままにした。
- 接続確認の口 `POST /internal/ubereats/sandbox-token-probe`（§6-1）は
  Uber からの通知ではなく自社からの呼び出しなので、`x-nen-*` の方式を変えていない。

**実装**。サービスごとの違いを1か所に閉じるため、受け口の外へ切り出した。

- 新規: `apps/worker/src/services/delivery-webhook-auth.ts`
  （`deliveryWebhookSigningSecret` で鍵を選び、`verifyDeliveryWebhook` で確かめる）
- 受け口: `apps/worker/src/routes/restaurant-delivery.ts` はこの2つを呼ぶだけになった
- 署名の計算そのものは既存の `apps/worker/src/services/uber-eats.ts`
  （`UBER_SIGNATURE_HEADER` / `verifyWebhookSignature`）を使う

**確かめた範囲**（ローカル試験）。Uber の本文だけの署名を受け取ること、時刻の見出しが
古くても落とさないこと、鍵違い・本文改変・自社方式の見出しだけでは受け取らないこと、
出前館・ロケットナウの受け取り方が変わっていないこと。

**まだ済んでいないこと**。Uber から**実物の通知を受け取る**確認は、Uber 側の
Sandbox テスト店舗（上の 3）が用意されてからになる。それまでは試験までの確認に留まる。

**配備**。PR #1741 が必須CI全緑でマージされ、検証環境へ配備済み
（Worker Version `9881e594-c509-4ea7-943c-3b9911e64b4a`、100%）。
配備後の確認で分かったことは次の 6-5 に書いた。

### 6-5. 接続確認の口の合言葉は、呼ぶたびにその場で作り直す（2026-10-16）

上の配備のあと下見（`{"mode":"check"}`、§6-1）を実行したら
HTTP 401 / `probe_unauthorized` が返った。**これはコードの不具合ではない。**

- 401 は「合言葉は届いているが、呼ぶ側の署名が合わない」ときの答え。
  合言葉が配備先に無い・短いときは、署名を確かめる前の分岐で
  503（`probe_secret_missing` / `probe_secret_too_short`）が返る（§6-3）。
  401 が返ったことは、**合言葉が配備先にちゃんと入っている**証拠でもある。
- 合わなかったのは呼ぶ側の署名。§6-4 の 2 の通り、この合言葉は
  32バイトの乱数からその場で作り、**表示も保存もしていない**。
  だから後の別の作業から呼ぶとき、呼ぶ側は正しい署名を作れない。これは設計どおり。
- 直し方は「保存した値を探す」ではなく「その場で作り直して使い捨てる」。
  この口を使うときは**ひとつの作業の中で**、(a) 新しい合言葉を作る →
  (b) 配備先の秘密設定へ登録し、版が100%になるのを待つ → (c) 署名して呼ぶ →
  (d) 値は残さない、の順で行う。値を人やエージェントの間で受け渡さない。
  §6-4 の実トークン取得が成功したときも、この順で行っている。
- なお 8-4(d) で差し替えたのは Uber からの**受信**の確かめ方で、
  この口が使う確かめ方（`x-nen-*`）とは別のしくみ。401 と 8-4(d) は関係がない。

**合言葉を使わずに 8-4(d) の配備を確かめる方法**（下見より先にこちらを使う）。
受信口は「鍵が読めない → 503、読めて署名が違う → 401」の順に答える
（`apps/worker/src/routes/restaurant-delivery.ts` の受け口）。
`ubereats` の鍵は同じアプリの Client Secret から取るので、
**署名を付けずに** `POST /api/restaurant-test/delivery/webhooks/ubereats` を叩くと、

- **401 `Invalid signature`** → Uber の連携設定（Client ID・Client Secret・
  `https://` の戻り先）が読めていて、差し替えた確かめ方が動いている。
  下見の `oauthConfigured: true` と同じことが分かる。**これが期待する答え。**
- 503 `Integration is not configured` → 上の設定のどれかが足りない。
- 403 `Forbidden` → 送信元IPの許可一覧が設定されている（IPの確認が先に動いた）。

この確認は合言葉が要らず、Uber へも何も送らず、注文台帳にも何も残らない
（署名が合わないので本文を読む前に止まる）。
`demaecan` で 503 が返るのは合言葉が検証環境に無いだけで、今回の変更とは関係ない。

**実行した結果（2026-10-16）。期待どおり 401 だった。**

- 記録を取り込んだ PR #1742 が必須CI全緑でマージ。マージSHA `b4adb688bd42c359d1539dbf802b5ad888a9e647`
- 検証環境へ配備（run `38791222280`、成功）。Worker・管理画面の公開SHAがマージSHAと一致。
  `GET /api/health` は HTTP 200 / `status: ok`
- 署名の見出しを付けず本文 `{}` で
  `POST /api/restaurant-test/delivery/webhooks/ubereats` を**1回だけ**実行
  → **HTTP 401 / `{"success":false,"error":"Invalid signature"}`**
- つまり Uber の連携設定が読めていて、8-4(d) の確かめ方が検証環境で動いている。
  合言葉の作り直し・実トークンの取り直しは行っていない。

これで 8-4(d) は「実装 → ローカル試験 → 配備 → 配備後確認」まで揃った。
残るのは Uber から**実物の通知**を1件受け取る確認で、これは Uber 側の
Sandbox テスト店舗（§8 の 3）が用意されてからになる。

### 8-5. 異常系（503・403・413）の確認（2026-10-16）

共通ルールの「必要な異常系」にあたる確認。**検証環境へは何も書かず、ローカル試験だけ**で
確かめた。受け口は `POST /api/restaurant-test/delivery/webhooks/:service`。

**断る順番**（`apps/worker/src/routes/restaurant-delivery.ts` の受け口。先に当たった方が返る）。

| 順 | 条件 | 答え |
| --- | --- | --- |
| 1 | 知らないサービス名 | 404 `Unknown service` |
| 2 | 送信元IPの許可一覧があり、その外から届いた | 403 `Forbidden` |
| 3 | そのサービスの署名の鍵が無い・短い | 503 `Integration is not configured` |
| 4 | 本文が上限（128KiB）を超えている | 413 `Payload too large` |
| 5 | 署名が合わない（自社方式は時刻ずれも） | 401 `Invalid signature` / `Expired request` |

どれで断っても**本文の取り込みと受信台帳 `rt_delivery_events` への記録は行わない**。
403 のときは本文を読む前に止まる。

**確かめた結果。**

- **503**（設定不足）。既存の試験で合格済み。
  「鍵が設定されていないサービスは503で断り、署名の判定へ進まない」。
  正しい署名を付けても鍵が無ければ 503 になり、台帳は0件。
- **403**（送信元IP不許可）。既存の試験で合格済み。許可外のIP・送信元が分からない通知・
  まとまり指定（`/24`）の外・サービスごとの指定が共通指定より先に効くこと、
  さらに「鍵が無くてもIPの確認が先なので 403 になる」ことまで含む。
- **413**（本文が大きすぎる）。**試験が無かったので今回5件足した**
  （`apps/worker/src/routes/restaurant-delivery.test.ts` の
  「受信口の本文の大きさの上限（413）」）。受け口の動きは元から正しく、
  足したのは**動きを固定するための確認の試験だけ**。コードは変えていない。
  - 申告（`content-length`）が上限超えなら、本文を読まずに 413
  - 申告が無くても、実測が上限超えなら 413（台帳は0件）
  - 上限ちょうどは大きさでは断らない（200 で受け取る）
  - 署名が違っても、大きすぎれば先に 413
  - 鍵が無いときは大きさより先に 503（上の順番どおり）

**記録**。Worker 全試験 **988ファイル / 11,806件 合格**、`tsc --noEmit` 合格、
コード量の検査 `2674 body files, 437 frozen, 0 violations`。
上限の値 128KiB は `apps/worker/src/services/delivery-webhook-payload.ts` の
`MAX_WEBHOOK_BODY_BYTES` を試験からも読んでいるので、値を変えても食い違わない。

**この確認に Uber の返信は要らない。** 配備も不要（試験1ファイルの追加のみ）。
