import { inputJsonBoundary } from '../lib/input-errors.js';

import { Hono } from 'hono';

import type { Env } from '../worker-env.js';

import { requireRole } from '../middleware/role-guard.js';
import { requireWebhookSecretOwner } from './webhook-secret-permission.js';

import { get__api_webhooks_incoming_1, get__api_webhooks_incoming_id_2, patch__api_webhooks_incoming_id_config_3, post__api_webhooks_incoming_4, put__api_webhooks_incoming_id_5, delete__api_webhooks_incoming_id_6, post__api_webhooks_incoming_id_restore_7, get__api_webhooks_incoming_id_unmatched_8, post__api_webhooks_incoming_id_test_9, post__api_webhooks_unmatched_id_resolve_10, get__api_webhooks_outgoing_11 } from './webhooks-incoming-admin-handlers.js';
import { generateWebhookSecret } from './webhooks-definition.js';
import { get__api_webhooks_outgoing_id_1, post__api_webhooks_outgoing_2, put__api_webhooks_outgoing_id_3, post__api_webhooks_outgoing_id_test_4, delete__api_webhooks_outgoing_id_5, post__api_webhooks_outgoing_id_restore_6, get__api_webhooks_interactions_export_csv_7, get__api_webhooks_interactions_8, get__api_webhooks_interactions_id_payload_9, post__api_webhooks_interactions_id_retry_10, post__api_webhooks_interactions_retry_failed_11, post__api_webhooks_maintenance_secret_backfill_12 } from './webhooks-outgoing-admin-handlers.js';

import { post__api_webhooks_incoming_id_receive_1, get__api_webhooks_api_tokens_2, post__api_webhooks_api_tokens_3, post__api_webhooks_api_tokens_id_revoke_4, post__api_webhooks_api_tokens_id_reactivate_5, post__api_webhooks_api_tokens_id_rotate_6 } from './webhooks-receive-tokens-handlers.js';

const webhooks = new Hono<Env>();
export { generateWebhookSecret } from './webhooks-definition.js';
export { processIncomingWebhookQueue } from './webhooks-definition.js';

// ========== 受信Webhook ==========

webhooks.get('/api/webhooks/incoming', requireRole('owner', 'admin', 'staff'), get__api_webhooks_incoming_1);

webhooks.get('/api/webhooks/incoming/:id', requireRole('owner', 'admin', 'staff'), get__api_webhooks_incoming_id_2);

webhooks.patch('/api/webhooks/incoming/:id/config', requireRole('owner', 'admin'), inputJsonBoundary(), patch__api_webhooks_incoming_id_config_3);

webhooks.post('/api/webhooks/incoming', requireRole('owner', 'admin'), inputJsonBoundary({"name":["string"],"sourceType":["string"],"secret":["string"],"lineAccountId":["string"],"isActive":["boolean"]}), post__api_webhooks_incoming_4);

webhooks.put('/api/webhooks/incoming/:id', requireRole('owner', 'admin'), requireWebhookSecretOwner, inputJsonBoundary({"name":["string"],"sourceType":["string"],"secret":["string"],"isActive":["boolean"],"expectedVersion":["number"]}), put__api_webhooks_incoming_id_5);

webhooks.delete('/api/webhooks/incoming/:id', requireRole('owner'), delete__api_webhooks_incoming_id_6);

/**
 * 受信 Webhook の削除を取り消しても、突然受信処理を再開しないよう停止状態を保つ。未削除・不存在・範囲外は404/403で拒む。
 */
webhooks.post('/api/webhooks/incoming/:id/restore', requireRole('owner'), inputJsonBoundary(), post__api_webhooks_incoming_id_restore_7);

// ========== 人が見つからなかった届物 ==========

/**
 * 未照合の箱の中身。届物1件ごとに「照合に使った値」と
 * 「形だけの見本」を返す。生の本文は保存していないので返せない。
 */
webhooks.get('/api/webhooks/incoming/:id/unmatched', requireRole('owner', 'admin', 'staff'), get__api_webhooks_incoming_id_unmatched_8);

/**
 * S ( 機能26): 受け取りの試し。見本のJSONを照合と行動の組み立てまで
 * 試して結果を返す。届物の受領・行動の実行・箱への記録は一切行わない。
 * 結果だけはやり取り台帳へ「試し」として分けて残す(-26 §9)。
 */
webhooks.post('/api/webhooks/incoming/:id/test', requireRole('owner', 'admin', 'staff'), inputJsonBoundary(), post__api_webhooks_incoming_id_test_9);

/**
 * 箱の中の届物を閉じる。`{action:'dismiss'}` は何もしないで閉じる、
 * `{action:'link', friendId}` は既存の友だちに結び付けて閉じる。
 * 友だちの所属はアカウント境界で確かめる。
 */
