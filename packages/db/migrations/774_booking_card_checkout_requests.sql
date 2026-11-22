-- カード登録の申込とStripe Checkoutを再送時も同じ組として保持する。
CREATE TABLE booking_card_checkout_requests (
  id TEXT PRIMARY KEY REFERENCES booking_payment_methods(id) ON DELETE CASCADE,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  friend_id TEXT NOT NULL REFERENCES friends(id),
  idempotency_key TEXT NOT NULL,
  booking_json TEXT NOT NULL CHECK(json_valid(booking_json)),
  connect_account TEXT NOT NULL,
  customer_id TEXT,
  checkout_id TEXT UNIQUE,
  checkout_url TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(line_account_id,friend_id,idempotency_key)
);
