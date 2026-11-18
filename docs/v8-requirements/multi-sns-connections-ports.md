> 文書：Googleビジネス・Instagram 複数連携で足りない3つの口の契約｜区分：今の正本｜最終確認：2026-11-18（日本時間）

# 複数連携：3つの口の契約（契約枠・主連携・請求）

- 作成: 2026-11-18。[multi-sns-connections.md](multi-sns-connections.md) 第1段のうち「課金接続」が残っているため、画面が必要とする口の入出力をここで決める。
- 担当は要件 §6 のまま変えない。**Worker・API型・課金 = Codex／画面・文書 = Claude**。この文書は画面側が必要とする形を書いたもので、サーバー側の作り方は決めていない。
- 金額の数え方の正本は `packages/shared/src/musubo-pricing.ts` の `linkedAccountSlots`。画面でも口でも数え直さない。

## 1. 今の状態（2026-11-18 実測）

できていること:
- 設定→SNS連携の画面（一覧・カード・解除・「連携 n個（契約枠 m個）」の表示）は検証環境へ配備済み（`57dd929cf9`）。
- `packages/db/migrations/769_musubo_contracted_linked_slots.sql` で `musubo_line_usage.contracted_linked_slots`（既定 1・`CHECK (>= 1)`）を足し、検証 D1 へ適用済み。

できていないこと:
- 769 の列を**アプリのコードはまだ誰も読んでいない**（`packages/db` の bootstrap と 769 の試験にしか出てこない）。
- 画面は口が無いぶんを固定値で動かしている。
  - `apps/web/src/v8/settings/sns/sns.tsx:74` … `const BILLING: SnsSlotBilling | null = null`
  - `apps/web/src/v8/settings/sns/connection-slots.ts:84` … `SNS_DEFAULT_CONTRACTED = 1`
  - このため枠を超える追加は `billing-unknown` で押せない状態になり、絵の F3 `q9hcp9`・F4 `uB88I`・F5 `R4dYE` は**実画面に出ない**（部品の試験では描けている。`slot-dialogs.test.tsx`）。
- DB に単一接続の制約が残っていて、複数接続そのものが入らない。
  - `446_restaurant_google_business.sql:8` … `rt_google_connections.store_id TEXT NOT NULL UNIQUE`（1店舗1接続）
  - `447_restaurant_google_profile.sql:8` … `store_id TEXT PRIMARY KEY`
  - `603_instagram_connections.sql:8` / `754_instagram_shared_within_tenant.sql:5` … `instagram_connections.line_account_id TEXT PRIMARY KEY`（1 LINEアカウント1 IG接続）
- したがって **F5（接続10件）と枠超過（F3・F4）は、この制約を外さないと実データで再現できない**。制約を外す table-rebuild は [README](README.md) の共通の決まりどおり **migration 番号ごとにオーナー承認**が要る。

## 2. 口1：契約枠

- 要件の根拠: §5-Q6'。契約枠は LINEアカウントごとに**1つの数**（既定 1 = 1 + 購入した枠数）で、Google・Instagram の両方に同じだけ効く。
- 返す値: `contracted`（整数・1以上）= `musubo_line_usage.contracted_linked_slots`。
- 画面の使い所: `SnsSlotsView.contracted`（今は `SNS_DEFAULT_CONTRACTED` で代用している所）。
- 組み立ては既にある **LINEアカウント追加**の口 `/api/hq/billing/musubo/line-addition`（`apps/web/src/lib/api/features/musubo-line-addition.ts`）に合わせる。あちらの `contractedLineCapacity` と同じ位置づけの値。
- `/settings/sns` は**店舗側の画面**なので、HQ 専用の口をそのまま店舗画面から叩かない。店舗側から読める口が要る。権限は現行どおり owner/admin。
- 取れないときは 0 にせず、画面は今の既定（1）のまま動かす。少なく見せて料金の確認を飛ばす側へ倒さない。

## 3. 口2：主連携

- 要件の根拠: §5-Q2（主連携1件を正本・既定は1件目）と 2026-11-16 の追加決定「**主連携は Google 接続のみに設ける**」。
- 画面側は `SnsConnectionList` に `onSetPrimary` が渡されたときだけ行の中に［主連携にする］を出す。出す条件は「接続が2件以上」かつ「その行が主連携でない」。
- 必要なもの:
  - 接続一覧の各行に、どれが主連携かが分かる値。
  - 主連携を切り替える口（対象の Google 接続を指定する）。版のある設定なので、版の競合は **409** で返す（README 共通の決まり）。
- 営業時間の正本が主連携に従う所（§7 第3段 条件8）はこの文書の範囲外。

## 4. 口3：請求の段

- 画面が必要とする形は既に型で決まっている（`connection-slots.ts`）。
  ```
  SnsSlotBilling = { kind: 'trialing' }
                 | { kind: 'paid'; monthlyDaysRemaining: number; monthlyDaysInPeriod: number }
  ```
- **日付と残り日数はサーバーの値だけを使う**。画面で利用者の時計から作らない（`BEHAVIOR.md:63`・AGENTS.md §15）。
- 前例の `line-addition` は `monthlyPeriod { start, end }` を返している。同じ形にするなら、残り日数をサーバーが出すか、サーバーの「今」も一緒に返す。どちらでもよいが、**画面が引き算の基準を自分で決めない**形にする。
- 無料期間中は `trialing`。要件 §7 第1段 条件3 のとおり、無料期間中の今回の支払いは ¥0、終了後の月額は出す。
- 取れないときは `null` のままにする。今の `billing-unknown`（枠内の追加はそのまま進み、枠超過の追加だけ押せない状態＋理由）を残す。**0 や架空の金額を画面で作らない。**

## 5. 口が入った後に画面側（Claude）が繋ぐこと

- 受け入れ条件は要件 §7 第1段の **2・3・4** をそのまま使う。
- 口が無い・落ちている・権限が無いときは、今の `billing-unknown` と既定の契約枠に戻す。口の不在で画面が壊れないようにする。
- 繋いだ後に F3 `q9hcp9`・F4 `uB88I`・F5 `R4dYE` を**実画面で**確認し、承認済み Pen v9 と照合する（部品の試験だけで済ませない）。

## 6. この文書でやらないこと

- 実際の課金処理・本番 DB への適用・本番配備は範囲外。
- 単一接続の制約を外す migration の設計と番号決めは Codex 側。番号ごとにオーナー承認が要るので、承認前に適用しない。
