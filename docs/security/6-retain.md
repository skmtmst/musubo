# 項目6：統括 purge と retain の実動作

## 現在の状態（2026-11-22）

オーナー決定：過去の照合鍵は、その鍵で作った全ハッシュが期限切れになるまで保管する。安全監視の再処理ボタンは画面案に基づいて実装し、オーナーの案の確認待ち。最新状況と鍵の設定方法は末尾の「最終決定とPRメモ」を参照。

統括の削除処理に、保持行の親の墓石化、月謝契約の終了・匿名化、Stripe 通知と外部操作の排他、旧決済識別子の HMAC 保存と旧料金契約の履歴保存・初期化を接続した。migration 790 は作成のみで、どの DB にも未適用。既存の作業ブランチは PR #168 として共有済みで、今回の変更はまだ push していない。保持67表の合成データを用いた試験（5ファイル38件）と、外部キーを有効にした個別試験は合格。Worker 全体試験は1,353ファイル・16,458件すべて合格。全体試験の実行中に重複していた分類定義を整理したが、実際に採用される分類値に変更はない。

リマインダー取消の 404 は本線 `608c489ef18a30bb91d39547ff5e180bfc5b951e` では再現せず、この枝の墓石除外に従来の試験データが合っていなかった。実在するアカウントを使う形に修正し、墓石の拒否も試験した（15件合格）。

以下は調査時点の記録。各節の「未接続」「未修正」「未完了」や試験結果は当時の状態であり、現在の状態ではない。

# 調査・実装の履歴

## 実際の purge で再現した2件

| 対象 | 残す目的・必要項目 | 確認できた現状 | 修正・期間 |
|---|---|---|---|
| booking_payments | 決済の照合。必要な項目と期限の個別判断は未完 | アカウント削除で CASCADE、保持行が消えた | 未修正 |
| booking_audit_logs | 予約変更の監査。必要な項目と期限の個別判断は未完 | 同じ実行で CASCADE、保持行が消えた | 未修正 |
| booking_monthly_contracts | 月謝の契約・請求の照合。必要な項目と期限の個別判断は未完 | friend / account / plan の RESTRICT により purge が完了しない | 未修正 |

試験は `apps/worker/src/services/tenant-retain-foreign-keys.test.ts`。期待する修正後の挙動（purge 完了＋保持行の残存）を指定して実行し、2件とも失敗した。さらに全 retain 表から purge 親への CASCADE・RESTRICT・NO ACTION を網羅する構造試験も追加し、34件の参照を検出して失敗した。合計3件失敗。修正前の失敗試験としてコミット `d306db88b`。
保持の根拠は `packages/db/src/data-retention-tables.json` の retain 分類と、`docs/v8-requirements/form-file-attachments.md` の監査・支払の保持契約。具体的な保管期限や全列の必要性は今回確認できていない。

## 全 retain 表の実スキーマ確認

67 表を列挙し、各表の外部キーを `PRAGMA foreign_key_list` で調査。うち35表で purge 表への直接参照55件（CASCADE 10、RESTRICT 5、NO ACTION 19、SET NULL 21）。構造試験は SET NULL の列が NOT NULL でないことも検査する。月謝の試験では、purge 失敗後に友だちを直接消そうとして `FOREIGN KEY constraint failed` となることも確認した。この一覧は構造の網羅であり、67表すべての合成行を投入して purge した試験ではない。直接の CASCADE・RESTRICT・NO ACTION を持つ retain 表は28表で、そこから外部キーの子孫をたどると計47表（retain 40・purge 7）が関係する。親表だけを再作成すると、これらの子の制約や連鎖作用を壊す可能性がある。

