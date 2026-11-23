import { formatYen } from '@line-crm/shared';
import { simplePdf } from '../services/affiliate-statement-pdf.js';
import { customerDownloadEntry } from '../services/download-entrypoints.js';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { Hono, type Context, type Next } from 'hono';
import {
  closeAffiliateAccountSettlement,
  consumeStepUpGrant,
  createAffiliatePayoutBatch,
  createAffiliateStatement,
  decryptCredential,
  getAffiliatePayoutBatchExport,
  getAffiliatePayoutDownload,
  getAffiliateStatementReplay,
  getClosedAccountSettlement,
  markAffiliatePayoutExported,
  prepareAffiliateStatement,
  previewAffiliateAccountSettlement,
} from '@line-crm/db';
import { DEFAULT_TENANT_ID } from '@line-crm/shared';
import type { Env } from '../worker-env.js';
import { auditLog } from '../lib/audit-log.js';
import { adminSessionTokenHashFromRequest, sha256Hex } from '../middleware/auth.js';
import { requireRole } from '../middleware/role-guard.js';
import { getVisibleLineAccountScope } from '../services/account-access.js';
import { notifyAffiliate } from '../services/affiliate-notifier.js';

export const affiliatePayouts = new Hono<Env>();

type AffiliatePermission =
  | 'affiliate.report.view'
  | 'affiliate.settlement.close'
  | 'affiliate.payout.export';

function affiliatePermission(permission: AffiliatePermission) {
  return async (c: Context<Env>, next: Next) => {
    const staff = c.get('staff');
    if (!staff || (staff.role === 'staff' && !staff.permissionKeys?.includes(permission))) {
      return c.json({ success: false, error: 'この操作を行う権限がありません' }, 403);
    }
    await next();
  };
}

function tenantId(c: Context<Env>): string {
  return c.get('staff')?.tenantId ?? DEFAULT_TENANT_ID;
}

async function accountVisible(c: Context<Env>, lineAccountId: string): Promise<boolean> {
  const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
  return scope.allowedAccountIds.includes(lineAccountId);
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function idempotencyKey(c: Context<Env>): string | null {
  const value = c.req.header('Idempotency-Key')?.trim() ?? '';
  return value.length >= 8 && value.length <= 200 ? value : null;
}

function positiveVersion(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function randomToken(bytes = 32): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}


affiliatePayouts.get(
  '/api/affiliate-settlements/preview',
  affiliatePermission('affiliate.report.view'),
  async (c) => {
    const lineAccountId = c.req.query('lineAccountId')?.trim();
    const periodFrom = c.req.query('periodFrom');
    const periodTo = c.req.query('periodTo');
    if (!lineAccountId || !validIso(periodFrom) || !validIso(periodTo) || Date.parse(periodFrom) > Date.parse(periodTo)) {
      return c.json({ success: false, error: '対象アカウントと正しい締め期間を指定してください' }, 400);
    }
    if (!await accountVisible(c, lineAccountId)) {
      return c.json({ success: false, error: '締め対象が見つかりません' }, 404);
    }
    try {
      const data = await previewAffiliateAccountSettlement(c.env.DB, {
        tenantId: tenantId(c), lineAccountId, periodFrom, periodTo,
      });
      return c.json({ success: true, data });
    } catch (error) {
      throw error;
    }
  },
);

/*
 * 締めたあと画面を離れても、明細発行・CSV準備を再開できるよう、
 * 期間で締め済み台帳を引き直す口。締め直しではなく既存台帳の読み出し。
 */
affiliatePayouts.get(
  '/api/affiliate-settlements/current',
  affiliatePermission('affiliate.report.view'),
  async (c) => {
    const lineAccountId = c.req.query('lineAccountId')?.trim();
    const periodFrom = c.req.query('periodFrom');
    const periodTo = c.req.query('periodTo');
    if (!lineAccountId || !validIso(periodFrom) || !validIso(periodTo) || Date.parse(periodFrom) > Date.parse(periodTo)) {
      return c.json({ success: false, error: '対象アカウントと正しい締め期間を指定してください' }, 400);
    }
    if (!await accountVisible(c, lineAccountId)) {
      return c.json({ success: false, error: '締め対象が見つかりません' }, 404);
    }
    try {
      const data = await getClosedAccountSettlement(c.env.DB, {
        tenantId: tenantId(c), lineAccountId, periodFrom, periodTo,
      });
      return c.json({ success: true, data });
    } catch (error) {
      throw error;
    }
  },
);

affiliatePayouts.post(
  '/api/affiliate-settlements',
  requireRole('owner', 'admin', 'staff'),
  affiliatePermission('affiliate.settlement.close'),
  inputJsonBoundary(), async (c) => {
    auditLog(c, 'affiliate.settlement.close', { kind: 'affiliate-settlement' });
    const key = idempotencyKey(c);
    type CloseBody = {
      lineAccountId?: unknown; periodFrom?: unknown; periodTo?: unknown; expectedPreviewVersion?: unknown;
    };
    const body = await c.req.json<CloseBody>().catch((): CloseBody => ({}));
    if (!key || typeof body.lineAccountId !== 'string' || !validIso(body.periodFrom)
      || !validIso(body.periodTo) || Date.parse(body.periodFrom) > Date.parse(body.periodTo)
      || typeof body.expectedPreviewVersion !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedPreviewVersion)) {
      return inputError(c, { success: false, error: '締め期間、版、再実行キーを確認してください' }, 400, ["lineAccountId","periodFrom","periodTo","expectedPreviewVersion"]);
    }
    if (!await accountVisible(c, body.lineAccountId)) {
      return c.json({ success: false, error: '締め対象が見つかりません' }, 404);
    }
    try {
      const requestFingerprint = await sha256Hex(JSON.stringify({
        lineAccountId: body.lineAccountId, periodFrom: body.periodFrom,
        periodTo: body.periodTo, expectedPreviewVersion: body.expectedPreviewVersion,
      }));
      const result = await closeAffiliateAccountSettlement(c.env.DB, {
        tenantId: tenantId(c), lineAccountId: body.lineAccountId,
        periodFrom: body.periodFrom, periodTo: body.periodTo,
        expectedPreviewVersion: body.expectedPreviewVersion,
        actorId: c.get('staff')!.id, idempotencyKey: key, requestFingerprint,
      });
      if (result.kind === 'empty') return c.json({ success: false, error: '締め対象がありません' }, 409);
      if (result.kind === 'changed') return c.json({ success: false, error: '締め対象が更新されています', code: 'VERSION_CONFLICT' }, 409);
      if (result.kind === 'idempotency_conflict') return c.json({ success: false, error: '同じ再実行キーが別の入力に使われています', code: 'IDEMPOTENCY_CONFLICT' }, 409);
      return c.json({ success: true, data: result }, result.kind === 'created' ? 201 : 200);
    } catch (error) {
      throw error;
    }
  },
);

