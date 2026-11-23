> 文書：設定と計測のAPI｜区分：今の説明｜最終確認：2026-10-19（日本時間）

# 設定と計測のAPI

一覧はWorkerのOpenAPI、型は `packages/shared`、管理側の呼び出しは `apps/web/src/lib/api.ts` を確認します。全件の対象を決めてから集計・ページ送りを行い、未取得を0にしません。

| 機能 | 口と使い方 |
| --- | --- |
| 広告の成果対応 | GET `/api/ad-platforms/mappings`・PUT `/:pointId`。媒体別に`mode:auto/manual/off,eventName,googleActionId,expectedVersion`。owner/adminが可視アカウントで変更 |
| 流入経路の集計 | GET `/api/entry-routes/:id/funnel`。最初の流入の友だちだけ。残人数・ブロック・成果金額・月別内訳を返す。分母0の金額はnull |
| 送り先の束 | POST `/api/traffic-pools`。`slug,name,activeAccountId,accountIds`。owner限定。全所属を確認して原子的に保存し、稼働中の所属から送り先を選ぶ |
| はじめの案内 | GET `/api/getting-started?version=v8`。接続→初期セット→分類→追加時配信→シナリオ→実送達。保存と実送達で完了を判定 |
| 通知チーム | `/api/notifications/teams` のGET/POST/PUT/DELETE。アカウント・名前・staffIds・版。公開時0人不可。通知時は現在の所属を解決 |
| 店舗の時間帯 | PUT `/api/line-accounts/:id` の`timezone`。owner限定。IANAの時間帯を検査し、資格情報と既存予約時刻は変えない |
| ECの未一致候補 | GET `/api/ec-commerce/identity-candidates`。見込み売上は同じEC会員を1回だけ数える。件と人を差し引かず、未知の金額はnull |
| 掲載の閲覧数 | POST `/api/integrations/eccube/events` の`ec.site.publication_viewed`。UTCの`view_date`とその日累計`view_count`を送り、日別最大値の30日分を集計 |
| 配信の期間 | GET `/api/broadcasts` の`from/to`。日本時間の暦日、片側省略可。配信日の順は送信→予約→作成。状態件数も同期間 |
| 自動応答の期間 | GET `/api/auto-reply-runs` の`from/to`。一覧・件数・集計・トリガー内訳・CSVを同期間にする |
| 成果1件の広告費 | GET `/api/ad-costs` のアカウントと期間。成果0件・円以外混在は金額null |
| 友だちの前月差 | GET `/api/friends/stats`。前月末の有効人数と現在との差。過去記録のない期間はnull |
| 会場 | イベント作成・更新の`venue_address,venue_url`。保存前の見本は入力だけで、未保存のイベントを公開しない |
| 写真の掲載順 | GET/PUT `/api/nen-members/photos/publications/order`。全IDと版、最大5000件。集合か版が変われば全件を409で拒否 |
| 掲載の追加報酬 | POST `/api/nen-members/photos/:id/publish` に`expectedVersion,Idempotency-Key`。報酬版の`publicationPoints`は0〜100000、省略は保持 |
| サイトと広告接続 | サイトの`lastReceivedAt`。広告の作成・変更・`connect`・`cost-import`。外部の費用読取が成功した時だけ接続済み |

広告の対応は購入・定期・予約などを媒体のイベントへ解決し、成果発生時の所属と対応を固定します。未対応を送らず、既存の重複送信防止を使います。過去の成果へ遡って送りません。Googleのaction IDは手入力か連携設定を使い、外部の名前を取得したふりをしません。

掲載閲覧の再送・逆順は重複加算しません。日付なしの旧入力は生涯累計だけへ入れ、30日値へ混ぜません。署名・所属・停止設定を維持します。受信失敗503は同じevent IDで再試行できます。

写真の掲載と報酬予約は原子的に保存します。初回の掲載時点の報酬版と0点も固定し、再掲載で増やしません。掲載が採用より先なら、採用時にも同意と掲載状態を確認します。採用報酬と掲載報酬は別々に各1回。既存の掲載へ遡及しません。配送はECの既存署名と送信キーを使い、成功済み・恒久失敗を自動再送しません。

自動応答のひな形からタグ・担当者通知を選ぶ時は、公開時に選択・所属・版を検査します。下書きは未選択でも保存できます。画面の表示だけで接続・送達・公開の成功と判断しません。

期限通知の Web Push は既定で停止しています。検証環境でのみ `DEPLOY_ENV=staging`、`INBOX_SLA_PUSH_ENABLED=true`、`INBOX_SLA_PUSH_TEST_STAFF_IDS` に検証用の担当者 ID の JSON 配列を明示した場合に送ります。担当者の「担当の会話に返事」通知設定・アカウント権限と現在の割り当てを送信直前に確認します。期限から24時間を超えた通知と静かな時間帯の通知は画面内に残し、プッシュは行いません。送達不明は再送せず、429・5xx の明示的な失敗は検証条件を再確認して再試行します。画面内の通知は残ります。