| retain 表 | purge 表への直接参照（参照元列 → 親表.列 / 親削除時） |
|---|---|
| `affiliate_payout_batch_lines` | `affiliate_id` → `affiliates.id` / SET NULL |
| `affiliate_payout_batches` | `line_account_id` → `line_accounts.id` / NO ACTION |
| `affiliate_payout_results` | `affiliate_id` → `affiliates.id` / SET NULL |
| `affiliate_settlement_lines` | `adjustment_id` → `affiliate_adjustments.id` / SET NULL<br>`entry_id` → `affiliate_reward_entries.id` / SET NULL<br>`affiliate_id` → `affiliates.id` / SET NULL |
| `affiliate_settlements` | `affiliate_id` → `affiliates.id` / SET NULL<br>`line_account_id` → `line_accounts.id` / NO ACTION |
| `affiliate_statements` | `affiliate_id` → `affiliates.id` / SET NULL<br>`line_account_id` → `line_accounts.id` / NO ACTION |
| `audit_events` | `line_account_id` → `line_accounts.id` / SET NULL |
| `billing_events` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |
| `billing_invoices` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |
| `booking_audit_logs` | `line_account_id` → `line_accounts.id` / CASCADE<br>`booking_id` → `bookings.id` / SET NULL |
| `booking_calendar_switch_audit` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |
| `booking_cancellation_events` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |
| `booking_charges` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |
| `booking_entitlement_events` | `line_account_id` → `line_accounts.id` / CASCADE |
| `booking_entitlement_month_limits` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |
| `booking_entitlement_uses` | `booking_id` → `bookings.id` / SET NULL |
| `booking_entitlements` | `menu_id` → `menus.id` / RESTRICT<br>`friend_id` → `friends.id` / SET NULL<br>`line_account_id` → `line_accounts.id` / CASCADE |
| `booking_monthly_active_slots` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |
| `booking_monthly_attempts` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |
| `booking_monthly_contracts` | `friend_id` → `friends.id` / RESTRICT<br>`account_id` → `friends.line_account_id` / RESTRICT<br>`account_id` → `line_accounts.id` / RESTRICT<br>`tenant_id` → `line_accounts.tenant_id` / RESTRICT |
| `booking_monthly_cycles` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |
| `booking_monthly_event_applications` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |
| `booking_monthly_operations` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |
| `booking_monthly_rights` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |
| `booking_pass_plans` | `line_account_id` → `line_accounts.id` / NO ACTION |
| `booking_payment_booking_links` | `booking_id` → `bookings.id` / SET NULL<br>`line_account_id` → `line_accounts.id` / NO ACTION |
| `booking_payment_event_replays` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |
| `booking_payment_events` | `line_account_id` → `line_accounts.id` / NO ACTION |
| `booking_payment_refunds` | `line_account_id` → `line_accounts.id` / NO ACTION |
| `booking_payments` | `booking_id` → `bookings.id` / SET NULL<br>`line_account_id` → `line_accounts.id` / CASCADE |
| `broadcast_approval_events` | `broadcast_id` → `broadcasts.id` / CASCADE |
| `ec_auto_line_rule_events` | `account_id` → `line_accounts.id` / NO ACTION |
| `event_booking_entitlement_uses` | `makeup_credit_id` → `booking_makeup_credits.id` / NO ACTION<br>`line_account_id` → `line_accounts.id` / NO ACTION<br>`event_booking_id` → `event_bookings.id` / SET NULL |
| `friend_bulk_message_approval_events` | `run_id` → `friend_bulk_runs.id` / NO ACTION |
| `friend_delivery_consent_events` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |
| `hq_broadcast_audit` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |
| `hq_broadcast_runs` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |
| `hq_broadcast_targets` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |
| `login_audit` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |
| `mcp_call_logs` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |
| `mcp_connections` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |
| `mileage_adjustment_approval_events` | `request_id` → `mileage_adjustment_approval_requests.id` / SET NULL |
| `musubo_individual_quotes` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |
| `musubo_line_removals` | `line_account_id` → `line_accounts.id` / NO ACTION |
| `musubo_pending_additions` | `line_account_id` → `line_accounts.id` / NO ACTION |
| `musubo_tenant_billing` | `resumption_line_account_id` → `line_accounts.id` / NO ACTION |
| `nen_photo_assessment_runs` | `line_account_id` → `line_accounts.id` / NO ACTION<br>`photo_id` → `nen_photo_submissions.id` / SET NULL |
| `nen_photo_original_download_audit` | `line_account_id` → `line_accounts.id` / NO ACTION<br>`photo_id` → `nen_photo_submissions.id` / SET NULL |
| `nen_photo_original_download_grants` | `line_account_id` → `line_accounts.id` / NO ACTION<br>`photo_id` → `nen_photo_submissions.id` / SET NULL |
| `nen_photo_review_events` | `line_account_id` → `line_accounts.id` / NO ACTION<br>`photo_id` → `nen_photo_submissions.id` / SET NULL |
| `nen_photo_risk_assessments` | `line_account_id` → `line_accounts.id` / NO ACTION<br>`photo_id` → `nen_photo_submissions.id` / SET NULL |
| `operation_audit` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |
| `pii_reveal_logs` | `impersonation_session_id` → `impersonation_sessions.id` / CASCADE |
| `platform_audit_logs` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |
| `registration_applications` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |
| `rt_approval_requests` | `store_id` → `rt_stores.id` / CASCADE<br>`organization_id` → `rt_organizations.id` / CASCADE |
| `rt_inventory_rule_log` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |
| `rt_organization_agreements` | `organization_id` → `rt_organizations.id` / CASCADE |
| `security_alerts` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |
| `site_consent_days` | `line_account_id` → `line_accounts.id` / CASCADE |
| `stripe_events` | `friend_id` → `friends.id` / SET NULL |
| `style_change_logs` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |
| `tenant_data_purge_audit` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |
| `visit_stamp_cards` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |
| `visit_stamp_checkouts` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |
| `visit_stamp_entries` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |
| `visit_stamp_redemptions` | 直接参照なし（間接参照・外部キーなしの関係は別途確認） |