affiliatePayouts.post(
  '/api/affiliate-payout-batches',
  requireRole('owner', 'admin', 'staff'),
  affiliatePermission('affiliate.payout.export'),
  inputJsonBoundary(), async (c) => {
    auditLog(c, 'affiliate.payout.create', { kind: 'affiliate-payout-batch' });
    const key = idempotencyKey(c);
    type BatchBody = {
      lineAccountId?: unknown; settlementId?: unknown; expectedVersion?: unknown; bankFormat?: unknown;
    };
    const body = await c.req.json<BatchBody>().catch((): BatchBody => ({}));
    const version = positiveVersion(body.expectedVersion);
    if (!key || typeof body.lineAccountId !== 'string' || typeof body.settlementId !== 'string'
      || !version || body.bankFormat !== 'zengin_csv') {
      return inputError(c, { success: false, error: '支払対象、版、銀行形式、再実行キーを確認してください' }, 400, ["lineAccountId","settlementId","expectedVersion","bankFormat"]);
    }
    if (!await accountVisible(c, body.lineAccountId)) {
      return c.json({ success: false, error: '支払対象が見つかりません' }, 404);
    }
    try {
      const requestFingerprint = await sha256Hex(JSON.stringify(body));
      const result = await createAffiliatePayoutBatch(c.env.DB, {
        tenantId: tenantId(c), lineAccountId: body.lineAccountId,
        settlementId: body.settlementId, expectedVersion: version,
        bankFormat: 'zengin_csv', actorId: c.get('staff')!.id,
        idempotencyKey: key, requestFingerprint,
      });
      if (result.kind === 'not_found') return c.json({ success: false, error: '支払対象が見つかりません' }, 404);
      if (result.kind === 'bank_missing') return c.json({ success: false, error: '振込先が未登録の紹介者がいます', missingAffiliateIds: result.missingAffiliateIds }, 409);
      if (result.kind === 'changed' || result.kind === 'idempotency_conflict') {
        return c.json({ success: false, error: '支払対象または再実行キーが競合しました', code: 'VERSION_CONFLICT' }, 409);
      }
      return c.json({ success: true, data: result.batch }, result.kind === 'created' ? 201 : 200);
    } catch (error) {
      throw error;
    }
  },
);

