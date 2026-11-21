import { inputJsonBoundary } from '../lib/input-errors.js';
import { Hono } from 'hono';

import type { Env } from '../worker-env.js';
import { requireDeliveryAccess, requireRole } from '../middleware/role-guard.js';

import { get__api_friend_add_runs_1, get__api_friend_add_runs_id_2, post__api_friend_add_runs_id_retry_3, post__api_friend_add_rules_folders_4, patch__api_friend_add_rules_folders_id_5, delete__api_friend_add_rules_folders_id_6, get__api_friend_add_rules_7, patch__api_friend_add_rules_reorder_8, put__api_friend_add_rules_order_9 } from './friend-add-rules-runs-handlers.js';

import { get__api_friend_add_rules_conflicts_1, post__api_friend_add_rules_test_2, post__api_friend_add_rules_drafts_3, get__api_friend_add_rules_id_4, put__api_friend_add_rules_id_draft_5, post__api_friend_add_rules_id_validate_6, post__api_friend_add_rules_id_test_7, post__api_friend_add_rules_id_test_send_8, getFriendAddTestRecipient, post__api_friend_add_rules_id_publish_9, post__api_friend_add_rules_id_stop_10, post__api_friend_add_rules_id_unarchive_11, post__api_friend_add_rules_id_duplicate_12, delete__api_friend_add_rules_id_13 } from './friend-add-rules-drafts-handlers.js';
import { validateInput, validateReferences } from './friend-add-rules-definition.js';

const friendAddRules = new Hono<Env>();
export { validateInput } from './friend-add-rules-definition.js';
export type { FriendAddRuleReferenceError } from './friend-add-rules-definition.js';
export { validateReferences } from './friend-add-rules-definition.js';

friendAddRules.get('/api/friend-add-runs', requireRole('owner', 'admin', 'staff'), get__api_friend_add_runs_1);

friendAddRules.get('/api/friend-add-runs/:id', requireRole('owner', 'admin', 'staff'), get__api_friend_add_runs_id_2);

friendAddRules.post('/api/friend-add-runs/:id/retry', requireDeliveryAccess('friendAdd', 'publish'), inputJsonBoundary(), post__api_friend_add_runs_id_retry_3);

friendAddRules.post('/api/friend-add-rules/folders', requireDeliveryAccess('friendAdd'), inputJsonBoundary({"accountId":["string"],"name":["string"],"color":["null","string"]}), post__api_friend_add_rules_folders_4);

// フォルダ名は設定側にも保存されるため、同じトランザクションで置き換える。
friendAddRules.patch('/api/friend-add-rules/folders/:id', requireDeliveryAccess('friendAdd'), inputJsonBoundary({"accountId":["string"],"name":["string"],"color":["null","string"]}), patch__api_friend_add_rules_folders_id_5);

friendAddRules.delete('/api/friend-add-rules/folders/:id', requireDeliveryAccess('friendAdd'), delete__api_friend_add_rules_folders_id_6);

friendAddRules.get('/api/friend-add-rules', requireRole('owner', 'admin', 'staff'), get__api_friend_add_rules_7);

/*
 * PATCH /api/friend-add-rules/reorder — 一覧のつまみで動かした順を
 * 優先順位としてまとめて書く（★V8）。
 *
 * priority は版ではなく行の値で、実行側がそのまま読むため下書きを経ず
 * すぐ効く。受け皿（経路が分からなかった人）は常に最後なので対象外。
 * 安全のため、そのアカウント・区分の受け皿以外の全件をちょうど含む
 * 並びだけを受け付ける——絞り込み中の一部だけで上書きされると、
 * 見えていない設定の順が壊れるため、足りなければ 409 で読み直しを促す。
 */
friendAddRules.patch('/api/friend-add-rules/reorder', requireDeliveryAccess('friendAdd', 'publish'), inputJsonBoundary({"accountId":["string"],"friendKind":["string"]}), patch__api_friend_add_rules_reorder_8);

/*
 * PUT /api/friend-add-rules/order — F8: まとめて並べ替える口。
 * 対象IDの全部・所属・区分・expectedVersion の4点を厳密に見る。
 * - 所属: 見えるLINEアカウントだけ（canUseAccount）。
 * - 区分: first_time / returning だけ。
 * - 対象ID: その所属・区分の受け皿以外の全件とちょうど一致。
 * - 版: 並びの版（lock_version の合計）が expectedVersion と一致。
 * どれか1つでも合わなければ書かず 409 で読み直しを促す。
 * PATCH /reorder は従来の画面が使うので残し、版は見ないままにする。
 */