## 今回の追加作業（未完了）

- 店舗 `fb74b65d2`・組織 `d4b99ee29`・配信 `a08f00aa0`・券のプランとメニュー `22ef732ea` の墓石作成と部分試験をコミット。purge 本体にはいずれも未接続。
- 790 で組織の一意索引を墓石以外に限定。適用前の重複点検 SQL と、重複検出・再登録・生きている組織間の一意性の試験を追加。
- 再開と purge 開始の排他・Stripe 通知の pending 保留の準備を `906902773` にコミット。課金・再開関連試験93件と、排他・保留の個別試験が合格した。開始処理にはまだ組み込んでいない。
- **未解決**: Stripe の pending が永続化すると開始が止まる。時刻だけで保留を無視すると、実行中の webhook と purge が並行するため危険。処理中の排他と期限切れ通知の回収・運営への通知が必要。Stripe の再送期間を過ぎても pending を再処理できる手段も未実装。
- 月謝契約の停止・個人識別子の除去、他の親の墓石化、purge 本体との接続、保持67表の合成データによる実行試験は未完了。再現試験は赤いまま。

## 追加の試験と保留（13時時点）

- `63d2c242c` は通知受領時に金額を保存し、期限切れ・借受なしの受領を要確認へ移す準備。借受中は触れず、UTC 時刻を要求する試験が合格。
- `c04fcbd16` は purge 完了ごとの課金世代と完了日時、および従来 Checkout に世代を付ける準備。重複完了で世代が増えない試験と Checkout の送信内容が合格。Musubo の契約・追加・カード登録には未適用。
- 所有者が HMAC の保存期間を「最後の決済日、なければ purge 日＋1年3か月の翌日から10年」と決定。`f138694f4` は計算・鍵の版・期限後の定時削除を用意したが、最後の決済日を全決済の記録から得る処理と実際の保存・照合は未接続。鍵が無い／古い鍵が無い場合の要確認も未接続。
- 借受を実際の webhook の全ての書き込みに適用するフェンス、借受の期限切れと purge 開始の原子的な連動、削除済みか新規契約かの判定、purge 本体と全 retain 表の合成データの試験が残る。現在の purge は従来のままで、保持データの連鎖削除と月謝の RESTRICT を防いでいない。

## Stripe 通知と旧識別子（作業途中）

- 所有者の判断：purge 中の Stripe 通知は統括へ適用せず、金額を残して要確認とする。旧 Customer ID・契約 ID の照合には鍵付き HMAC を使用し、鍵がなければ照合せず要確認にする。期限は最後の決済日（なければ purge 日）＋1年3か月の翌日から10年。
- `4b8a55f48` は通知の借受と照合待ちの準備。`f138694f4` は HMAC・鍵の版・期限計算・定時削除の準備。`d95660393` は削除中の billing webhook を照合待ちに記録し、安全監視に出す変更。安全監視の platform API は金額・通貨・返金累計の意味を返すが、既存画面がその詳細を表示することはまだ確認していない。
- **未接続・未完了**：借受の期限切れ後に古い処理が更新できない保証、古い pending の回収、削除後の新旧契約の判別、HMAC の保存と照合の呼び出し、全決済表から最後の決済日を確定する処理、purge 本体への接続、全 retain 表の合成データ試験。purge 本体は変更していない。

## 現在の実装状況