affiliatePayouts.post(
  '/api/affiliate-payout-batches/:id/export',
  requireRole('owner', 'admin', 'staff'),
  affiliatePermission('affiliate.payout.export'),
  inputJsonBoundary(), async (c) => {
    auditLog(c, 'affiliate.payout.export', { kind: 'affiliate-payout-batch', id: c.req.param('id') });
    const key = idempotencyKey(c);
    type ExportBody = { lineAccountId?: unknown; expectedVersion?: unknown };
    const body = await c.req.json<ExportBody>().catch((): ExportBody => ({}));
    const version = positiveVersion(body.expectedVersion);
    if (!key || typeof body.lineAccountId !== 'string' || !version) {
      return inputError(c, { success: false, error: '支払バッチ、版、再実行キーを確認してください' }, 400, ["lineAccountId","expectedVersion"]);
    }
    const lineAccountId = body.lineAccountId;
    const batchId = c.req.param('id');
    if (!batchId || !await accountVisible(c, lineAccountId)) {
      return c.json({ success: false, error: '支払バッチが見つかりません' }, 404);
    }
    const stepUpToken = c.req.header('X-Step-Up-Token')?.trim();
    if (!stepUpToken || !await consumeStepUpGrant(c.env.DB, {
      tokenHash: await sha256Hex(stepUpToken), staffId: c.get('staff')!.id,
      purpose: 'affiliate.payout.export',
      sessionTokenHash: await adminSessionTokenHashFromRequest(c),
    })) {
      return c.json({ success: false, error: 'CSV出力には二段階認証による再認証が必要です', code: 'STEP_UP_REQUIRED' }, 428);
    }
    try {
      const exportData = await getAffiliatePayoutBatchExport(c.env.DB, {
        tenantId: tenantId(c), lineAccountId, batchId,
      });
      if (!exportData) return c.json({ success: false, error: '支払バッチが見つかりません' }, 404);
      const requestFingerprint = await sha256Hex(JSON.stringify(body));
      const replay = exportData.batch.state === 'exported'
        && exportData.batch.export_idempotency_key === key
        && exportData.batch.export_request_fingerprint === requestFingerprint;
      if (!replay && (Number(exportData.batch.version) !== version || exportData.batch.state !== 'created')) {
        return c.json({ success: false, error: '支払バッチが更新されています', code: 'VERSION_CONFLICT' }, 409);
      }
      const decrypted = await Promise.all(exportData.lines.map(async (line) => ({
        ...line,
        accountNumber: await decryptCredential(line.encryptedAccountNumber, c.env.LINE_CREDENTIAL_ENCRYPTION_KEY),
      })));
      const csv = '\uFEFF' + [
        ['bank_code', 'bank_name', 'branch_code', 'branch_name', 'account_type', 'account_number', 'account_holder', 'amount_jpy'],
        ...decrypted.map((line) => [
          line.bankCode, line.bankName, line.branchCode, line.branchName,
          line.accountType === 'ordinary' ? '1' : '2', line.accountNumber,
          line.accountHolderName, line.amount,
        ]),
      ].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
      const bytes = new TextEncoder().encode(csv);
      const checksum = await sha256Hex(csv);
      const token = randomToken();
      const objectKey = `affiliate-payouts/${lineAccountId}/${batchId}-${checksum.slice(0, 12)}.csv`;
      const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
      await c.env.IMAGES.put(objectKey, bytes, { httpMetadata: { contentType: 'text/csv; charset=utf-8' } });
      const result = await markAffiliatePayoutExported(c.env.DB, {
        tenantId: tenantId(c), lineAccountId, batchId,
        expectedVersion: version, idempotencyKey: key, requestFingerprint, objectKey,
        checksum, expiresAt, downloadTokenHash: await sha256Hex(token),
      });
      if (result.kind === 'changed' || result.kind === 'idempotency_conflict') {
        return c.json({ success: false, error: '支払バッチまたは再実行キーが競合しました', code: 'VERSION_CONFLICT' }, 409);
      }
      c.set('outputAudit', { count: exportData.lines.length, accountId: lineAccountId, targetId: batchId, phase: 'requested' });
      return c.json({
        success: true,
        data: {
          ...result.batch,
          downloadUrl: `/api/affiliate-payout-batches/${result.batch.id}/download?lineAccountId=${encodeURIComponent(lineAccountId)}&token=${encodeURIComponent(token)}`,
        },
      });
    } catch (error) {
      throw error;
    }
  },
);