friendAddRules.put('/api/friend-add-rules/order', requireDeliveryAccess('friendAdd'), inputJsonBoundary({"accountId":["string"],"friendKind":["string"]}), put__api_friend_add_rules_order_9);

friendAddRules.get('/api/friend-add-rules/conflicts', requireRole('owner', 'admin', 'staff'), get__api_friend_add_rules_conflicts_1);

friendAddRules.post('/api/friend-add-rules/test', requireRole('owner', 'admin', 'staff'), inputJsonBoundary({"accountId":["string"],"ruleId":["string"],"friendKind":["string"],"routeId":["null","string"],"expectedAt":["null","string"],"friendId":["null","string"]}), post__api_friend_add_rules_test_2);

friendAddRules.post('/api/friend-add-rules/drafts', requireDeliveryAccess('friendAdd', 'publish'), inputJsonBoundary({"accountId":["string"],"friendKind":["string"],"name":["string"],"folderName":["null","string"],"priority":["number"],"definition":["object"],"version":["number"]}), post__api_friend_add_rules_drafts_3);

friendAddRules.get('/api/friend-add-rules/:id', requireRole('owner', 'admin', 'staff'), get__api_friend_add_rules_id_4);

friendAddRules.put('/api/friend-add-rules/:id/draft', requireDeliveryAccess('friendAdd'), inputJsonBoundary({"accountId":["string"],"friendKind":["string"],"name":["string"],"folderName":["null","string"],"priority":["number"],"definition":["object"],"version":["number"]}), put__api_friend_add_rules_id_draft_5);

friendAddRules.post('/api/friend-add-rules/:id/validate', requireDeliveryAccess('friendAdd'), inputJsonBoundary(), post__api_friend_add_rules_id_validate_6);

friendAddRules.post('/api/friend-add-rules/:id/test', requireRole('owner', 'admin', 'staff'), inputJsonBoundary({"accountId":["string"],"ruleId":["string"],"friendKind":["string"],"routeId":["null","string"],"expectedAt":["null","string"],"friendId":["null","string"]}), post__api_friend_add_rules_id_test_7);

/*
 * POST /api/friend-add-rules/:id/test-send — F12: 保存済みの本文・版で固定し、
 * 操作した本人だけへテスト送信する。
 * - 送る本文は要求ではなく保存済み版の snapshot（版も応答に返す）。
 * - 送り先は操作者のLINEだけ。本文・引数での送り先指定は受け付けない。
 * - 手動の扱いとして messages_log へ source='manual'・delivery_type='test' で記録する。
 *   ヘッダ X-Line-Harness-Source: manual 自体はプロキシ経路の印なので付けない。
 *   既存の手動契約（手動1:1は緊急停止の対象外・手動として記録）に新しい例外は作らない。
 * - 実顧客へは送らない。短時間の二度押しは 429 で止める。
 */
friendAddRules.get('/api/friend-add-rules/:id/test-recipient', requireRole('owner', 'admin', 'staff'), getFriendAddTestRecipient);

friendAddRules.post('/api/friend-add-rules/:id/test-send', requireRole('owner', 'admin', 'staff'), inputJsonBoundary(), post__api_friend_add_rules_id_test_send_8);

friendAddRules.post('/api/friend-add-rules/:id/publish', requireDeliveryAccess('friendAdd', 'publish'), inputJsonBoundary(), post__api_friend_add_rules_id_publish_9);

friendAddRules.post('/api/friend-add-rules/:id/stop', requireDeliveryAccess('friendAdd', 'publish'), inputJsonBoundary({"version":["number"]}), post__api_friend_add_rules_id_stop_10);

friendAddRules.post('/api/friend-add-rules/:id/unarchive', requireDeliveryAccess('friendAdd', 'publish'), inputJsonBoundary(), post__api_friend_add_rules_id_unarchive_11);

friendAddRules.post('/api/friend-add-rules/:id/duplicate', requireDeliveryAccess('friendAdd', 'publish'), inputJsonBoundary(), post__api_friend_add_rules_id_duplicate_12);

friendAddRules.delete('/api/friend-add-rules/:id', requireDeliveryAccess('friendAdd', 'publish'), delete__api_friend_add_rules_id_13);

export { friendAddRules };