- 790 の月謝トリガーは墓石アカウントに限り、顧客 ID の消去と申込 JSON の friendId の消去を許可し、金額や契約相手の変更を拒否する。単体試験を実行済み。
- 墓石の作成処理は一意な LINE 識別子を匿名の値に置換し、資格情報を消す。合成データで同じ識別子を新しい行に登録できることを確認した。ただし purge 本体にはまだ接続していない。
- アカウント・友だち以外にも、保持行が参照する店舗・組織などの親がある。これらを削除すると保持行が消えるため、墓石の実装と個人情報消去・表示除外を個別に検証する必要がある。
- 直近の墓石関連と友だちのスコープの部分試験は Node 22 で 3 ファイル・18 件合格。保持表の再現試験では、店舗・組織、外部キーの構造、予約決済、月謝の4件が失敗。さらに配信の承認履歴も purge で消えることを再現し、失敗試験を `2f3123da5` に保存した。全 retain 表の合成データ試験、実際の purge の再実行、網羅的な集計・送信経路の確認は未実施。

## 残作業・失敗時の扱い

- 個々の保持表について、残す列・識別子の切離し・保管期限を決め、外部キーと一意制約を維持した migration 790 と安全な段階的移行を設計する。複合外部キーや保持表を参照する子表も対象。`booking_payments` は3表に、`booking_monthly_contracts` は月謝サイクル等4表に参照されており、親表だけの作り直しは保持行の連鎖変更・削除や制約違反につながる。
- 全 67 表を有効な合成行で網羅し、他統括を残しつつ purge 成功・retained 行維持・途中失敗と再実行を検証する。
- 現状は変更しておらず、CASCADE は保持データを失う、RESTRICT は purge を途中失敗させる。R2・外部サービスを含む失敗からの再実行は未検証。

## 借受の期限判定と残る試験（11月22日）

- 借受の期限判定を DB の時計に統一し、完了の確認に失敗すると同じ D1 batch の更新を巻き戻す部品をコミットした（`2317d9c0f`、`2a99b8aa1`）。Node 22 の関連試験は 2 ファイル・17 件合格し、Worker の型検査も合格。完了と検証を隣接させた部品の別モデルレビューは依頼中。
- 実際の webhook と purge 本体への借受・墓石・HMAC の接続はまだ完了していない。保持表の再現試験は 6 件中 5 件が失敗し、店舗と配信の承認履歴・予約決済と監査が消える問題、月謝による purge の停止、保持表から削除対象への外部キー 34 件が残る。
- 新旧世代の `musubo_tenant_billing` の保持方法は判断待ち。未接続の部品を使って本番の安全性を保証したことにはならない。

- 追加の所有者判断：旧料金契約の金額・期間など決済照合に必要な非個人情報を保持用イベントへ保存し、現在の契約行を新しい契約用に初期化する。履歴保存と初期化は同一 batch で原子的に行い、保存期限は決済記録と同じ計算とする。実装・検証は未完了。


## 外部キーを遡った親の消去候補（未確定）

現在の bootstrap では削除分類の親は **41 表**。前回の42表は数え間違い。列名と顧客データ参照一覧から候補を機械抽出した。候補は消去の確定ではなく、特に必須列・外部キー・一意制約・JSON 内の識別子は安全な代替値と参照維持を個別に確認する。全表を確認するまで purge に適用しない。

