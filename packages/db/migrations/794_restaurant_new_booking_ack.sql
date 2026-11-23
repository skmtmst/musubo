-- 店舗全員で共有する、新着予約の確認操作と現在の確認状態。
CREATE TABLE restaurant_booking_ack_operations (
  id TEXT PRIMARY KEY NOT NULL,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK(operation_kind IN ('single','all')),
  requested_booking_id TEXT REFERENCES rt_reservations(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('active','undone')),
  acknowledged_count INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged_count>=0),
  created_at TEXT NOT NULL,
  CHECK((operation_kind='single' AND requested_booking_id IS NOT NULL) OR (operation_kind='all' AND requested_booking_id IS NULL))
);
-- 操作ごとの対象は、他の担当者による再確認や取消の後も固定して残す。
CREATE TABLE restaurant_booking_ack_operation_items (
  operation_id TEXT NOT NULL REFERENCES restaurant_booking_ack_operations(id) ON DELETE CASCADE,
  booking_kind TEXT NOT NULL CHECK(booking_kind='restaurant'),
  booking_id TEXT NOT NULL REFERENCES rt_reservations(id) ON DELETE CASCADE,
  PRIMARY KEY(operation_id,booking_kind,booking_id)
);
CREATE TABLE restaurant_booking_acknowledgements (
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
  booking_kind TEXT NOT NULL CHECK(booking_kind='restaurant'),
  booking_id TEXT NOT NULL REFERENCES rt_reservations(id) ON DELETE CASCADE,
  acknowledged_at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  operation_id TEXT NOT NULL REFERENCES restaurant_booking_ack_operations(id) ON DELETE CASCADE,
  PRIMARY KEY(line_account_id,store_id,booking_kind,booking_id)
);
CREATE INDEX idx_restaurant_booking_ack_operation ON restaurant_booking_acknowledgements(operation_id);
