import { inputJsonBoundary } from '../lib/input-errors.js';
import { getFormPublicImage } from './form-public-image.js';

import { Hono } from 'hono';

import type { Env } from '../worker-env.js';

import { denyReadOnly, requireIrreversibleConfirmation, requireRole, requireDeliveryAccess } from '../middleware/role-guard.js';

import { get__api_forms_1, get__api_forms_unassigned_2, get__api_forms_id_3, post__api_forms_id_publish_4, post__api_forms_id_test_token_5, post__api_forms_6, post__api_forms_drafts_7, post__api_forms_id_duplicate_8, put__api_forms_id_9, get__api_forms_id_delete_impact_10 } from './forms-configuration.js';

import { post__api_forms_id_archive_1, post__api_forms_id_unarchive_2, delete__api_forms_id_3, delete__api_forms_id_submissions_submissionId_4, post__api_forms_id_exports_5, get__api_forms_id_submissions_6, get__api_forms_id_submissions_submissionId_7, post__api_forms_id_submissions_submissionId_retry_effects_8 } from './forms-submissions.js';
import { requireArchiveManage, FORM_ARCHIVE_BODY_MAX_BYTES } from './forms-definition.js';
import { post__api_forms_id_opened_1, post__api_forms_id_partial_2, post__api_forms_id_files_3, get__api_forms_id_my_latest_4 } from './forms-public-intake.js';

import { post__api_forms_id_submit_1 } from './forms-public-submit.js';

const forms = new Hono<Env>();


forms.get('/api/forms', requireRole('owner', 'admin', 'staff'), get__api_forms_1);

/**
 * GET /api/forms/unassigned — 管理者確認専用。担当の決まっていない旧フォームだけを返す。
 *
 * 通常の `account_id` 指定一覧へは混ぜない。この口を選んだときだけ未割当を返す。
 * 見られるのは既定テナントの owner / admin と環境 owner だけ。一般 staff、
 * アカウント制限付き・機能スコープ付き・別テナントは不可。現行 canSeeUnassigned は
 * 一般 staff も含むため、その値だけでは許可せず role も requireRole で絞る。
 * 割当操作は置かない。
 *
 * `account_id` は必須（通常一覧と同じ）。結果には使わず、立ち位置の確認にだけ使う。
 * 無いと機能 enforcement が一覧用の絞り込みを staff へ書き込み、canSeeUnassigned が
 * 全員 false になって本番で誰も見られなくなる。そのため残さず受け取る。
 */
forms.get('/api/forms/unassigned', requireRole('owner', 'admin'), get__api_forms_unassigned_2);

// GET /api/forms/:id — get form
forms.get('/api/forms/:id', get__api_forms_id_3);
forms.get('/api/forms/:id/images/:blockId', getFormPublicImage);

// POST /api/forms/:id/publish — 保存済みの編集内容を不変版にして公開する。
forms.post('/api/forms/:id/publish', requireDeliveryAccess('forms', 'publish'), inputJsonBoundary(), post__api_forms_id_publish_4);

// POST /api/forms/:id/test-token — 公開前の試し合言葉を発行する。
//
// 下書きの編集ができる人だけが取れる。合言葉自体は1回だけ返し、台帳には
// SHA-256 の16進だけを残す。有効期限は24時間。試しで開く・答えるときは
// この合言葉を添え、集計に入れず、回答後アクションも動かさない。
forms.post('/api/forms/:id/test-token', inputJsonBoundary(), post__api_forms_id_test_token_5);

// POST /api/forms — create form
forms.post('/api/forms', inputJsonBoundary({"name":["string"],"description":["null","string"],"fields":["array"],"onSubmitTagId":["null","string"],"onSubmitScenarioId":["null","string"],"onSubmitMessageType":["null","string"],"onSubmitMessageContent":["null","string"],"onSubmitWebhookUrl":["null","string"],"onSubmitWebhookHeaders":["null","string"],"onSubmitWebhookFailMessage":["null","string"],"saveToMetadata":["boolean"],"ogTitle":["null","string"],"ogDescription":["null","string"],"ogImageUrl":["null","string"],"accountId":["string"]}), post__api_forms_6);

// POST /api/forms/drafts — 公開されていない空の下書きを作り、編集画面へ進む。
forms.post('/api/forms/drafts', inputJsonBoundary({"name":["string"],"accountId":["string"]}), post__api_forms_drafts_7);

/*
 * POST /api/forms/:id/duplicate — フォーム全体を別IDの下書きとして複製する。
 *
 * 引き継ぐのは中身だけ（名前・説明・質問・レイアウト・分岐・回答後の設定・
 * デザイン・所属フォルダ・利用アカウント）。引き継がないのは集まった回答・
 * 公開版・公開状態・集計（新しい ID なので回答・来訪・版は付いてこない）。
 * 複製は必ず受付停止（isActive: false）で作り、公開中の写しを作らない。
 */
forms.post('/api/forms/:id/duplicate', inputJsonBoundary(), post__api_forms_id_duplicate_8);

