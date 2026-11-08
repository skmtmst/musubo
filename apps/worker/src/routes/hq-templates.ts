import { UnexpectedRouteError } from '../lib/unhandled-error.js';
import { searchHqResources } from '../services/hq-templates/resource-search.js';
import { listDistributionTargets } from '../services/hq-templates/distribution-display.js';
import { testHqForm, issueHqFormTestToken, revokeHqFormTestToken } from '../services/hq-templates/form-test.js';
import { restoreArchivedTemplate, templateArchiveStatus } from '../services/hq-templates/archive.js';
import { importHqTags } from '../services/hq-templates/tag-import.js';
import { previewRichMenu } from '../services/hq-templates/rich-menu-preview.js';
import { messageTemplateSearchIds, listTemplateViews, saveTemplateView, archiveTemplateView } from '../services/hq-templates/saved-views.js';
import { markListStats } from '../services/hq-templates/mark-list-stats.js';
import { folderInputError, inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { swapHqFolderOrder, HqFolderError } from '@line-crm/db';
import { HQ_TEMPLATE_TYPES, getStaffById, getHqTemplate, type HqTemplateType } from '@line-crm/db';
import { isFriendAttributeType, preflightFriendAttribute, distributeFriendAttribute, friendAttributeResult } from '../services/hq-templates/friend-attribute-distribution.js';
import { TEMPLATE_KINDS, type TemplateKindCounts, type TemplateKind } from '@line-crm/shared';

import { listTemplateFolders, saveTemplateFolder, deleteTemplateFolder, duplicateTemplate } from '../services/hq-templates/folders.js';
import { listMessageReferences } from '../services/hq-templates/message-card-references.js';
import { deleteHqImage, uploadHqImage, uploadHqImagemap } from '../services/hq-templates/authoring-media.js';
import { TemplateHqTemplateError } from '../services/hq-templates/template.js';
import { createHqMediaSession, completeHqMediaSession, cancelHqMediaSession, listHqRegisteredMedia } from '../services/hq-media.js';
import { Hono, type Context } from 'hono';


import { dbFor } from '../services/db-router.js';
import type { Env } from '../worker-env.js';
import { requireHqTemplateAuthority, type HqTemplateAuthority } from '../services/hq-templates/contract.js';
import { requireRole } from '../middleware/role-guard.js';
import { templateVersions, compareTemplateVersions, restoreTemplateVersion, templateReceivedVersions, HqTemplateError, templateCreationRequestId, listTemplates, listTemplateAccounts, templateDetail, saveTemplate, deleteTemplate, preflightDistribution, distributeTemplate, distributionResult, type DistributionSelection } from '../services/hq-templates/distribution.js';

export const hqTemplates = new Hono<Env>();
async function authority(c: Context<Env>): Promise<HqTemplateAuthority> {
  const staff = c.get('staff');
  if(c.get('impersonation')&&!['GET','HEAD'].includes(c.req.method))throw new HqTemplateError('FORBIDDEN',403);
  if (!staff || !staff.tenantId) throw new HqTemplateError('FORBIDDEN', 403);
  const member = await getStaffById(dbFor(c.env), staff.id);
  // DB 上の本人が見つからないことを、統括全体の管理権限として扱わない。
  if (!member || member.is_active !== 1 || member.tenant_id !== staff.tenantId) throw new HqTemplateError('FORBIDDEN', 403);
  const auth = requireHqTemplateAuthority({ tenantId: staff.tenantId, actorId: staff.id,
    role: member.role, hqRole: staff.hqRole, readOnly: ['GET','HEAD'].includes(c.req.method) && staff.hqRole !== 'viewer'
      ? false : staff.readOnly || member.access_level === 'read_only', accountScoped: member.account_scope === 'accounts' });
  if (auth.kind !== 'AUTHORIZED') throw new HqTemplateError('FORBIDDEN', 403);
  return auth.authority;
}
const reasons: Record<string, string> = {
  PUBLIC_IMAGE_REFERENCE_UNSUPPORTED: '登録画像を参照するフォームは、画像の各店への複製にまだ対応していないため配れません。画像の参照を外して確認してください',
  FORM_STORE_REFERENCE_UNAVAILABLE: '配り先のお店に同じキーの公開できる共通情報がありません。お店の情報の参照を確認してください',
  INVALID_MEDIA: '動画はMP4、音声はM4Aで選んでください。ファイルの長さを読み取れるか確認してください',
  MEDIA_SIZE_LIMIT: '動画・音声は200MB以内、プレビュー画像は1MB以内で選んでください',
  DIRECT_UPLOAD_UNAVAILABLE: '直接アップロードが未設定です。統括の管理者に頼んでください',
  UPLOAD_EXPIRED: 'アップロード期限が切れました。ファイルを選び直してください',
  UPLOAD_UNCONFIRMED: 'アップロードの完了を確認できません。もう一度確認してください',
  MEDIA_SCAN_PENDING: 'ファイルの安全性を確かめています。少し待って再確認してください',
  MEDIA_IN_USE: '保存済みのファイルは削除できません',
  SOURCE_MEDIA_UNAVAILABLE: 'ファイルを確認できません。選び直してください',
  DISPLAY_TAG_UNAVAILABLE: '配り先に同じ名前の有効なタグが1件あるか確認してください',
  LIFF_UNAVAILABLE: '配り先のLINEアカウントにLIFFが設定されていません。LIFFを設定してから配り直してください',
  CARD_REFERENCE_UNAVAILABLE: '配り先に同じ名前のフォーム・シナリオ・予約メニュー・スタンプカードが1件だけあるか、LIFFが設定されているか確認してください',
  INVALID_REQUEST_ID: '作成依頼の識別情報を確認してください',
  IDEMPOTENCY_CONFLICT: '同じ作成依頼の内容が変わっています。元の内容で再確認してください',
  CREATE_RECEIPT_UNAVAILABLE: '作成済みの記録を確認できません。一覧から状態を確認してください',
  FOLDER_NAME_CONFLICT: '同じ名前の分類があります',
  FORBIDDEN: '統括の編集権限が必要です', NOT_FOUND: '対象が見つかりません', INVALID_IMAGE: '画像の指定を確認してください',
  UNSUPPORTED: 'この種類のひな形はまだ利用できません',
  VERSION_CONFLICT: '編集がありました。もう一度確認してください',
  SELECTION_REQUIRED: '重複した項目ごとに上書きか別名を選んでください',
  SELECTION_CHANGED: '実行済みの選択は変更できません。結果を確認してください',
  FOLDER_SELECTION_CONFLICT: '親フォルダを別名にする場合は、子フォルダも別名にしてください',
};
async function body(c: { req: { text(): Promise<string> } }): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (text.length > 2_000_000) throw new HqTemplateError('REQUEST_TOO_LARGE');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new HqTemplateError('INVALID_REQUEST'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HqTemplateError('INVALID_REQUEST');
  return value as Record<string, unknown>;
}
hqTemplates.onError((error, c) => {
  if (error instanceof UnexpectedRouteError) throw error;
  if (!(error instanceof HqTemplateError)) throw new UnexpectedRouteError(c, { success: false, code: 'UNAVAILABLE', error: '処理結果を確認できません。再確認してください' });
  const code = error.code;
  return inputError(c, { success: false, code, ...((error.status === 400 || error.status === 422) ? { fields: error.fields } : {}), error: reasons[code] ?? (error.status < 500 ? '入力内容を確認してください' : '処理結果を確認できません。再確認してください') }, error.status);
});
// 単独で route を登録しても保護されるよう、入口内にも境界を置く。
hqTemplates.use('/api/hq/templates/*', requireRole('owner', 'admin'), async (c, next) => {
  try { await authority(c); await next(); }
  catch (error) {
    if (error instanceof UnexpectedRouteError) throw error;
    if (!(error instanceof HqTemplateError)) throw new UnexpectedRouteError(c, { success: false, code: 'UNAVAILABLE', error: '処理結果を確認できません。しばらくしてから再確認してください' });
    const code = error.code;
    return inputError(c, { success: false, ...((error.status === 400 || error.status === 422) ? { fields: error.fields } : {}), error: reasons[code] ?? (error.status < 500 ? '入力内容を確認してください' : '処理結果を確認できません。しばらくしてから再確認してください'), code }, error.status);
  }
});
hqTemplates.get('/api/hq/templates/media',async c=>c.json({success:true,data:await listHqRegisteredMedia(dbFor(c.env),c.env.IMAGES,await authority(c),{kind:c.req.query('kind'),cursor:c.req.query('cursor'),limit:c.req.query('limit')})}));
hqTemplates.post('/api/hq/templates/media/upload-sessions', async c => {
  return c.json({ success: true, data: await createHqMediaSession(c.env, dbFor(c.env), await authority(c), await body(c)) }, 201);
});
hqTemplates.post('/api/hq/templates/media/upload-sessions/:id/complete', async c => {
  return c.json({ success: true, data: await completeHqMediaSession(c.env, dbFor(c.env), await authority(c), c.req.param('id'), (await body(c)).etag, c.env.WORKER_URL || new URL(c.req.url).origin) }, 201);
});
hqTemplates.delete('/api/hq/templates/media/upload-sessions/:id', async c => {
  return c.json({ success: true, data: await cancelHqMediaSession(c.env.IMAGES, dbFor(c.env), await authority(c), c.req.param('id')) });
});
hqTemplates.post('/api/hq/templates/media', inputJsonBoundary(), async c => {
  const auth = await authority(c);
  try {
    const data = ['rich_message','rich_video_preview'].includes(c.req.query('purpose') ?? '')
      ? await uploadHqImagemap(c.env, auth, c.req.raw, c.env.WORKER_URL || new URL(c.req.url).origin)
      : await uploadHqImage(c.env.IMAGES, auth, c.req.raw, c.env.WORKER_URL || new URL(c.req.url).origin);
    return c.json({ success: true, data }, 201);
  } catch (error) {
    if (error instanceof TemplateHqTemplateError) throw new HqTemplateError(error.code, 422);
    throw error;
  }
});
// 未採用のアップロードを回収する。deleteHqImage 内で所有権を確認し、別統括は NOT_FOUND にする。
hqTemplates.delete('/api/hq/templates/media', async c => {
  const auth = await authority(c);
  try {
    const key = c.req.query('r2Key');
    if (key?.startsWith(`hq-templates/${auth.tenantId}/uploads/`)) {
      // 履歴を含む保存済みの版・実行が参照するファイルは保持する。
      const adopted = await dbFor(c.env).prepare(`SELECT 1 AS used WHERE EXISTS(
        SELECT 1 FROM hq_template_versions v,json_tree(v.definition_json) j WHERE v.tenant_id=? AND j.type='text' AND (j.value=? OR j.value LIKE ?))
        OR EXISTS(SELECT 1 FROM hq_broadcast_runs r,json_tree(r.input_json) j WHERE r.tenant_id=? AND j.type='text' AND (j.value=? OR j.value LIKE ?))`)
        .bind(auth.tenantId,key,`%/images/${key}`,auth.tenantId,key,`%/images/${key}`).first();
      if (adopted) throw new HqTemplateError('MEDIA_IN_USE', 409);
    }
    const data = await deleteHqImage(c.env.IMAGES, auth, c.req.query('r2Key'));
    return c.json({ success: true, data });
  } catch (error) {
    if (error instanceof TemplateHqTemplateError) throw new HqTemplateError(error.code, error.code === 'NOT_FOUND' ? 404 : 422);
    throw error;
  }
});
hqTemplates.post('/api/hq/templates/rich-menu-preview', inputJsonBoundary(), async c => c.json({success:true,data:await previewRichMenu(dbFor(c.env),await authority(c),await body(c),c.env.IMAGES)}));
for(const [suffix,execute] of [['/preview',false],['',true]] as const)hqTemplates.post(`/api/hq/templates/tags/import${suffix}`,inputJsonBoundary(),async c=>c.json({success:true,data:await importHqTags(dbFor(c.env),await authority(c),await body(c),execute)}));
hqTemplates.get('/api/hq/templates/saved-views', async c => c.json({success:true,data:await listTemplateViews(dbFor(c.env),await authority(c))}));
hqTemplates.post('/api/hq/templates/saved-views', inputJsonBoundary(), async c => c.json({success:true,data:await saveTemplateView(dbFor(c.env),await authority(c),await body(c))},201));
hqTemplates.patch('/api/hq/templates/saved-views/:viewId', inputJsonBoundary(), async c => c.json({success:true,data:await saveTemplateView(dbFor(c.env),await authority(c),await body(c),c.req.param('viewId'))}));
hqTemplates.delete('/api/hq/templates/saved-views/:viewId', async c => c.json({success:true,data:await archiveTemplateView(dbFor(c.env),await authority(c),c.req.param('viewId'),(await body(c)).expectedRevision)}));
hqTemplates.get('/api/hq/templates/accounts', async c => c.json({ success: true, data: await listTemplateAccounts(dbFor(c.env), await authority(c)) }));
hqTemplates.get('/api/hq/templates/message-references', async c => c.json({ success: true, data: await listMessageReferences(dbFor(c.env), await authority(c)) }));
hqTemplates.get('/api/hq/templates/kind-counts', async c => {
  const rows=await listTemplates(dbFor(c.env),await authority(c),'template');
  const counts=Object.fromEntries(TEMPLATE_KINDS.map(kind=>[kind,rows.filter(row=>row.kind===kind).length])) as TemplateKindCounts;
  return c.json({success:true,data:counts});
});
hqTemplates.get('/api/hq/templates', async c => {
  const status = templateArchiveStatus(c.req.query('status'));
  const search=c.req.query('search');
  const folder=c.req.query('folder_id');
  const undistributed=c.req.query('undistributed');
  if(undistributed!==undefined&&!['true','false'].includes(undistributed))throw new HqTemplateError('INVALID_LIST_FILTER');
  const searchIds=search===undefined?null:await messageTemplateSearchIds(dbFor(c.env),await authority(c),search,status);
  const messageCount = c.req.query('message_count');
  const hasInterpolations = c.req.query('has_interpolations');
  if (messageCount !== undefined && !['single', 'multiple'].includes(messageCount)
    || hasInterpolations !== undefined && !['true', 'false'].includes(hasInterpolations)) throw new HqTemplateError('INVALID_LIST_FILTER');
  const type = c.req.query('type');
  if (type && !HQ_TEMPLATE_TYPES.includes(type as HqTemplateType)) throw new HqTemplateError('INVALID_TYPE');
  const kind=c.req.query('kind');
  const attributeType=kind==='friend_field'?'friend_field':kind==='support_mark'?'mark':null;
  if(attributeType&&type&&type!==attributeType) throw new HqTemplateError('INVALID_KIND');
  if(kind&&!attributeType && (kind==='tag' ? (type && type!=='tag') : (!TEMPLATE_KINDS.includes(kind as TemplateKind) || (type && type!=='template')))) throw new HqTemplateError('INVALID_KIND');
  const allRows=await listTemplates(dbFor(c.env),await authority(c),attributeType??(kind==='tag'?'tag':kind?'template':type as HqTemplateType | undefined),'all');
  const matchesKind=(row:typeof allRows[number])=>!kind||kind==='tag'||!!attributeType||row.kind===kind;
  const archiveCounts={active:allRows.filter(row=>matchesKind(row)&&!row.archived_at).length,archived:allRows.filter(row=>matchesKind(row)&&!!row.archived_at).length};
  const rows=allRows.filter(row=>status==='all'||(status==='archived'?!!row.archived_at:!row.archived_at));
  const counts=Object.fromEntries(TEMPLATE_KINDS.map(k=>[k,rows.filter(row=>row.kind===k).length])) as TemplateKindCounts;
  const selectedType=attributeType??type;
  const attributeStats=isFriendAttributeType(selectedType??'')?{
    totalTemplates:rows.length,undistributedTemplateCount:rows.filter(r=>r.distributed_account_count===0).length,
    distributedAccountCount:Number((await dbFor(c.env).prepare(`SELECT COUNT(DISTINCT r.target_account_id) count FROM hq_template_distribution_results r
      JOIN hq_templates t ON t.id=r.template_id AND t.tenant_id=r.tenant_id
      JOIN line_accounts a ON a.id=r.target_account_id AND a.tenant_id=r.tenant_id
      WHERE r.tenant_id=? AND (?='all' OR (?='archived' AND t.archived_at IS NOT NULL) OR (?='active' AND t.archived_at IS NULL)) AND t.friend_attribute_type=? AND r.status='succeeded'
        AND NOT EXISTS(SELECT 1 FROM hq_template_preflight_resolutions p WHERE p.preflight_id=r.preflight_id AND p.tenant_id=r.tenant_id AND p.friend_attribute_mode='skip')`).bind((await authority(c)).tenantId,status,status,status,selectedType).first<{count:number}>())?.count??0),
  }:{};
  const markStats = selectedType === 'mark' ? await markListStats(dbFor(c.env), (await authority(c)).tenantId) : undefined;
  const filtered = rows.filter(row => (!searchIds || searchIds.has(row.id))
    && (folder===undefined || (folder===''?row.folder_id==null:row.folder_id===folder))
    && (undistributed===undefined || (row.distributed_account_count===0)===(undistributed==='true'))
    && (!messageCount || (messageCount === 'single' ? row.message_count === 1 : typeof row.message_count === 'number' && row.message_count > 1))
    && (hasInterpolations === undefined || row.has_interpolations === (hasInterpolations === 'true')));
  return c.json({success:true,data:filtered.filter(matchesKind),status,archive_counts:archiveCounts,kind_counts:counts,stats:{...attributeStats,...(markStats ? { supportStatus: markStats.inbox, markChanges: markStats.markChanges, scope: markStats.scope, updatedAt: markStats.updatedAt } : {}),thisMonthSentCount:rows.some(r=>r.this_month_sent_count===null)?null:rows.reduce((n,r)=>n+(r.this_month_sent_count??0),0),
    outdatedTemplateCount:rows.filter(r=>(r.outdated_account_count??0)>0).length}});
});
hqTemplates.get('/api/hq/templates/attribute-kind-counts',async c=>{
 const rows=await listTemplates(dbFor(c.env),await authority(c));
 return c.json({success:true,data:{tag:rows.filter(r=>r.template_type==='tag').length,friend_field:rows.filter(r=>r.template_type==='friend_field').length,support_mark:rows.filter(r=>r.template_type==='mark').length}});
});
hqTemplates.post('/api/hq/templates/folders/:id/swap-order',inputJsonBoundary({withId:['string'],expectedRevision:['number'],withExpectedRevision:['number']}),async c=>{
 const a=await authority(c),b=await body(c);
 try {return c.json({success:true,data:await swapHqFolderOrder(dbFor(c.env),'hq_template_folders',a.tenantId,c.req.param('id'),b as unknown as Parameters<typeof swapHqFolderOrder>[4])});}
 catch(e) {if(e instanceof HqFolderError)return folderInputError(c, e);throw e;}
});
hqTemplates.get('/api/hq/templates/folders', async c => c.json({ success:true, data:await listTemplateFolders(dbFor(c.env),await authority(c)) }));
hqTemplates.post('/api/hq/templates/folders', inputJsonBoundary({ name: ['string'], color: ['string', 'null'] }), async c => c.json({ success:true, data:await saveTemplateFolder(dbFor(c.env),await authority(c),await body(c)) },201));
hqTemplates.patch('/api/hq/templates/folders/:id', inputJsonBoundary({ name: ['string'], color: ['string', 'null'] }), async c => c.json({ success:true, data:await saveTemplateFolder(dbFor(c.env),await authority(c),await body(c),c.req.param('id')) }));
hqTemplates.delete('/api/hq/templates/folders/:id', async c => c.json({ success:true, data:await deleteTemplateFolder(dbFor(c.env),await authority(c),c.req.param('id'),(await body(c)).expectedRevision) }));
hqTemplates.post('/api/hq/templates/:id/duplicate', inputJsonBoundary(), async c => c.json({ success:true, data:await duplicateTemplate(dbFor(c.env),await authority(c),c.req.param('id'),await body(c)) },201));
hqTemplates.post('/api/hq/templates/:id/restore', inputJsonBoundary({expectedRevision:['number']}), async c => {
  const data=await restoreArchivedTemplate(dbFor(c.env),await authority(c),c.req.param('id'),(await body(c)).expectedRevision);
  c.set('auditRecorded',true);
  return c.json({success:true,data});
});
hqTemplates.get('/api/hq/templates/resources',async c=>{
 const auth=await authority(c);
 return c.json({success:true,data:await searchHqResources(dbFor(c.env),auth.tenantId,c.req.query())});
});
hqTemplates.get('/api/hq/templates/:id/distribution-targets',async c=>{
  const ids=c.req.query('accountIds')?.split(',')??[];
  if(ids.length>30||new Set(ids).size!==ids.length||ids.some(id=>!id||id.length>100)) throw new HqTemplateError('INVALID_REQUEST');
  const auth=await authority(c),data=await listDistributionTargets(dbFor(c.env),auth.tenantId,c.req.param('id'),ids);
  if(!data)throw new HqTemplateError('NOT_FOUND',404);
  return c.json({success:true,data});
});
hqTemplates.get('/api/hq/templates/:id/versions',async c=>c.json({success:true,data:await templateVersions(dbFor(c.env),await authority(c),c.req.param('id'))}));
hqTemplates.get('/api/hq/templates/:id/versions/compare',async c=>c.json({success:true,data:await compareTemplateVersions(dbFor(c.env),await authority(c),c.req.param('id'),Number(c.req.query('from')),Number(c.req.query('to')))}));
hqTemplates.post('/api/hq/templates/:id/versions/:version/restore',inputJsonBoundary(), async c=>{
  const input=await body(c),data=await restoreTemplateVersion(dbFor(c.env),await authority(c),c.req.param('id'),Number(c.req.param('version')),input.expectedRevision);
  c.set('auditRecorded',true);return c.json({success:true,data});
});
hqTemplates.get('/api/hq/templates/:id/received-versions',async c=>c.json({success:true,data:await templateReceivedVersions(dbFor(c.env),await authority(c),c.req.param('id'))}));
hqTemplates.get('/api/hq/templates/:id', async c => c.json({ success: true, data: await templateDetail(dbFor(c.env), await authority(c), c.req.param('id')) }));
hqTemplates.post('/api/hq/templates', inputJsonBoundary(), async c => {
  const auth = await authority(c), input = await body(c), headerKey = c.req.header('Idempotency-Key');
  if (headerKey !== undefined && input.requestId !== undefined && headerKey !== input.requestId) throw new HqTemplateError('INVALID_REQUEST_ID');
  input.requestId = templateCreationRequestId(headerKey ?? input.requestId);
  const data = await saveTemplate(dbFor(c.env), auth, input);
  c.set('auditRecorded', true);
  return c.json({ success: true, data }, 201);
});
hqTemplates.patch('/api/hq/templates/:id', inputJsonBoundary(), async c => {
  const data = await saveTemplate(dbFor(c.env), await authority(c), await body(c), c.req.param('id'));
  c.set('auditRecorded', true); return c.json({ success: true, data });
});
hqTemplates.delete('/api/hq/templates/:id', async c => {
  const input = await body(c);
  const data = await deleteTemplate(dbFor(c.env), await authority(c), c.req.param('id'), input.expectedRevision);
  c.set('auditRecorded', true); return c.json({ success: true, data });
});
hqTemplates.post('/api/hq/templates/:id/test-send',inputJsonBoundary(),async c=>c.json({success:true,data:await testHqForm(dbFor(c.env),await authority(c),c.req.param('id'),await body(c))}));
hqTemplates.post('/api/hq/templates/:id/test-token',inputJsonBoundary(),async c=>{
  c.header('Cache-Control','no-store');
  return c.json({success:true,data:await issueHqFormTestToken(dbFor(c.env),await authority(c),c.req.param('id'),await body(c),c.env.WORKER_URL||new URL(c.req.url).origin)},201);
});
hqTemplates.delete('/api/hq/templates/:id/test-tokens/:tokenId',async c=>c.json({success:true,data:await revokeHqFormTestToken(dbFor(c.env),await authority(c),c.req.param('id'),c.req.param('tokenId'))}));
hqTemplates.post('/api/hq/templates/:id/preflight', inputJsonBoundary(), async c => {
  const input = await body(c);
  if (!Array.isArray(input.accountIds) || input.accountIds.some(v => typeof v !== 'string')) throw new HqTemplateError('INVALID_ACCOUNTS');
  const auth=await authority(c),db=dbFor(c.env),{template}=await templateDetail(db,auth,c.req.param('id'));
  if(isFriendAttributeType(template.template_type)) {
    if(input.textOverrides!==undefined) throw new HqTemplateError('INVALID_DEFINITION');
    return c.json({success:true,data:await preflightFriendAttribute(db,auth,c.req.param('id'),input.accountIds as string[])});
  }
  return c.json({ success: true, data: await preflightDistribution(dbFor(c.env), await authority(c), c.req.param('id'), input.accountIds as string[], c.env.IMAGES, input.textOverrides) });
});
hqTemplates.post('/api/hq/templates/:id/distribute', inputJsonBoundary(), async c => {
  const input = await body(c);
  const auth=await authority(c),db=dbFor(c.env),{template}=await templateDetail(db,auth,c.req.param('id'));
  const modes=isFriendAttributeType(template.template_type)?['create','overwrite','alias','skip']:['create','overwrite','alias'];
  if (typeof input.preflightId !== 'string' || !Array.isArray(input.resolutions) || input.resolutions.length > 270 || input.resolutions.some(v => !v || typeof v !== 'object' || typeof v.accountId !== 'string' || typeof v.sourceId !== 'string' || !modes.includes(v.mode))) throw new HqTemplateError('INVALID_SELECTION');
  const data = isFriendAttributeType(template.template_type)
    ? await distributeFriendAttribute(db,auth,c.req.param('id'),input.preflightId,input.resolutions as Parameters<typeof distributeFriendAttribute>[4])
    : await distributeTemplate(dbFor(c.env), await authority(c), c.req.param('id'), input.preflightId, input.resolutions as DistributionSelection[], c.env.IMAGES, c.env.WORKER_URL || new URL(c.req.url).origin);
  c.set('auditRecorded', true); return c.json({ success: true, data });
});
hqTemplates.get('/api/hq/templates/:id/distributions/:runId', async c => {
  const auth=await authority(c),db=dbFor(c.env),template=await getHqTemplate(db,auth.tenantId,c.req.param('id'));
  if(!template) throw new HqTemplateError('NOT_FOUND',404);
  const data=isFriendAttributeType(template.template_type)?await friendAttributeResult(db,auth,c.req.param('id'),c.req.param('runId')):await distributionResult(db,auth,c.req.param('id'),c.req.param('runId'),c.env.IMAGES);
  return c.json({success:true,data});
});