webhooks.post('/api/webhooks/unmatched/:id/resolve', requireRole('owner', 'admin'), inputJsonBoundary(), post__api_webhooks_unmatched_id_resolve_10);

// ========== 送信Webhook ==========

webhooks.get('/api/webhooks/outgoing', requireRole('owner', 'admin', 'staff'), get__api_webhooks_outgoing_11);

//  編集画面が現在値を読むための詳細口。secret は出さない。
webhooks.get('/api/webhooks/outgoing/:id', requireRole('owner', 'admin', 'staff'), get__api_webhooks_outgoing_id_1);

webhooks.post('/api/webhooks/outgoing', requireRole('owner', 'admin'), inputJsonBoundary({"name":["string"],"url":["string"],"eventTypes":["array"],"secret":["string"],"isActive":["boolean"],"lineAccountId":["string"]}), post__api_webhooks_outgoing_2);

webhooks.put('/api/webhooks/outgoing/:id', requireRole('owner', 'admin'), requireWebhookSecretOwner, inputJsonBoundary({"name":["string"],"url":["string"],"eventTypes":["array"],"secret":["string"],"isActive":["boolean"],"expectedVersion":["number"]}), put__api_webhooks_outgoing_id_3);

webhooks.post('/api/webhooks/outgoing/:id/test', requireRole('owner', 'admin'), inputJsonBoundary(), post__api_webhooks_outgoing_id_test_4);

webhooks.delete('/api/webhooks/outgoing/:id', requireRole('owner'), delete__api_webhooks_outgoing_id_5);

/**
 * 送信 Webhook の削除を取り消しても、突然送信を再開しないよう停止状態を保つ。未削除・不存在・範囲外は404/403で拒む。
 */
webhooks.post('/api/webhooks/outgoing/:id/restore', requireRole('owner'), inputJsonBoundary(), post__api_webhooks_outgoing_id_restore_6);

// ========== 送った・受け取ったやり取りの記録 ==========

webhooks.get('/api/webhooks/interactions/export.csv',requireRole('owner','admin','staff'),get__api_webhooks_interactions_export_csv_7);

webhooks.get('/api/webhooks/interactions', requireRole('owner', 'admin', 'staff'), get__api_webhooks_interactions_8);

webhooks.get('/api/webhooks/interactions/:id/payload', requireRole('owner', 'admin', 'staff'), get__api_webhooks_interactions_id_payload_9);

webhooks.post('/api/webhooks/interactions/:id/retry', requireRole('owner', 'admin'), inputJsonBoundary(), post__api_webhooks_interactions_id_retry_10);

webhooks.post('/api/webhooks/interactions/retry-failed', requireRole('owner', 'admin'), inputJsonBoundary(), post__api_webhooks_interactions_retry_failed_11);

// ========== secret の移行(所有者専用) ==========

/**
 * 既存の平文・旧鍵暗号文を現行鍵へ寄せる。
 *
 * - dryRun=true(既定)は件数だけ数えて書かない。先にこれで見積もりを取る。
 * - dryRun=false は batchSize 件ずつ移す。べき等なので中断したら呼び直す。
 * - 1行ごとに復号照合してから平文を消す。失敗行は残して報告に積む。
 * - 秘密値は要求にも応答にもログにも出さない。件数と成否だけ返す。
 */
webhooks.post('/api/webhooks/maintenance/secret-backfill', requireRole('owner'), inputJsonBoundary({"lineAccountId":["string"],"dryRun":["boolean"]}), post__api_webhooks_maintenance_secret_backfill_12);

// ========== 受信Webhookエンドポイント (外部システムからの受信) ==========

webhooks.post('/api/webhooks/incoming/:id/receive', inputJsonBoundary(), post__api_webhooks_incoming_id_receive_1);

webhooks.get('/api/webhooks/api-tokens', requireRole('owner', 'admin', 'staff'), get__api_webhooks_api_tokens_2);

webhooks.post('/api/webhooks/api-tokens', requireRole('owner'), inputJsonBoundary(), post__api_webhooks_api_tokens_3);

webhooks.post('/api/webhooks/api-tokens/:id/revoke', requireRole('owner'), inputJsonBoundary(), post__api_webhooks_api_tokens_id_revoke_4);

webhooks.post('/api/webhooks/api-tokens/:id/reactivate', requireRole('owner'), inputJsonBoundary(), post__api_webhooks_api_tokens_id_reactivate_5);

webhooks.post('/api/webhooks/api-tokens/:id/rotate', requireRole('owner'), inputJsonBoundary(), post__api_webhooks_api_tokens_id_rotate_6);

export { webhooks };
