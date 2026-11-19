-- 請求を始めた接続先と送信時刻を固定し、結果不明時に元の接続を照会する。
ALTER TABLE booking_charges ADD COLUMN stripe_connected_account_id TEXT;
ALTER TABLE booking_charges ADD COLUMN stripe_call_started_at TEXT;

-- 請求を送信中または結果不明の間は、請求の根拠となる取消・無断を変えない。
CREATE TRIGGER booking_charge_block_status_change
BEFORE UPDATE OF status ON bookings
WHEN NEW.status<>OLD.status AND EXISTS (
  SELECT 1 FROM booking_charges c WHERE c.booking_id=OLD.id AND c.line_account_id=OLD.line_account_id
    AND c.status IN ('processing','unknown','succeeded')
)
BEGIN
  SELECT RAISE(ABORT,'booking_charge_in_progress'); END;

-- 失敗が確定した請求も、無断などを取り消したら請求しない履歴へ移す。
CREATE TRIGGER booking_failed_fee_revert
AFTER UPDATE OF status ON bookings
WHEN OLD.status IN ('cancelled','no_show') AND NEW.status NOT IN ('cancelled','no_show')
BEGIN
  UPDATE booking_charges SET status='waived',reason='cancellation_reverted',version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE booking_id=NEW.id AND line_account_id=NEW.line_account_id AND status='failed'; END;

-- 返金の送信結果が不明でも、同じ請求に返金を重ねない。
CREATE TABLE booking_charge_refund_requests (
  id TEXT PRIMARY KEY,
  charge_id TEXT NOT NULL UNIQUE REFERENCES booking_charges(id),
  line_account_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  expected_version INTEGER NOT NULL,
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  connect_account TEXT NOT NULL,
  payment_intent_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK(amount>0),
  status TEXT NOT NULL CHECK(status IN ('processing','unknown','succeeded')),
  stripe_refund_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(line_account_id,idempotency_key)
);

-- 飲食の決済は予約・回答・金額を固定し、同一回答の有料予約は1件だけにする。
CREATE TABLE restaurant_payment_requests (
  id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL UNIQUE,
  form_submission_id TEXT UNIQUE,
  connect_account TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  total_amount INTEGER NOT NULL CHECK(total_amount>=0),
  amount INTEGER NOT NULL CHECK(amount>0 AND amount<=total_amount),
  customer_id TEXT,
  checkout_id TEXT UNIQUE,
  checkout_url TEXT,
  payment_intent_id TEXT UNIQUE,
  refund_started_at TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
  cancel_expected_version INTEGER,
  cancel_reason TEXT,
  recovery_retry_at TEXT,
  stripe_refund_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('pending','paid','refund_pending','refunded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 顧客入力は顧客データ削除の対象とし、決済履歴に本文を残さない。
CREATE TABLE restaurant_payment_details (
  request_id TEXT PRIMARY KEY REFERENCES restaurant_payment_requests(id),
  friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  customer_name TEXT NOT NULL,
  customer_phone TEXT,
  allergy_note TEXT,
  note TEXT,
  form_version INTEGER NOT NULL DEFAULT 0
);

-- 未入金の予約確定と、入金済みの無返金取消を防ぐ。
CREATE TRIGGER restaurant_payment_confirm_guard BEFORE UPDATE OF status ON rt_reservations
WHEN NEW.status='confirmed' AND OLD.status<>'confirmed' AND EXISTS(SELECT 1 FROM restaurant_payment_requests p WHERE p.reservation_id=NEW.id AND p.status<>'paid')
BEGIN SELECT RAISE(ABORT,'restaurant_payment_not_paid'); END;
CREATE TRIGGER restaurant_payment_cancel_guard BEFORE UPDATE OF status ON rt_reservations
WHEN NEW.status IN ('cancelled','rejected') AND OLD.status<>NEW.status AND EXISTS(SELECT 1 FROM restaurant_payment_requests p WHERE p.reservation_id=NEW.id AND p.status IN ('paid','refund_pending'))
BEGIN SELECT RAISE(ABORT,'restaurant_refund_pending'); END;

-- 支払い依頼の金額に影響する予約内容を途中で変えない。
CREATE TRIGGER restaurant_payment_change_guard BEFORE UPDATE OF starts_at,ends_at,guest_count,course_id ON rt_reservations
WHEN (NEW.starts_at IS NOT OLD.starts_at OR NEW.ends_at IS NOT OLD.ends_at OR NEW.guest_count<>OLD.guest_count OR NEW.course_id IS NOT OLD.course_id)
  AND EXISTS(SELECT 1 FROM restaurant_payment_requests p WHERE p.reservation_id=NEW.id AND p.status IN ('pending','paid','refund_pending'))
BEGIN SELECT RAISE(ABORT,'restaurant_payment_change_requires_refund'); END;

-- 返金を伴う取消を受け付けた後は、取消を書き込むまで別の更新を待つ。
CREATE TRIGGER restaurant_payment_cancel_claim_guard BEFORE UPDATE ON rt_reservations
WHEN EXISTS(SELECT 1 FROM restaurant_payment_requests p WHERE p.reservation_id=OLD.id AND p.cancel_requested=1 AND p.status IN ('refund_pending','refunded')
  AND NOT (p.status='refunded' AND NEW.status='cancelled'))
BEGIN SELECT RAISE(ABORT,'restaurant_refund_pending'); END;

-- 支払い時に確認した顧客入力は、入金の反映までは別の操作で上書きしない。
CREATE TRIGGER restaurant_payment_details_guard BEFORE UPDATE OF customer_name,customer_phone,allergy_note,note ON rt_reservations
WHEN (NEW.customer_name IS NOT OLD.customer_name OR NEW.customer_phone IS NOT OLD.customer_phone OR NEW.allergy_note IS NOT OLD.allergy_note OR NEW.note IS NOT OLD.note)
 AND EXISTS(SELECT 1 FROM restaurant_payment_requests p WHERE p.reservation_id=OLD.id AND p.status IN ('pending','paid','refund_pending')
   AND (p.status<>'paid' OR OLD.status='pending')
   AND NOT (p.status='paid' AND OLD.status='pending' AND NEW.status='confirmed' AND EXISTS(SELECT 1 FROM restaurant_payment_details d
     WHERE d.request_id=p.id AND NEW.customer_name IS d.customer_name AND NEW.customer_phone IS d.customer_phone AND NEW.allergy_note IS d.allergy_note AND NEW.note IS d.note)))
BEGIN SELECT RAISE(ABORT,'restaurant_payment_details_locked'); END;
