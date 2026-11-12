> 文書：運営 ログイン 2段目の動き（BEHAVIOR.md）｜区分：今の説明｜最終確認：2026-10-26（日本時間）

# 運営 ログイン 2段目の動き（BEHAVIOR.md）

対象：`app/login/two-factor/page.tsx` から開く `two-factor-ops.tsx`。絵は `tOPeY`「6桁の確認」。

## 入口
- `app/login/two-factor/page.tsx`：運営のログインから来たとき（`isOpsTwoFactorReturn`：`?next=ops`・hash の `lh_next=ops`・sessionStorage の `lh_2fa_next=ops`）だけ `@/v8/login/two-factor-ops` を出す。
- 管理画面のログインの2段目は `two-factor-admin.tsx`。戻り先の判定が終わるまでどちらも表示しない。

## 受け付ける URL と指定
- `/login/two-factor?next=ops#lh_2fa=<合言葉>&lh_method=password`（今と同じ）。合言葉は sessionStorage `lh_two_factor_challenge` に移し、hash は消す（`captureTwoFactorChallenge`）。

## 読み書き（API）
- `POST /api/auth/two-factor/verify`（`challengeToken`・`code`）。返った `sessionToken`・`csrfToken` を今と同じ場所へ保存。
- 運営へ戻す前に `GET /api/auth/session` で運営権限を確かめる。`awaiting_totp` なら `/ops/two-factor`（2要素認証を設定）へ、権限が無ければ理由の文を出す。

## 失敗のとき
- 6桁そろっていない・違うコード・通信断：6マスの下の1行を赤くして理由を出す（role=alert）。違うコードのときは6マスを空にして1マス目へ。
- 確かめている間・通った後も6マスは薄くせず数字を残す。通ったら枠が緑、下の1行は「確認できました。開いています…」、ボタンは緑のまま回る印と「開いています」。マスのそばに ✓ は出さない。
- 合言葉が無いまま開いたとき：青の帯に「ログインに戻る」（`/ops/login`）。6マスとログインは押せない。

## カードの頭
- 管理画面・運営・設定・ログインの1段目とも、カードの頭に会社の印と会社名（運営は musubo／運営）、右に「1 / 2」「2 / 2」。管理画面の2段目のカードの下は左「コードが使えない場合」、右「別のアカウントで入る」（ログインの1段目へ戻り、合言葉は捨てる）。

## 絵との違い
- 絵の説明文の頭にあるメールアドレス（`owner@example.com でパスワードを確かめました。`）は出さない。運営のログイン（1段目）から2段目へメールアドレスを渡す口が無いため。渡すなら運営のログインの画面で sessionStorage に置き、ここで読む。