// PUT /api/forms/:id — update form
forms.put('/api/forms/:id', inputJsonBoundary({"name":["string"],"description":["null","string"],"fields":["array"],"folderId":["null","string"],"onSubmitTagId":["null","string"],"onSubmitScenarioId":["null","string"],"onSubmitMessageType":["null","string"],"onSubmitMessageContent":["null","string"],"onSubmitWebhookUrl":["null","string"],"onSubmitWebhookHeaders":["null","string"],"onSubmitWebhookFailMessage":["null","string"],"saveToMetadata":["boolean"],"isActive":["boolean"],"ogTitle":["null","string"],"ogDescription":["null","string"],"ogImageUrl":["null","string"]}), put__api_forms_id_9);

// GET /api/forms/:id/delete-impact — 回答・利用先・開けなくなるURLを同時に確認する。
forms.get('/api/forms/:id/delete-impact', requireDeliveryAccess('forms'), get__api_forms_id_delete_impact_10);

// POST /api/forms/:id/archive — 公開を止め、回答と利用先を残して保管する。
forms.post('/api/forms/:id/archive', requireArchiveManage, inputJsonBoundary({}, { maxBytes: FORM_ARCHIVE_BODY_MAX_BYTES }), post__api_forms_id_archive_1);

// POST /api/forms/:id/unarchive — 保管の取り消し（B 元に戻す）。
// 保管中の行だけ現行へ戻す。戻した直後は受付停止のまま。版がずれていたら
// 読み直しを促す（保管口と同じ競合守り）。
forms.post('/api/forms/:id/unarchive', requireArchiveManage, inputJsonBoundary({}, { maxBytes: FORM_ARCHIVE_BODY_MAX_BYTES }), post__api_forms_id_unarchive_2);

// DELETE /api/forms/:id — 影響0件・非公開・同じ版のときだけ物理削除する。
forms.delete('/api/forms/:id', requireDeliveryAccess('forms', 'archive'), delete__api_forms_id_3);

// フォーム全体でなく、回答1件とその非公開添付だけを対象にする。
forms.delete('/api/forms/:id/submissions/:submissionId', requireRole('owner', 'admin'), denyReadOnly(), requireIrreversibleConfirmation('delete-form-response'), delete__api_forms_id_submissions_submissionId_4);

// CSV は回答閲覧と分離し、明示的な書き出し権限で確認する。
forms.post('/api/forms/:id/exports', requireDeliveryAccess('forms', 'export'), post__api_forms_id_exports_5);

// GET /api/forms/:id/submissions — list submissions
forms.get('/api/forms/:id/submissions', requireRole('owner', 'admin', 'staff'), get__api_forms_id_submissions_6);

// 回答詳細を、一覧と同じ版・後処理の情報で読む。
forms.get('/api/forms/:id/submissions/:submissionId', requireRole('owner', 'admin', 'staff'), get__api_forms_id_submissions_submissionId_7);

forms.post('/api/forms/:id/submissions/:submissionId/retry-effects', inputJsonBoundary(), post__api_forms_id_submissions_submissionId_retry_effects_8);

// POST /api/forms/:id/opened — record form open event (public, used by LIFF)
forms.post('/api/forms/:id/opened', inputJsonBoundary(), post__api_forms_id_opened_1);

// POST /api/forms/:id/partial — save survey answers without x_username (public, used by LIFF page 1)
forms.post('/api/forms/:id/partial', inputJsonBoundary({"data":["object"]}), post__api_forms_id_partial_2);

/**
 * POST /api/forms/:id/files — 回答に添付する画像を預かる（回答画面から使う）
 *
 * 友だちが送ってくるので、スタッフ用の `/api/images` は使えない。本人確認は
 * LIFF の id_token で行う。
 *
 * 誰でも投げられる口にしないため、次を満たしたときだけ受け取る。
 *
 *   - id_token で本人が特定できる（＝この公式アカウントの友だち）
 *   - フォームが公開中である
 *   - そのフォームに、実際にファイルを受け取るブロックがある
 *
 * 3つ目が無いと、フォームIDさえ知っていれば誰でも画像置き場として使える。
 */
forms.post('/api/forms/:id/files', inputJsonBoundary(), post__api_forms_id_files_3);

/**
 * GET /api/forms/:id/my-latest — 前回の自分の回答（回答画面から使う）
 *
 * オプションの「前回の回答を復元する」を入れているフォームだけが返す。
 * 入れていないフォームで前の回答を返すと、本人が消したつもりの値が
 * 別の端末で復活して見える。
 */
forms.get('/api/forms/:id/my-latest', get__api_forms_id_my_latest_4);

// POST /api/forms/:id/submit — submit form (public, used by LIFF)
//
// 再送・連打の二重受理を防ぐため、Idempotency-Key ヘッダ(UUID)を受け付ける。
// キーは回答行の id そのものになり、同じキーの再送は保存済みの行を返す。
// 同じキーで内容が違う使い回しは 409 で断る。キーが無い送信は従来どおり。
forms.post('/api/forms/:id/submit', inputJsonBoundary(), post__api_forms_id_submit_1);

export { forms };