- `affiliate_adjustments`: reason_type（必須）, reason（必須）, idempotency_key（必須）
- `affiliate_offers`: name（必須）, description
- `affiliate_reward_entries`: idempotency_key（必須）
- `affiliates`: name（必須）, friend_id（参照または主キー）, email
- `booking_customers`: friend_id（参照または主キー）, display_name（必須）, phone_normalized_hash（必須）, phone_encrypted（必須）, phone_last4（必須）, email_encrypted, pet_name
- `booking_groups`: friend_id（必須）（参照または主キー）, idempotency_key（必須）, request_json（必須）
- `booking_makeup_credits`: friend_id（必須）（参照または主キー）, reason, rule_snapshot_json（必須）, use_idempotency_key, use_request_json
- `booking_payment_methods`: friend_id（必須）（参照または主キー）, idempotency_key（必須）
- `booking_series`: friend_id（必須）（参照または主キー）, rule_json（必須）, idempotency_key（必須）, request_json（必須）
- `bookings`: friend_id（参照または主キー）, customer_note, internal_note, menu_snapshot_json, meeting_url, cancellation_reason, policy_snapshot_json, meeting_url_source, deposit_snapshot_json
- `broadcasts`: message_type（必須）, message_content（必須）, message_bubbles_json, internal_memo, draft_payload_json, message_options_json, approval_note, approval_reject_reason
- `common_action_versions`: 列名による候補なし。値と制約の確認が必要
- `common_actions`: name（必須）, description, client_request_key
- `conversion_events`: friend_id（必須）（参照または主キー）, user_id, metadata, point_name_snapshot, idempotency_key
- `conversion_points`: name（必須）, target_url, source_config_json（必須）, ingest_secret_encrypted
- `event_bookings`: friend_id（必須）（参照または主キー）, customer_note, internal_note, identity_key, answer_snapshot_json, event_snapshot_json
- `event_slots`: client_key
- `event_versions`: snapshot_json（必須）
- `events`: name（必須）, venue_name, venue_url, image_url, description, description_centered（必須）, confirmation_message_extra, reminder_message_extra, og_description, og_image_url, version_write_token, questions_json, lifecycle_change_reason, venue_address, makeup_rule_json（必須）
- `folders`: name（必須）
- `form_versions`: source_content_revision（必須）, name（必須）, description, on_submit_message_type, on_submit_message_content, on_submit_webhook_url, on_submit_webhook_fail_message, save_to_metadata（必須）, og_description, og_image_url
- `forms`: name（必須）, description, save_to_metadata（必須）, on_submit_message_type, on_submit_message_content, on_submit_webhook_url, on_submit_webhook_fail_message, og_description, og_image_url, content_revision（必須）
- `friend_bulk_runs`: selection_json（必須）, operation_json（必須）, execution_plan_json, idempotency_key（必須）, error_message
- `friends`: line_user_id（必須）, display_name, picture_url, status_message, user_id, metadata（必須）, real_name, system_display_name, private_memo, photo_watch_required（必須）
- `impersonation_sessions`: write_reason
- `line_account_tags`: name（必須）
- `line_accounts`: name（必須）, channel_access_token（必須）, channel_secret（必須）, channel_access_token_encrypted, channel_secret_encrypted, channel_access_token_updated_at, channel_secret_updated_at, login_channel_secret_updated_at, archived_reason, og_site_name, og_default_image_url, og_default_description, official_profile_url, login_channel_secret, token_expires_at, icon_url, line_display_name, line_picture_url, line_profile_synced_at, inactive_reason, inactive_reason_detail, login_channel_secret_encrypted
- `media`: r2_key（必須）, public_url, archive_reason, usage_consent_note
- `menus`: name（必須）, description, fixed_meeting_url, audience_tag_ids_json（必須）, recurring_freqs_json（必須）, addon_menu_ids_json（必須）, image_url, photo_media_id
- `mileage_adjustment_approval_requests`: friend_id（必須）, reason_category（必須）, reason（必須）, idempotency_key（必須）, requested_by_staff_name（必須）, decided_by_staff_name, decision_reason
- `nen_pet_profiles`: friend_id（必須）（参照または主キー）, name（必須）, image_r2_key, image_url
- `nen_photo_submissions`: friend_id（必須）（参照または主キー）, r2_key（必須）, image_url（必須）, content_type（必須）, public_pet_name（必須）, review_reason_code, review_reason_note, reviewed_by_name, review_image_url, public_image_url, image_width, image_height, image_byte_size, rotation_idempotency_key, notification_retry_key, content_hash, review_r2_key, public_r2_key
- `recipe_clone_runs`: name_prefix, idempotency_key（必須）, failure_reason
- `recipes`: name（必須）, items_json
- `rt_organizations`: name（必須）
- `rt_stores`: name（必須）
- `scenarios`: name（必須）, description, audience_condition_json, stopped_reason, content_revision（必須）
- `staff`: name（必須）, display_name（必須）, profile_image_url, fixed_meeting_url, meeting_url_version（必須）, photo_media_id, photo_version（必須）
- `staff_members`: name（必須）, email, api_key（必須）, invite_token_hash, email_verified_at, line_user_id, totp_secret_enc, totp_pending_secret_enc, password_hash, password_updated_at, email_mask, email_change_new, email_change_token_hash, email_change_expires_at
- `tags`: name（必須）, description, normalized_name
- `tracked_links`: name（必須）, original_url（必須）, og_description, og_image_url, dedup_key


## 一括規則から外れる候補（未解決）

参照・主キー、金額・日時・状態等は保持。その他の NULL 可能列は NULL、必須文字列は定型値、必須識別子は行 ID 由来の一意値に分類。以下は形式や一意キーの確認が必要。DB 制約・トリガー・索引と照合するまで未適用。

