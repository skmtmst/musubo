import {
  HQ_TEMPLATE_DISTRIBUTION_MODES,
  HQ_TEMPLATE_TYPES,
  type HqTemplateDistributionMode,
  type HqTemplateStatement,
  type HqTemplateType,
} from '@line-crm/db';


export { HQ_TEMPLATE_DISTRIBUTION_MODES, HQ_TEMPLATE_TYPES };
export type { HqTemplateDistributionMode, HqTemplateStatement, HqTemplateType };

export const VERSION_CONFLICT_MESSAGE = '配布先で編集がありました。もう一度確認してください';

export type HqTemplateAuthority = Readonly<{
  tenantId: string;
  actorId: string;
  role: 'owner' | 'admin' | 'staff';
  hqRole?: 'operator' | 'viewer';
  readOnly: boolean;
  accountScoped: false;
}>;

export type HqTemplateAuthorityCandidate = Readonly<{
  tenantId: string | null | undefined;
  actorId: string | null | undefined;
  role: string | null | undefined;
  hqRole?: 'operator' | 'viewer' | null;
  readOnly: boolean;
  accountScoped: boolean;
}>;

export type HqTemplateAuthorityResult =
  | { kind: 'AUTHORIZED'; authority: HqTemplateAuthority }
  | { kind: 'FORBIDDEN'; reason: 'TENANT_REQUIRED' | 'ACTOR_REQUIRED' | 'ROLE_REQUIRED' | 'READ_ONLY' | 'ACCOUNT_SCOPED' };

export function requireHqTemplateAuthority(
  candidate: HqTemplateAuthorityCandidate,
): HqTemplateAuthorityResult {
  if (!candidate.tenantId) return { kind: 'FORBIDDEN', reason: 'TENANT_REQUIRED' };
  if (!candidate.actorId) return { kind: 'FORBIDDEN', reason: 'ACTOR_REQUIRED' };
  if (candidate.role !== 'owner' && candidate.role !== 'admin' && !(candidate.role === 'staff' && (candidate.hqRole === 'operator' || candidate.hqRole === 'viewer'))) {
    return { kind: 'FORBIDDEN', reason: 'ROLE_REQUIRED' };
  }
  if (candidate.hqRole === 'viewer' ? !candidate.readOnly : candidate.readOnly) return { kind: 'FORBIDDEN', reason: 'READ_ONLY' };
  if (candidate.accountScoped) return { kind: 'FORBIDDEN', reason: 'ACCOUNT_SCOPED' };
  return {
    kind: 'AUTHORIZED',
    authority: {
      tenantId: candidate.tenantId,
      actorId: candidate.actorId,
      role: candidate.role,
      ...(candidate.role === 'staff' ? { hqRole: candidate.hqRole! } : {}),
      readOnly: candidate.readOnly,
      accountScoped: false,
    },
  };
}

declare const snapshotTokenBrand: unique symbol;
export type HqTemplateSnapshotToken = string & { readonly [snapshotTokenBrand]: true };

export interface HqTemplateSnapshotState {
  schemaVersion: 1;
  rootHash: string;
  referenceHash: string;
  childHash: string;
  mediaKeyHash: string;
}

function stableSnapshotInput(state: HqTemplateSnapshotState): string {
  return JSON.stringify({
    schemaVersion: state.schemaVersion,
    rootHash: state.rootHash,
    referenceHash: state.referenceHash,
    childHash: state.childHash,
    mediaKeyHash: state.mediaKeyHash,
  });
}

export async function createHqTemplateSnapshotToken(
  state: HqTemplateSnapshotState,
  digest: (canonicalState: string) => string | Promise<string>,
): Promise<HqTemplateSnapshotToken> {
  const hash = await digest(stableSnapshotInput(state));
  if (!hash || /\s/.test(hash)) throw new Error('INVALID_SNAPSHOT_DIGEST');
  return `hqts1.${hash}` as HqTemplateSnapshotToken;
}

export function parseHqTemplateSnapshotToken(value: string): HqTemplateSnapshotToken | null {
  return /^hqts1\.[^\s]+$/.test(value) ? value as HqTemplateSnapshotToken : null;
}

export const HQ_TEMPLATE_COMMIT_PHASES = [
  'extract_references',
  'verify_tenant_and_target_account',
  'detect_duplicates',
  'build_id_map',
  'commit',
] as const;

export interface HqTemplateReference {
  kind: string;
  sourceId: string;
}

