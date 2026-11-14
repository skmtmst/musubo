> 文書：V8 で足した決まり（要件）の索引｜区分：今の正本｜最終確認：2026-10-19（日本時間）

# V8 で足した決まり（要件）の索引

- 作成: 2026-10-07。V8 の絵で増えた機能・お客さまの画面（LIFF）・本番の切り替えの「決まり」を、司令塔の手元の依頼書・仕様から本線へ写したもの。Codex・作業役が本線だけで読めるようにする。
- 動きの正本は、既存の 34 機能は `docs/v6-requirements/v6-requirements-master-index.md`、V8 で足したものはこのフォルダ。見た目は Pencil ★V8 の絵（`docs/v8-design-rules.md`）が勝つ。
- 依頼の進め方・作業の記録（枝・作業場所・担当）は写していない。

| 文書 | 中身 |
|---|---|
| [v8-switch.md](v8-switch.md) | 本番を V8 にする条件・V8 に固定する3段（B-124）・出す日の手順・巻き戻し（**正はこの文書**） |
| [v8-feature-additions.md](v8-feature-additions.md) | 機能追加 F-1〜F-25（オーナー採用 2026-10-02）の決まり |
| [v8-booking-additions.md](v8-booking-additions.md) | 予約の追加（前回と同じ・キャンセル待ち・今日の予約・売上・無断キャンセル・写真）、予約経路と枠の自動調整（F-24・F-25）、店のキャンセル待ち（F-6） |
| [v8-liff.md](v8-liff.md) | お客さまの画面（LIFF）28 枚の決まり・見た目の型・カレンダー・決済の準備 |
| [terms.md](terms.md) | 画面に出す言葉の表（動作・状態・もの・数、スタイルごとの言い換え、LIFF と管理画面の違い）。B-345 の正本 |
| [styles.md](styles.md)・[styles-gaps.md](styles-gaps.md) | 6つのスタイルの登録・初期セット・ダッシュボード・メニュー・LIFFと文面・ボタンの行き先・受け入れ、不足と既存API/DBへの接続（B-391） |
| [cleanup-stage2-contract.md](cleanup-stage2-contract.md) | B-353→B-361→B-366 の順序と入口、B-358 の店舗設定・署名、B-365 の再試行・結果不明・サガ・cache の共通契約 |
| [form-file-attachments.md](form-file-attachments.md) | 回答フォームの書類の添付（写真・PDF・本人確認書類、B-176）の決まり・検査・保存期限・権限 |

## 共通の決まり
- 自動で送る LINE（知らせ・案内）には `X-Line-Harness-Source: manual` を付けない。担当者の1対1返信だけに付ける。検証環境の送信止めに従う。
- 取れない数字は 0 にしない。未取得は null を返し、画面は「—」。
- 版のある設定の保存は、版の競合を 409 で返す。
- migration は番号ごとにオーナー承認。検証 D1 への適用は司令塔、本番は対象外。
- 権限で使えないボタンは隠さず、灰色の押せないボタン＋理由の吹き出しで出す（2026-10-26 オーナー。`docs/v8-design-rules.md` §2）。
  - `behavior/` の受け入れ表・`gap-features/`・`styles.md` などに残る「閲覧のみ（権限の無い人）には操作を隠す・置かない・出さない」は、この決まりで**灰色＋理由**と読み替える（受け入れ表の「起きてはいけないこと」にある「押せない形のボタンが並ぶ」も同じく読み替え、代わりに「押せて処理が動く・押すと 403」を不合格とする）。電話番号などの**データ**を見せない記述と、API が 403 で断る記述はそのまま。（2026-11-14 A15 手動テストの手順表の食い違い 1）
- 整理の段2の決定・契約は [共通契約](cleanup-stage2-contract.md) を参照する。B8（Google で予約）は入口も準備中の表示も出さない（B-353）。Google カレンダー・Meet・Google ビジネスは別機能として保つ。

## 報告から移した契約（2026-10-11）

- [restaurant-fusion3-contract.md](restaurant-fusion3-contract.md)：承認した共通シナリオから予約ごとに送る・前日の返事。
- [restaurant-fusion4-contract.md](restaurant-fusion4-contract.md)：席予約・回答後の予約・参加許可のある系列店の紹介。
- 保存記録を残す削除は [form-file-attachments.md](form-file-attachments.md) §12、共通操作は `docs/v8-design-rules.md`、配備・速度の確認は `docs/brain/Memory.md`。
