-- 764: A/B 本送信の実績表。710 の試験用表は残す。試験行が通常の送信に
-- 流れない既存の守り（ab_block_standard_send 等）は変えない。本物の送信は
-- 既定で止め、明示の旗があるときだけこの表へ書く。試験は模擬だけ。
CREATE TABLE broadcast_ab_live_tests(
  broadcast_id TEXT PRIMARY KEY REFERENCES broadcasts(id),
  test_ratio_pct INTEGER NOT NULL CHECK(test_ratio_pct IN(10,20,30,50)),
  metric TEXT NOT NULL DEFAULT 'click' CHECK(metric='click'),
  decide_after_minutes INTEGER NOT NULL CHECK(decide_after_minutes IN(60,120,240,480,1440)),
  undecided_policy TEXT NOT NULL DEFAULT 'stop' CHECK(undecided_policy IN('stop','send_a')),
  status TEXT NOT NULL DEFAULT 'live_testing' CHECK(status IN('live_testing','live_decided','live_undecided','live_finished','live_expired','live_stopped')),
  winner TEXT CHECK(winner IN('A','B')),
  started_at TEXT,
  decide_at TEXT,
  decided_at TEXT,
  decided_by TEXT,
  remainder_scheduled_at TEXT,
  remainder_sent_at TEXT,
  stats_json TEXT CHECK(stats_json IS NULL OR json_valid(stats_json)),
  version INTEGER NOT NULL DEFAULT 1,
  start_key TEXT,
  start_request_json TEXT CHECK(start_request_json IS NULL OR json_valid(start_request_json)),
  start_result_json TEXT CHECK(start_result_json IS NULL OR json_valid(start_result_json)),
  choice_key TEXT,
  choice_value TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE broadcast_ab_live_recipients(
  broadcast_id TEXT NOT NULL REFERENCES broadcasts(id),
  friend_id TEXT NOT NULL REFERENCES friends(id),
  variant_key TEXT NOT NULL CHECK(variant_key IN('A','B','R')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','sent','failed','unknown')),
  sent_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  PRIMARY KEY(broadcast_id,friend_id)
);
CREATE INDEX idx_broadcast_ab_live_recipients_pending
  ON broadcast_ab_live_recipients(broadcast_id,variant_key,state);