- `booking_groups.request_json`：必須文字列の形式制約・JSON 内容を確認する。
- `booking_makeup_credits.rule_snapshot_json`：必須文字列の形式制約・JSON 内容を確認する。
- `booking_series.rule_json`：必須文字列の形式制約・JSON 内容を確認する。
- `booking_series.request_json`：必須文字列の形式制約・JSON 内容を確認する。
- `broadcasts.message_content`：必須文字列の形式制約・JSON 内容を確認する。
- `conversion_points.source_config_json`：必須文字列の形式制約・JSON 内容を確認する。
- `event_versions.snapshot_json`：必須文字列の形式制約・JSON 内容を確認する。
- `events.description_centered`：必須の非文字列で、消去後の安全な値と制約を確認する。
- `events.makeup_rule_json`：必須文字列の形式制約・JSON 内容を確認する。
- `form_versions.save_to_metadata`：必須の非文字列で、消去後の安全な値と制約を確認する。
- `forms.save_to_metadata`：必須の非文字列で、消去後の安全な値と制約を確認する。
- `friend_bulk_runs.selection_json`：必須文字列の形式制約・JSON 内容を確認する。
- `friend_bulk_runs.operation_json`：必須文字列の形式制約・JSON 内容を確認する。
- `friends.photo_watch_required`：必須の非文字列で、消去後の安全な値と制約を確認する。
- `menus.audience_tag_ids_json`：必須文字列の形式制約・JSON 内容を確認する。
- `menus.recurring_freqs_json`：必須文字列の形式制約・JSON 内容を確認する。
- `menus.addon_menu_ids_json`：必須文字列の形式制約・JSON 内容を確認する。
- `nen_photo_submissions.public_pet_name`：必須の非文字列で、消去後の安全な値と制約を確認する。

## 18列への追加判断（準備中）

所有者の指示を反映し、必須 JSON は個人・秘密キーを再帰的に除去し、それ以外を残す方針にした。メッセージ本文は定型文、必須フラグは 0 とする。これは分類案であり、各表の CHECK・トリガー・一意制約を通せること、一覧・送信・再利用から外せることは未検証。JSON の再帰的なキー除去部品を追加したが、実際の purge には未接続。自由記述や予期しないキーの値まで漏れなく除去できるとはまだ確認していない。

## 店のフォーム定義（追加決定）

フォーム本体と公開済みの版は店が作る定義として保持し、墓石化による列の変更を行わない。回答・送信者・ファイル実体と統括の利用関係は従来どおり削除する。定義の参照関係によりレコードは残るが、墓石となった統括・アカウントからは利用できない前提。公開済みの版の不変トリガーは変更しない。同様の店の定義に対する不変トリガーも、対象と意味を確認してから同じ扱いにする。

## 外部操作との競合（準備途中）

`77ea9bdda` で課金Webhookの外部操作・通知が未確定の間、借受が期限切れでも統括 purge が始まらない印を追加した。正常終了で印を外し、応答が不明なエラーでは印を残して停止する。借受の再取得も印が残る間は拒否する。関連の部分試験は通ったが、応答不明の運営向け通知・復旧手段は未実装。HMACの保存・照合と旧料金契約の履歴保存は purge 本体にまだ接続していない。保持表全件およびWorker全体の試験も未実施。配備しない。

## 課金の接続と残る検証（追加）

`e79285e3f` で結果不明の決済操作を安全監視へ表示し、`db8081c28` で定時の課金メールも purge と排他にした。`2a89cd0ca` で HMAC の保存・照合、旧料金契約の履歴保存と現在行初期化を purge へ接続。鍵が不足すると保存済みの通知を残し、安全監視に出して再試行を待つ。旧IDの通知を再開後の新契約へ適用しない試験、通知中の purge 排他、履歴の個別試験は実施済み。`9bd80e764` は保持される個人情報表示監査の合成データ試験と、古い migration の試験条件を修正した。全 67 表に合成データを入れる試験はまだ未完了。

Worker 全体試験は実行中。途中で `reminder-account-scope.test.ts` の「両方見える担当者が取り消すと送信待ちが止まる」が 404（期待 200）で失敗し、単独実行でも再現した。今回の課金・purge 変更との関係は未確認。別の表のテストには着手していない。現時点で全体試験合格・配備可能とは言えない。

## 課金照合・通知の接続（続き）