affiliatePayouts.get(
  '/api/affiliate-payout-batches/:id/download',
  affiliatePermission('affiliate.payout.export'),
  async (c) => {
    auditLog(c, 'affiliate.payout.download', { kind: 'affiliate-payout-batch', id: c.req.param('id') });
    const lineAccountId = c.req.query('lineAccountId')?.trim();
    const token = c.req.query('token')?.trim();
    const batchId = c.req.param('id');
    if (!lineAccountId || !token || !batchId || !await accountVisible(c, lineAccountId)) {
      return c.json({ success: false, error: '出力ファイルが見つかりません' }, 404);
    }
    const file = await getAffiliatePayoutDownload(c.env.DB, {
      tenantId: tenantId(c), lineAccountId, batchId, tokenHash: await sha256Hex(token),
    });
    if (!file) return c.json({ success: false, error: '出力ファイルが見つからないか期限切れです' }, 404);
    c.set('outputAudit', { count: file.lineCount, accountId: lineAccountId, targetId: batchId });
    const object = await c.env.IMAGES.get(file.objectKey);
    if (!object) return c.json({ success: false, error: '出力ファイルが見つかりません' }, 404);
    return new Response(object.body, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="affiliate-payout-${batchId}.csv"`,
        'Cache-Control': 'private, no-store',
      },
    });
  },
);

affiliatePayouts.post(
  '/api/affiliate-statements',
  requireRole('owner', 'admin', 'staff'),
  affiliatePermission('affiliate.settlement.close'),
  inputJsonBoundary(), async (c) => {
    auditLog(c, 'affiliate.statement.generate', { kind: 'affiliate-statement' });
    const key = idempotencyKey(c);
    type StatementBody = {
      lineAccountId?: unknown; settlementId?: unknown; affiliateId?: unknown; expectedVersion?: unknown;
    };
    const body = await c.req.json<StatementBody>().catch((): StatementBody => ({}));
    const version = positiveVersion(body.expectedVersion);
    if (!key || typeof body.lineAccountId !== 'string' || typeof body.settlementId !== 'string'
      || typeof body.affiliateId !== 'string' || !version) {
      return inputError(c, { success: false, error: '締め、紹介者、版、再実行キーを確認してください' }, 400, ["lineAccountId","settlementId","affiliateId","expectedVersion"]);
    }
    if (!await accountVisible(c, body.lineAccountId)) {
      return c.json({ success: false, error: '明細対象が見つかりません' }, 404);
    }
    try {
      const requestFingerprint = await sha256Hex(JSON.stringify(body));
      const replay = await getAffiliateStatementReplay(c.env.DB, {
        tenantId: tenantId(c), lineAccountId: body.lineAccountId, idempotencyKey: key,
      });
      if (replay) {
        if (replay.requestFingerprint !== requestFingerprint) {
          return c.json({ success: false, error: '同じ再実行キーが別の入力に使われています', code: 'IDEMPOTENCY_CONFLICT' }, 409);
        }
        return c.json({ success: true, data: replay.statement });
      }
      const snapshot = await prepareAffiliateStatement(c.env.DB, {
        tenantId: tenantId(c), lineAccountId: body.lineAccountId,
        settlementId: body.settlementId, affiliateId: body.affiliateId,
      });
      if (!snapshot) return c.json({ success: false, error: '明細対象が見つかりません' }, 404);
      if (snapshot.settlementVersion !== version) {
        return c.json({ success: false, error: '締め内容が更新されています', code: 'VERSION_CONFLICT' }, 409);
      }
      const pdf = simplePdf({...snapshot,exportedBy:c.get('staff').id,exportedAt:new Date().toISOString()});
      const checksum = await sha256Hex(new TextDecoder().decode(pdf));
      const objectKey = `affiliate-statements/${body.lineAccountId}/${randomToken(18)}.pdf`;
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString();
      await c.env.IMAGES.put(objectKey, pdf, { httpMetadata: { contentType: 'application/pdf' } });
      const statement = await createAffiliateStatement(c.env.DB, {
        tenantId: tenantId(c), lineAccountId: body.lineAccountId, snapshot,
        objectKey, checksum, idempotencyKey: key, requestFingerprint,
        actorId: c.get('staff')!.id, expiresAt,
      });
      await notifyAffiliate(
        c.env.DB,
        c.env,
        body.affiliateId,
        `支払明細を発行しました。確定額: ${formatYen(snapshot.totalAmount)}。LINEで本人確認して確認できます。\n${customerDownloadEntry(c.env.WORKER_PUBLIC_URL || c.env.WORKER_URL || new URL(c.req.url).origin, 'statements', statement.id)}`,
      );
      return c.json({ success: true, data: statement, notificationAttempted: true }, 201);
    } catch (error) {
      throw error;
    }
  },
);
