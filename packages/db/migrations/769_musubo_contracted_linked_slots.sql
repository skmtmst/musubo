-- 契約枠（2026-11-16 利用者決定 Q6'）。
--
-- 基本料金に Google・Instagram 各1個ぶんが入る。追加枠1枠（¥3,300税込）で
-- 両サービスが各1個ずつ同時に増えるので、契約枠はサービス別の2つの数ではなく
-- LINEアカウントごとに1つの数で足りる（2枠 → 各3個）。
--
-- この列は「料金確認を挟むかどうか」と「連携 n個（契約枠 m個）」の表示に使う。
-- 請求額そのものは接続数から出す（有料枠 = max(0, max(Google数, Instagram数) − 1)）。
-- 解除したときに次回請求から減らす、という既存の見せ方を変えないため。
--
-- 既定は 1。既存の単一接続のLINEは 1 のまま従来どおり動く（枠内＝料金確認なし）。
ALTER TABLE musubo_line_usage ADD COLUMN contracted_linked_slots INTEGER NOT NULL DEFAULT 1
  CHECK (contracted_linked_slots >= 1);