`e79285e3f` は外部操作の結果不明を安全監視へ表示する。`db8081c28` は課金メール送信中の purge を待たせる。`2a89cd0ca` は旧 Stripe 識別子の HMAC 保存・Webhook 照合、旧料金契約の履歴保存と現在行初期化を接続し、鍵不足時の保留と安全監視を追加した。`3d0056751` は支払日の収集を D1 の compound SELECT 上限内に分割した。再開後の旧通知、鍵不足後の再送、送信中の排他、保存期間等の個別試験は合格。HMAC 鍵の環境設定や migration の適用は行っていない。

Worker 全体試験は途中経過で、課金と無関係のリマインダー取消、動画テンプレート、クリック後の処理に失敗がある。リマインダー取消は単独実行でも 404（期待 200）を再現した。D1 上限の試験は今回のクエリで失敗したが `3d0056751` で修正し単独試験に合格。古い migration の試験条件による失敗も `9bd80e764` で修正し単独合格。実行中に修正したため、実行中の全体試験は最終コミットの結果ではない。保持 67 表に合成行を入れる試験も未完了。配備しない。

全体試験は上記の無関係な失敗を確認したため中断（終了コード 130）。全体の最終集計はない。課金・purge の関連 12 ファイル 165 試験は合格（後から追加した D1 クエリ分割は個別試験で合格）。

## 本線との比較と追加検証

`origin/codex/development` の別 worktree（`608c489ef18a30bb91d39547ff5e180bfc5b951e`）ではリマインダー取消試験は14件すべて合格。この枝のアカウント墓石の除外によって、実在しないアカウントを使う従来の試験データが合わなくなっていた。`839c2c125` で実在するアカウントを用意し、墓石アカウントを操作できない試験も追加。15件合格。動画とクリックの試験も本線では合格し、同じ原因による試験データを `0afd8ffee` で修正した。

外部キー有効の合成データで、決済・監査・振込・月謝・写真・同意・カテゴリを追加検証した。月謝の試験で履歴の決済手段IDが残ることを発見し、`599cabaf5` で限定された例外を設けて匿名化した。写真試験でペットの自由記述と削除後のダウンロード再利用を発見し、`5e7d3d259` で対処した。MCP の旧資格情報は `1ea4dfa34` で停止し、統括共有の旧カテゴリは `fbeb018dd` で隠す。DB 適用と配備はしていない。

## 今回追加した検証と修正

- 外部キーを有効にした合成データで、決済・返金・月謝と券の利用・各種監査・配信・店舗同意・振込・写真・課金履歴などの保持行、顧客情報の消去、別統括の保護を検証した。保持67表は複数の試験ケースに分け、対応する行の保存を確認する構成とした。MCPは実際の接続と呼び出しログを作って検証した。
- 月謝の決済手段IDは、削除中であること、アカウントの墓石化と契約停止、その他の列が不変であることを条件とする限定的な例外で置換する。
- 写真の顧客識別子・説明と元画像を消去し、古いダウンロード鍵を利用不可にした。再開後も旧MCP鍵、旧スタッフ、旧一括操作、旧紹介コード、旧成果地点、旧アカウント分類を再利用・表示できないようにした。
- 公開済みのイベント版・メニューなどの店の定義は骨格を保持して利用停止する。Webhook秘密、会議URL・住所およびアクション本文は後続のレビュー対応で消去する。顧客情報を含む回答や送信者などは消去対象とする。公開済み共通アクション版も不変の定義として扱う。
- 更新した個別試験は保持関連4ファイル29件、月謝・墓石など4ファイル42件、成果地点のDB試験29件が合格。Worker全体は1,350ファイル・16,417件合格。

## Claude 独立レビューへの対応（2026-11-22）