export interface HqTemplateMatchedReference extends HqTemplateReference {
  targetId: string;
}

export interface HqTemplateDuplicate {
  sourceId: string;
  targetId: string;
  reason: string;
}

/** 参照1件の事前確認を永続化し、秘密値は含めない。 */
export interface HqTemplateResolution {
  sourceId: string;
  itemKind: string;
  mode: HqTemplateDistributionMode;
  targetId?: string;
  aliasName?: string;
  expectedRevision?: string;
}

export type HqTemplateIdMap = Readonly<Record<string, string>>;

export interface HqTemplateOwnedR2Object {
  key: string;
  ownerToken: string;
  bytes: Uint8Array;
  /** 大きな不変メディアは必要時に複製し、長さ・ETag・SHA-256を検証する。 */
  streamSource?: import('../hq-media-stream.js').HqMediaStreamSource;
  contentType?: string;
}

export interface HqTemplateOwnedR2Key {
  key: string;
  ownerToken: string;
}

export interface HqTemplateStoreAtomicCommitPlan {
  tenantId: string;
  targetAccountId: string;
  preflightId: string;
  idempotencyFingerprint: string;
  snapshotToken: HqTemplateSnapshotToken;
  mode: HqTemplateDistributionMode;
  resolutions: readonly HqTemplateResolution[];
  stage: readonly HqTemplateOwnedR2Object[];
  dbCommit: readonly HqTemplateStatement[];
  compensateOnDbFailure: readonly HqTemplateOwnedR2Key[];
  reconcile: readonly HqTemplateOwnedR2Key[];
}

export interface HqTemplateAdapterContext {
  tenantId: string;
  targetAccountId: string;
  preflightId: string;
  idempotencyFingerprint: string;
  mode: HqTemplateDistributionMode;
  snapshotToken: HqTemplateSnapshotToken;
  resolutions: readonly HqTemplateResolution[];
  /** 店舗の実行権は内部で発行し、HTTP 本文の値は採用しない。 */
  executionAttempt?: number;
}

export interface HqTemplateAdapterInput {
  templateVersionId: string;
  definitionJson: string;
}

export interface HqTemplateUnsupportedResult {
  kind: 'UNSUPPORTED';
  templateType: HqTemplateType;
  operation: typeof HQ_TEMPLATE_COMMIT_PHASES[number];
}

export type HqTemplateAdapterResult<T> =
  | { kind: 'OK'; value: T }
  | HqTemplateUnsupportedResult;

export interface HqTemplateAdapter {
  readonly type: HqTemplateType;
  extractReferences(input: HqTemplateAdapterInput): Promise<HqTemplateAdapterResult<readonly HqTemplateReference[]>>;
  verifyReferences(
    context: HqTemplateAdapterContext,
    references: readonly HqTemplateReference[],
  ): Promise<HqTemplateAdapterResult<readonly HqTemplateMatchedReference[]>>;
  detectDuplicates(
    context: HqTemplateAdapterContext,
    references: readonly HqTemplateMatchedReference[],
  ): Promise<HqTemplateAdapterResult<readonly HqTemplateDuplicate[]>>;
  buildIdMap(
    context: HqTemplateAdapterContext,
    references: readonly HqTemplateMatchedReference[],
    duplicates: readonly HqTemplateDuplicate[],
  ): Promise<HqTemplateAdapterResult<HqTemplateIdMap>>;
  buildCommitPlan(
    context: HqTemplateAdapterContext,
    input: HqTemplateAdapterInput,
    idMap: HqTemplateIdMap,
  ): Promise<HqTemplateAdapterResult<HqTemplateStoreAtomicCommitPlan>>;
}

export function unsupportedHqTemplateAdapter(type: HqTemplateType): HqTemplateAdapter {
  const unsupported = <T>(operation: HqTemplateUnsupportedResult['operation']): Promise<HqTemplateAdapterResult<T>> =>
    Promise.resolve({ kind: 'UNSUPPORTED', templateType: type, operation });
  return {
    type,
    extractReferences: () => unsupported('extract_references'),
    verifyReferences: () => unsupported('verify_tenant_and_target_account'),
    detectDuplicates: () => unsupported('detect_duplicates'),
    buildIdMap: () => unsupported('build_id_map'),
    buildCommitPlan: () => unsupported('commit'),
  };
}

export type HqInitialResourceCommit = (account:string,resolutions:readonly HqTemplateResolution[])=>Promise<HqTemplateStatement[]>;
