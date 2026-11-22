-- 個人情報を削除した予約は、後から名前を変更しても匿名化の印を保持する。
-- 既存行を一括更新すると在庫の再計算・通知が発生するため、旧形式は読み取り側で扱う。
ALTER TABLE rt_reservations ADD COLUMN customer_anonymized INTEGER NOT NULL DEFAULT 0
  CHECK (customer_anonymized IN (0, 1));