- 課金通知は一致する有効な統括を先に探す。見つからない通知だけ旧IDのHMACを照合し、利用可能な過去鍵を `PURGED_PAYMENT_HMAC_PREVIOUS_SECRETS` のJSON配列で受け付ける。保存行の鍵版は鍵から作る識別値で、鍵自体は保存しない。未保有の鍵がある場合は該当する照合待ち通知だけを停止する。
- 構造化データは列ごとに許可したキーだけを残し、未知の列は空にする。一括操作の本文・値、予約の自由記述を含む試験を追加した。
- フォームのWebhook URLとヘッダ、メニューの会議URL・場所、イベント版の住所、公開アクション版の本文を消す。公開版の例外はpurge中・対象アカウント墓石済み、かつ許された列以外の変更がない場合に限定する。共有フォームは他統括の設定を守る。
- 保持行の親41表の文字・JSON列705件の方針と理由を一覧化し、新しい列が一覧になければ試験が落ちる見張りを追加。担当者の自己紹介・通知設定、予約の場所・対象者名、ペットの誕生日、決済方法の識別子等も消去対象に加えた。
- purge開始前と開始印の書込み時に鍵の有無を確認する。期限切れの未確定外部操作は安全監視に要確認として残したうえで保留を解除する。統括をまたぐ配信は対象統括のアカウントと受信者だけを切り離し、他統括の履歴を守る。
- 月謝契約の匿名化結果と残件を検証し、残存時は完了しない。スタッフ鍵は乱数に置換する。墓石進捗は再開後も表示除外に使うため削除しない。店舗Connect通知は受領と業務書込みをpurgeと同じDB境界で確認し、旧アカウント宛は再開後も照合待ちにする。
- 指摘ごとに関連試験を通してコミット。保持67表の合成データ5ファイル38件、型検査、bootstrap整合の確認を実行。Worker全体は 1,350 ファイル・16,430 件すべて合格。

## 再レビュー対応（2026-11-22）

- 期限切れの決済外部操作は pending に戻してStripe再送を受け付ける。運営向け再処理APIはStripeから元の通知を取得し、通常のWebhook処理へ通す。安全監視からのSlack通知も追加した。既存画面への再処理ボタンは未接続。
- 顧客ID・契約IDが両方ない通知では旧ID照合を行わない。過去鍵設定のJSONが不正なときは `/api/health` が異常を返す。
- 未保有の鍵版が残る場合、未知の顧客IDがその版のハッシュに一致するかは、鍵なしでは判定できない。現在は誤適用を防ぐため照合待ちとする。無関係なIDと証明して通すには欠けた鍵、または別の安全な照合情報が必要。この点は再レビューの希望を満たしていない。
- JSONの配列から文字要素を除き、許可キーの値も型・固定語を検査する。列の消去方針と実処理、移行790の不変列と実スキーマの突合試験を追加した。元の統括が削除された共有配信は他統括の画面と送信待ちから除外する。
- 本線 `9ab8b9950` を取り込み、789と790を含めてbootstrapを再生成。READMEには双方の入口を残した。

本線取り込み後、bootstrap整合、保持関連7ファイル75件、Worker全体1,353ファイル・16,458件は合格。途中の全体試験で新しい運営APIの権限台帳とOpenAPI台帳の更新漏れが見つかり、修正して全体を再実行した。全体試験時点のコミットは `1724f7e8b`。画面からの再処理操作と、欠落鍵の版だけを特定する手段は未完了。


## 最終決定とPRメモ（2026-11-22）

- 過去のHMAC鍵は、その鍵で作成したすべてのハッシュの期限が切れるまで、照合専用として保管する。鍵の手順書と設定・秘密情報の一覧に記載した。秘密値は文書に保存しない。
- 旧鍵が欠落した通知は照合待ちになり、特定できる現行契約や顧客・契約IDを含まない別の通知は処理を続けることを、同一試験で確認した。未知のID付き通知が欠落鍵に該当するかは鍵なしで判定できず、安全のため照合待ちとなる。この制約を含めて現行実装を採用する。
- 安全監視の再処理は運営APIまで実装済み。画面のボタンを追加し、オーナーによる画面案の確認を待つ。
- 本線 `9ab8b9950` 取り込み後、bootstrap整合、保持関連7ファイル75件、Worker全体1,353ファイル・16,458件が合格。今回追加した旧鍵欠落の部分試験も合格した。当時は migration 790 の作成のみで、push、DB適用、配備は行っていなかった。

### #168 再処理画面（11月22日）

健全性チェックに決済通知の再処理を接続。閲覧のみ・代理ログインでは理由付きで操作を制限し、確認窓に再処理の説明を表示する。画面案はオーナー確認中。

同じ通知の同時再処理は期限付き借受で1人に限定し、完了と成功監査を同じ一括処理で確定する。別の人には処理中と表示する。失敗した場合は借受を返し、停止時も期限後に再取得できる。処理後に記録の確定が失敗した場合は、完了済みの受付を照合して別の監査記録を残す。790 は統合前・全DB未適用のため、オーナーの明示承認を受けて列を追加した。

未解決：外部操作が未確定のまま残った完了済み受付や、削除中の統括に関する通知は、再処理できない場合がある。運営の解決 API はあるが、画面からの解決手段は別途検討する。
