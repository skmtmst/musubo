import type {MessageTemplateSourceMediaBinding} from './message-media-binding.js';
export type {MessageTemplateSourceMediaBinding} from './message-media-binding.js';
import type { MessageTemplateTargetSnapshot } from './message-target-snapshot.js';
export type { MessageTemplateTargetSnapshot } from './message-target-snapshot.js';
import { parseBroadcastMessageParts } from '../../features/broadcasts/broadcast-message-set/index.js';
import { parseHqMessageCard, composeHqMessageCard, validateImagemapMessage, type HqMessageCard, isLiffActionKind, collectLiffActionLocators, replaceLiffActionLocators } from '@line-crm/shared';
import { type MessageTemplateDefinition, type MessageTemplateMediaDefinition, validateAssetPayload, validateTapExtrasTree, tapExtrasError, isBroadcastAssetKind, convertBroadcastAsset, templateKind } from '@line-crm/shared';

import { HQ_MEDIA_MAX_BYTES, type HqMediaStreamSource } from '../hq-media-stream.js';
import type { HqTemplateBinding, HqTemplateStatement } from '@line-crm/db';
import {
  VERSION_CONFLICT_MESSAGE,
  unsupportedHqTemplateAdapter,
  type HqTemplateAdapter,
  type HqTemplateAdapterContext,
  type HqTemplateMatchedReference,
  type HqTemplateReference,
  type HqTemplateResolution,
  type HqTemplateSnapshotToken,
  type HqTemplateStoreAtomicCommitPlan,
} from './contract.js';

// 複製バイトを確定までメモリに持つため、Worker 本体・ハッシュ・制限付き読込の余裕を残す。
export const MESSAGE_TEMPLATE_MEDIA_MAX_BYTES = 8 * 1024 * 1024;
export const MESSAGE_TEMPLATE_TOTAL_MEDIA_MAX_BYTES = 16 * 1024 * 1024;

export class TemplateHqTemplateError extends Error {
  constructor(public readonly code: string, public readonly status: 400 | 409 | 422 | 500 = 400) {
    super(code);
  }
}

export type { MessageTemplateDefinition, MessageTemplateMediaDefinition } from '@line-crm/shared';


import { parseQuestion } from '../../features/scenarios/scenario-question/index.js';

/** route は認証済み統括と元アカウントから権限を導き、入力を渡す前に生成元へ固定する。 */
export type MessageTemplateSourceAuthority = Readonly<{
  tenantId: string;
  sourceAccountId: string;
}>;

/** 不変のテンプレート版 ID を、統括内の DB で解決した結果。 */
export type MessageTemplateSourceVersion = Readonly<{
  tenantId: string;
  templateVersionId: string;
  sourceAccountId: string;
  definitionJson: string;
  media: readonly MessageTemplateSourceMediaBinding[];
}>;

export type AuthorizedMessageTemplateSource = Readonly<{
  authority: MessageTemplateSourceAuthority;
  version: MessageTemplateSourceVersion;
  definition: MessageTemplateDefinition;
  media: ReadonlyMap<string, MessageTemplateSourceMediaBinding>;
}>;

export type MessageTemplatePreflightItem = Readonly<{
  sourceId: string;
  itemKind: 'template' | 'media';
  name: string;
  targetId: string | null;
  expectedRevision: string | null;
  duplicate: boolean;
  allowedModes: readonly ('create' | 'overwrite' | 'alias')[];
}>;

export interface MessageTemplateAdapterDependencies {
  /** 初期投入は、実体の保存と同じトランザクションで未公開にする。 */
  initialDraft?: boolean;
  stageSourceObject?: (media: MessageTemplateMediaDefinition, binding: MessageTemplateSourceMediaBinding) => Promise<HqMediaStreamSource>;
  /** 実行時のカード参照は、事前確認のスナップショットと照合する。 */
  cardTargets?: Readonly<Record<string, string>>;
  liffTargets?: Readonly<Record<string, string>>;
  referenceTargets?: Readonly<Record<string,string>>;
  /** 統括・元アカウント・不変の版 ID を1回の正規 DB 照会で解決する。 */
  resolveSourceVersion(input: Readonly<{
    authority: MessageTemplateSourceAuthority;
    templateVersionId: string;
  }>): Promise<MessageTemplateSourceVersion | null>;
  /** 名前一覧はページや絞込で欠けさせず、統括を検査した全件を使う。確認票はコンテキストの値を写さず、現在の正本から再計算する。 */
  loadTargetSnapshot(context: HqTemplateAdapterContext): Promise<MessageTemplateTargetSnapshot>;
  /** ETag があれば R2 の条件付き読込を必須とし、版と一致しなければ null を返す。報告サイズと実際の読込上限を守り、無制限の arrayBuffer を先に呼ばない。 */
  readSourceObjectIfUnchanged(input: Readonly<{
    authority: MessageTemplateSourceAuthority;
    templateVersionId: string;
    media: MessageTemplateMediaDefinition;
    binding: MessageTemplateSourceMediaBinding;
    maxBytes: number;
  }>): Promise<Readonly<{ bytes: Uint8Array; etag: string | null }> | null>;
  createId(
    kind: 'template' | 'media' | 'media_version',
    sourceId: string,
    context: HqTemplateAdapterContext,
  ): string;
  createTargetR2Key(
    media: MessageTemplateMediaDefinition,
    targetMediaId: string,
    context: HqTemplateAdapterContext,
  ): string;
  createTargetPublicUrl(
    targetR2Key: string,
    media: MessageTemplateMediaDefinition,
    context: HqTemplateAdapterContext,
  ): string | null;
  createOwnerToken(targetR2Key: string, context: HqTemplateAdapterContext): string;
  now(): string;
}

type VerifiedReference = HqTemplateMatchedReference & Readonly<{
  duplicate: boolean;
  expectedRevision: string | null;
}>;

type MessageTemplateReferenceMetadata = HqTemplateReference & Readonly<{
  source: AuthorizedMessageTemplateSource;
}>;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TemplateHqTemplateError('INVALID_DEFINITION', 422);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new TemplateHqTemplateError('INVALID_DEFINITION', 422);
  }
  return value.trim();
}

function optionalText(value: unknown, max: number): string | null {
  if (value == null || value === '') return null;
  return requiredText(value, max);
}

function nullableInteger(value: unknown): number | null {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TemplateHqTemplateError('INVALID_DEFINITION', 422);
  }
  return Number(value);
}

function jsonText(value: unknown, max: number): string | null {
  const text = optionalText(value, max);
  if (text !== null) {
    try {
      JSON.parse(text);
    } catch {
      throw new TemplateHqTemplateError('INVALID_DEFINITION', 422);
    }
  }
  return text;
}

function assertMediaBudget(media: readonly { sizeBytes: number; kind: string; mimeType: string }[]): void {
  let total = 0, bufferedTotal = 0;
  if (media.length > 50) throw new TemplateHqTemplateError('MEDIA_SIZE_LIMIT', 422);
  for (const item of media) {
    if (!Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0
      || item.sizeBytes > (item.kind === 'video' || item.kind === 'audio' ? HQ_MEDIA_MAX_BYTES : MESSAGE_TEMPLATE_MEDIA_MAX_BYTES)) {
      throw new TemplateHqTemplateError('MEDIA_SIZE_LIMIT', 422);
    }
    total += item.sizeBytes;
    if (!['video','audio'].includes(item.kind)) bufferedTotal += item.sizeBytes;
    if (bufferedTotal > MESSAGE_TEMPLATE_TOTAL_MEDIA_MAX_BYTES) throw new TemplateHqTemplateError('MEDIA_SIZE_LIMIT', 422);
    if ((item.kind === 'video' && item.mimeType !== 'video/mp4') || (item.kind === 'audio' && item.mimeType !== 'audio/mp4')) throw new TemplateHqTemplateError('INVALID_DEFINITION', 422);
    if (total > HQ_MEDIA_MAX_BYTES + MESSAGE_TEMPLATE_TOTAL_MEDIA_MAX_BYTES) {
      throw new TemplateHqTemplateError('MEDIA_SIZE_LIMIT', 422);
    }
  }
}

/** 実際の上限超過で中断する、R2 本文の制限付き読込。 */
export async function readMessageTemplateSourceBytes(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MESSAGE_TEMPLATE_MEDIA_MAX_BYTES)
    throw new TemplateHqTemplateError('MEDIA_SIZE_LIMIT', 422);
  const reader = body.getReader();
  const bytes = new Uint8Array(maxBytes);
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength > maxBytes - total)
        throw new TemplateHqTemplateError('MEDIA_SIZE_LIMIT', 422);
      bytes.set(value, total);
      total += value.byteLength;
    }
    return total === maxBytes ? bytes : bytes.slice(0, total);
  } catch (error) {
    try { await reader.cancel(); } catch { /* Retain the original read/limit failure. */ }
    throw error;
  } finally { reader.releaseLock(); }
}

/** hq_template_versions.definition_json に保存する版の内容。 */
export function parseMessageTemplateDefinition(value: unknown): MessageTemplateDefinition {
  const root = object(value);
  const template = { ...object(root.template) };
  if (root.schemaVersion !== 1 || !Array.isArray(root.media) || root.media.length > 50) {
    throw new TemplateHqTemplateError('INVALID_DEFINITION', 422);
  }
  let messageType = template.messageType;
  if (!['text', 'image', 'flex', 'carousel', 'imagemap'].includes(String(messageType))) {
    throw new TemplateHqTemplateError('INVALID_DEFINITION', 422);
  }
  const tapLimitMode = template.carouselTapLimitMode ?? 'none';
  if (tapLimitMode !== 'none' && tapLimitMode !== 'once') {
    throw new TemplateHqTemplateError('INVALID_DEFINITION', 422);
  }
  const questionStatus = template.questionStatus ?? 'published';
  if (questionStatus !== 'draft' && questionStatus !== 'published') {
    throw new TemplateHqTemplateError('INVALID_DEFINITION', 422);
  }
  const media = root.media.map((entry) => {
    const item = object(entry);
    const kind = item.kind;
    if (!['image', 'video', 'audio', 'file'].includes(String(kind))) {
      throw new TemplateHqTemplateError('INVALID_DEFINITION', 422);
    }
    const sizeBytes = nullableInteger(item.sizeBytes);
    const versionNo = nullableInteger(item.versionNo);
    if (sizeBytes === null || versionNo === null || versionNo < 1) {
      throw new TemplateHqTemplateError('INVALID_DEFINITION', 422);
    }
    return {
      id: requiredText(item.id, 100),
      kind: kind as MessageTemplateMediaDefinition['kind'],
      filename: requiredText(item.filename, 255),
      mimeType: requiredText(item.mimeType, 255),
      sizeBytes,
      width: nullableInteger(item.width),
      height: nullableInteger(item.height),
      durationMs: nullableInteger(item.durationMs),
      r2Key: requiredText(item.r2Key, 1_024),
      publicUrl: optionalText(item.publicUrl, 2_048),
      versionId: requiredText(item.versionId, 100),
      versionNo,
      contentHash: requiredText(item.contentHash, 255),
    };
  });
  assertMediaBudget(media);
  if (new Set(media.map((item) => item.id)).size !== media.length
    || new Set(media.map((item) => item.r2Key)).size !== media.length) {
    throw new TemplateHqTemplateError('INVALID_DEFINITION', 422);
  }
  let messageBubbles: MessageTemplateDefinition['messageBubbles'];
  if(root.messageBubbles !== undefined) {
    if(!Array.isArray(root.messageBubbles)||root.messageBubbles.length<1||root.messageBubbles.length>5||root.card||root.asset||template.questionJson) throw new TemplateHqTemplateError('INVALID_DEFINITION',422);
    try {
      const parts=parseBroadcastMessageParts({messageType:'text',messageContent:'',messageBubbles:root.messageBubbles});
      messageType=parts[0].messageType; template.messageType=messageType; template.messageContent=parts[0].messageContent;
    } catch { throw new TemplateHqTemplateError('INVALID_DEFINITION',422); }
    messageBubbles=root.messageBubbles as NonNullable<MessageTemplateDefinition['messageBubbles']>;
    if(messageBubbles.some(b=>!['text','image','flex','carousel','imagemap'].includes(b.type)||b.content.templateId||b.content.hqTemplateId||b.content.assetId)) throw new TemplateHqTemplateError('INVALID_DEFINITION',422);
    if(validateTapExtrasTree(messageBubbles)) throw new TemplateHqTemplateError('INVALID_DEFINITION',422);
  }
  let card: HqMessageCard | undefined;
  if (root.card !== undefined) {
    try { card = parseHqMessageCard(root.card); }
    catch { throw new TemplateHqTemplateError('INVALID_DEFINITION', 422); }
    const image = card.imageMediaId ? media.find(item => item.id === card!.imageMediaId) : undefined;
    if (card.imageMediaId && (!image || image.kind !== 'image' || !image.publicUrl)) throw new TemplateHqTemplateError('INVALID_DEFINITION', 422);
    Object.assign(template, composeHqMessageCard(card, requiredText(template.id, 100), image?.publicUrl ?? undefined));
  }
  let asset: MessageTemplateDefinition['asset'];
  if (root.asset !== undefined) {
    const value=object(root.asset),payload=object(value.payload);
    if (!isBroadcastAssetKind(value.kind) || validateAssetPayload(value.kind,payload)) throw new TemplateHqTemplateError('INVALID_DEFINITION',422);
    if (card) throw new TemplateHqTemplateError('INVALID_DEFINITION',422);
    // 店の保存と同じ共有型・検査を使い、配布先でIDを取り直す。
    if(value.kind==='research' && payload.questions===undefined) throw new TemplateHqTemplateError('INVALID_DEFINITION',422);
    asset={kind:value.kind,payload};
    if (value.kind==='rich_message') {
      const base=String(payload.baseUrl ?? '');
      if (![240,300,460,700,1040].every(width => media.some(m=>m.kind==='image' && m.publicUrl===`${base}/${width}`))) throw new TemplateHqTemplateError('INVALID_DEFINITION',422);
      const converted=convertBroadcastAsset(value.kind,String(template.name),payload);
      if(!converted.ok) throw new TemplateHqTemplateError('INVALID_DEFINITION',422);
    }
  }
  const questionJson=jsonText(template.questionJson,1_000_000);
  if (messageType === 'imagemap') {
    if (asset || card || questionJson) throw new TemplateHqTemplateError('INVALID_DEFINITION', 422);
    let payload: import('@line-crm/shared').HqRichVideoPayload;
    try { payload = JSON.parse(requiredText(template.messageContent, 1_000_000)); }
    catch { throw new TemplateHqTemplateError('INVALID_DEFINITION', 422); }
    if (!payload!.video || validateImagemapMessage(payload!)) throw new TemplateHqTemplateError('INVALID_DEFINITION', 422);
    const video = media.find(m => m.publicUrl === payload!.video.originalContentUrl && m.kind === 'video');
    const preview = media.find(m => m.publicUrl === payload!.video.previewImageUrl && m.kind === 'image' && ['image/png','image/jpeg'].includes(m.mimeType));
    if (!video || !preview || preview.sizeBytes > 1024 * 1024 || !preview.width || !preview.height
      || payload!.baseSize.height !== Math.round(preview.height / preview.width * 1040)
      || ![240,300,460,700,1040].every(width => media.some(m => m.kind === 'image' && m.publicUrl === `${payload!.baseUrl}/${width}` && m.width === width && m.height === Math.max(1,Math.round(payload!.baseSize.height * width/1040))))) throw new TemplateHqTemplateError('INVALID_DEFINITION', 422);
  }
  if(questionJson) {
    const q=parseQuestion(questionJson);
    if(!q || q.text.length>160 || q.choices.length>13 || q.choices.some(c=>!c || typeof c.label!=='string' || !c.label.trim() || c.label.length>20 || !['none','url','tel','add_friend','mail','form','scenario'].includes(c.behavior))) throw new TemplateHqTemplateError('INVALID_DEFINITION',422);
    if(asset || card) throw new TemplateHqTemplateError('INVALID_DEFINITION',422);
  }
  const parsed: MessageTemplateDefinition = {
    ...(messageBubbles?{messageBubbles}:{}),
    ...(asset?{asset}:{}),
    ...(card?{card}:{}),
    schemaVersion: 1,
    template: {
      id: requiredText(template.id, 100),
      name: requiredText(template.name, 255),
      category: requiredText(template.category ?? 'general', 100),
      messageType: messageType as MessageTemplateDefinition['template']['messageType'],
      messageContent: asset || questionJson
        ? optionalText(template.messageContent, 1_000_000) ?? ''
        : requiredText(template.messageContent, 1_000_000),
      carouselActionsJson: jsonText(template.carouselActionsJson, 1_000_000),
      carouselTapLimitMode: tapLimitMode,
      carouselTapLimitText: optionalText(template.carouselTapLimitText, 10_000),
      questionJson,
      questionStatus,
    },
    media,
  };
  try {
    collectLiffActionLocators(parsed);
    for (const button of parsed.card?.buttons ?? []) if (button.action === 'url') collectLiffActionLocators({ uri: button.value });
  } catch { throw new TemplateHqTemplateError('INVALID_DEFINITION', 422); }
  const extrasError = validateTapExtrasTree(parsed.asset?.payload ?? parsed.card ?? {});
  let contentExtras: string | null = null;
  try { contentExtras = validateTapExtrasTree(JSON.parse(parsed.template.messageContent)); } catch { /* text */ }
  if (extrasError || contentExtras) throw new TemplateHqTemplateError('INVALID_DEFINITION', 422);
  if (parsed.template.questionJson) {
    const q = parseQuestion(parsed.template.questionJson);
    if (q?.choices.some(choice => tapExtrasError({ tagIds: choice.addTagIds, scoreChange: choice.scoreChange }))) throw new TemplateHqTemplateError('INVALID_DEFINITION', 422);
  }
  referencedMedia(parsed);
  return parsed;
}

function normalizeSha256(value: string): string | null {
  const match = /^(?:sha256[:=])?([a-f0-9]{64})$/i.exec(value.trim());
  return match?.[1]?.toLowerCase() ?? null;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const source = new Uint8Array(bytes.byteLength);
  source.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', source);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function belongsToR2Prefix(key: string, prefix: string): boolean {
  const normalized = prefix.replace(/\/+$/, '');
  return normalized !== '' && key.startsWith(`${normalized}/`);
}

function sourceR2Prefix(tenantId: string): string {
  return `hq-templates/${tenantId}`;
}

function targetR2Prefix(accountId: string): string {
  return `media/${accountId}`;
}

function parseSourceDefinition(source: MessageTemplateSourceVersion): MessageTemplateDefinition {
  try {
    return parseMessageTemplateDefinition(JSON.parse(source.definitionJson));
  } catch (error) {
    if (error instanceof TemplateHqTemplateError) throw error;
    throw new TemplateHqTemplateError('SOURCE_VERSION_INVALID', 422);
  }
}

function assertAuthorizedSource(
  source: AuthorizedMessageTemplateSource,
  expectedTenantId: string,
  expectedTemplateVersionId: string,
): void {
  const { authority, version, definition, media: bindings } = source;
  const expectedSourcePrefix = sourceR2Prefix(authority.tenantId);
  assertMediaBudget(definition.media);
  assertMediaBudget([...bindings.values()].map(binding => ({...binding,kind:definition.media.find(m=>m.id===binding.mediaId)?.kind ?? 'file',mimeType:definition.media.find(m=>m.id===binding.mediaId)?.mimeType ?? ''})));
  if (authority.tenantId !== expectedTenantId
    || version.tenantId !== authority.tenantId
    || version.sourceAccountId !== authority.sourceAccountId
    || version.templateVersionId !== expectedTemplateVersionId
    || bindings.size !== definition.media.length) {
    throw new TemplateHqTemplateError('SOURCE_AUTHORITY_MISMATCH', 422);
  }
  for (const media of definition.media) {
    const binding = bindings.get(media.id);
    if (!binding
      || binding.tenantId !== authority.tenantId
      || binding.sourceAccountId !== authority.sourceAccountId
      || binding.templateVersionId !== expectedTemplateVersionId
      || binding.mediaVersionId !== media.versionId
      || binding.versionNo !== media.versionNo
      || binding.r2Key !== media.r2Key
      || binding.r2KeyPrefix.replace(/\/+$/, '') !== expectedSourcePrefix
      || !belongsToR2Prefix(binding.r2Key, expectedSourcePrefix)
      || binding.sizeBytes !== media.sizeBytes
      || normalizeSha256(binding.contentHash) === null
      || normalizeSha256(binding.contentHash) !== normalizeSha256(media.contentHash)) {
      throw new TemplateHqTemplateError('SOURCE_MEDIA_AUTHORITY_MISMATCH', 422);
    }
  }
}

async function loadAuthorizedSource(
  authority: MessageTemplateSourceAuthority,
  templateVersionId: string,
  dependencies: MessageTemplateAdapterDependencies,
): Promise<AuthorizedMessageTemplateSource> {
  if (!authority.tenantId || !authority.sourceAccountId || !templateVersionId || /\s/.test(templateVersionId)) {
    throw new TemplateHqTemplateError('SOURCE_AUTHORITY_INVALID', 422);
  }
  const version = await dependencies.resolveSourceVersion({ authority, templateVersionId });
  if (!version
    || version.tenantId !== authority.tenantId
    || version.sourceAccountId !== authority.sourceAccountId
    || version.templateVersionId !== templateVersionId) {
    throw new TemplateHqTemplateError('SOURCE_AUTHORITY_MISMATCH', 422);
  }
  const definition = parseSourceDefinition(version);
  const bindings = new Map<string, MessageTemplateSourceMediaBinding>();
  for (const binding of version.media) {
    if (bindings.has(binding.mediaId)) {
      throw new TemplateHqTemplateError('SOURCE_MEDIA_AUTHORITY_MISMATCH', 422);
    }
    bindings.set(binding.mediaId, binding);
  }
  const source = { authority, version, definition, media: bindings };
  assertAuthorizedSource(source, authority.tenantId, templateVersionId);
  return source;
}

function normalizeName(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('ja-JP');
}

function templateTextFields(definition: MessageTemplateDefinition): readonly string[] {
  const template = definition.template;
  return [
    template.messageContent,
    template.carouselActionsJson,
    template.carouselTapLimitText,
    template.questionJson,
    definition.asset ? JSON.stringify(definition.asset.payload) : null,
    definition.messageBubbles ? JSON.stringify(definition.messageBubbles) : null,
  ].filter((value): value is string => value !== null);
}

function exactStringValues(value: string): readonly string[] {
  try {
    const root: unknown = JSON.parse(value);
    const result: string[] = [];
    const visit = (entry: unknown): void => {
      if (typeof entry === 'string') result.push(entry);
      else if (Array.isArray(entry)) entry.forEach(visit);
      else if (entry && typeof entry === 'object') Object.values(entry).forEach(visit);
    };
    visit(root);
    return result;
  } catch {
    return [value];
  }
}

/** テンプレート本文が実際に参照するメディアだけを配布する。 */
export function referencedMedia(definition: MessageTemplateDefinition): readonly MessageTemplateMediaDefinition[] {
  const exactValues = new Set(templateTextFields(definition).flatMap(exactStringValues));
  if(definition.asset?.kind==='rich_message') for(const width of [240,300,460,700,1040]) exactValues.add(`${definition.asset.payload.baseUrl}/${width}`);
  if (definition.template.messageType === 'imagemap') {
    const payload = JSON.parse(definition.template.messageContent);
    for (const width of [240,300,460,700,1040]) exactValues.add(`${payload.baseUrl}/${width}`);
  }
  const references = definition.media.filter((media) =>
    [media.id, media.r2Key, media.publicUrl].some((locator) => locator !== null && exactValues.has(locator)),
  );
  const declaredLocators = new Map<string, string>();
  for (const media of references) {
    for (const locator of [media.id, media.r2Key, media.publicUrl]) {
      if (!locator) continue;
      const previous = declaredLocators.get(locator);
      if (previous && previous !== media.id) {
        throw new TemplateHqTemplateError('AMBIGUOUS_MEDIA_REFERENCE', 409);
      }
      declaredLocators.set(locator, media.id);
    }
  }
  return references;
}

function uniqueMatch<T>(items: readonly T[], errorCode: string): T | null {
  if (items.length > 1) throw new TemplateHqTemplateError(errorCode, 409);
  return items[0] ?? null;
}

/** 事前確認では、テンプレートと参照メディアの全選択を提示する。 */
export function inspectMessageTemplateDefinition(
  definition: MessageTemplateDefinition,
  snapshot: MessageTemplateTargetSnapshot,
): readonly MessageTemplatePreflightItem[] {
  const targetTemplate = uniqueMatch(
    snapshot.templates.filter((item) => normalizeName(item.name) === normalizeName(definition.template.name)),
    'AMBIGUOUS_TEMPLATE',
  );
  const result: MessageTemplatePreflightItem[] = [{
    sourceId: `template:${definition.template.id}`,
    itemKind: 'template',
    name: definition.template.name,
    targetId: targetTemplate?.id ?? null,
    expectedRevision: targetTemplate?.updatedAt ?? null,
    duplicate: targetTemplate !== null,
    allowedModes: targetTemplate ? ['overwrite', 'alias'] : ['create'],
  }];
  for (const media of referencedMedia(definition)) {
    const contentMatch = uniqueMatch(
      snapshot.media.filter((item) => normalizeSha256(media.contentHash) !== null
        && normalizeSha256(item.contentHash) === normalizeSha256(media.contentHash)),
      'AMBIGUOUS_MEDIA',
    );
    const nameMatch = uniqueMatch(
      snapshot.media.filter((item) => normalizeName(item.filename) === normalizeName(media.filename)),
      'AMBIGUOUS_MEDIA_NAME',
    );
    if (contentMatch && nameMatch && contentMatch.id !== nameMatch.id) {
      throw new TemplateHqTemplateError('AMBIGUOUS_MEDIA', 409);
    }
    const targetMedia = contentMatch ?? nameMatch;
    result.push({
      sourceId: `media:${media.id}`,
      itemKind: 'media',
      name: media.filename,
      targetId: targetMedia?.id ?? null,
      expectedRevision: targetMedia?.revision ?? null,
      duplicate: targetMedia !== null,
      allowedModes: targetMedia ? ['overwrite', 'alias'] : ['create'],
    });
  }
  return result;
}

export function nextMessageTemplateAlias(name: string, occupiedNames: readonly string[]): string {
  const occupied = new Set(occupiedNames.map(normalizeName));
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${name} (${suffix})`;
    if (!occupied.has(normalizeName(candidate))) return candidate;
  }
  throw new TemplateHqTemplateError('ALIAS_EXHAUSTED', 409);
}

function replaceExactLocators(value: string | null, replacements: ReadonlyMap<string, string>): string | null {
  if (value === null) return null;
  let changed = false;
  const replace = (entry: unknown): unknown => {
    if (typeof entry === 'string') {
      const replacement = replacements.get(entry);
      if (replacement !== undefined) changed = true;
      return replacement ?? entry;
    }
    if (Array.isArray(entry)) return entry.map(replace);
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, replace(child)]));
    }
    return entry;
  };
  try {
    const rewritten = replace(JSON.parse(value));
    return changed ? JSON.stringify(rewritten) : value;
  } catch {
    return replacements.get(value) ?? value;
  }
}

function requireResolution(
  item: MessageTemplatePreflightItem,
  resolutions: readonly HqTemplateResolution[],
): HqTemplateResolution {
  const resolution = resolutions.find((entry) => entry.sourceId === item.sourceId);
  if (!resolution || resolution.itemKind !== item.itemKind || !item.allowedModes.includes(resolution.mode)) {
    throw new TemplateHqTemplateError('SELECTION_REQUIRED', 409);
  }
  if (item.duplicate && resolution.mode === 'overwrite') {
    if (resolution.targetId !== item.targetId || resolution.expectedRevision !== item.expectedRevision) {
      throw new TemplateHqTemplateError(VERSION_CONFLICT_MESSAGE, 409);
    }
  }
  return resolution;
}

function conflictGuard(sql: string, bindings: readonly HqTemplateBinding[]): HqTemplateStatement {
  // 不一致時にだけ不正 JSON を評価し、周囲の D1 batch 全体を中断する。
  return {
    sql: `SELECT CASE WHEN EXISTS(${sql}) THEN 1 ELSE json_extract('VERSION_CONFLICT', '$') END`,
    bindings,
  };
}

function nameInventoryGuard(kind: 'template' | 'media', accountId: string, names: readonly (readonly [string, string])[], asset = false): HqTemplateStatement {
  const table = kind === 'template' ? (asset ? 'broadcast_message_assets' : 'templates') : 'media';
  const column = kind === 'template' ? 'name' : 'filename';
  const expected = JSON.stringify(names);
  // SQLite の lower は JS の NFKC/大小変換を再現できないため、名前の全件集合が不変か照合して JS の判断を使う。JSON の行順には依存しない。
  return conflictGuard(`SELECT 1 WHERE
    (SELECT COUNT(*) FROM ${table} WHERE line_account_id=?) = json_array_length(?)
    AND NOT EXISTS(SELECT 1 FROM ${table} t WHERE t.line_account_id=? AND NOT EXISTS(
      SELECT 1 FROM json_each(?) expected
      WHERE json_extract(expected.value,'$[0]') IS t.id
        AND json_extract(expected.value,'$[1]') IS t.${column}))`,
  [accountId, expected, accountId, expected]);
}

export async function planMessageTemplateDistribution(input: {
  context: HqTemplateAdapterContext;
  source: AuthorizedMessageTemplateSource;
  snapshot: MessageTemplateTargetSnapshot;
  idMap: Readonly<Record<string, string>>;
  dependencies: MessageTemplateAdapterDependencies;
}): Promise<HqTemplateStoreAtomicCommitPlan> {
  const { context, source, snapshot, idMap, dependencies } = input;
  const { definition } = source;
  assertAuthorizedSource(source, context.tenantId, source.version.templateVersionId);
  if (snapshot.tenantId !== context.tenantId
    || snapshot.targetAccountId !== context.targetAccountId
    || snapshot.snapshotToken !== context.snapshotToken) {
    throw new TemplateHqTemplateError(VERSION_CONFLICT_MESSAGE, 409);
  }
  const items = inspectMessageTemplateDefinition(definition, snapshot);
  if (context.resolutions.length !== items.length
    || new Set(context.resolutions.map((entry) => entry.sourceId)).size !== items.length) {
    throw new TemplateHqTemplateError('SELECTION_REQUIRED', 409);
  }
  const now = dependencies.now();
  const dbCommit: HqTemplateStatement[] = [];
  const stage: HqTemplateStoreAtomicCommitPlan['stage'][number][] = [];
  const compensateOnDbFailure: HqTemplateStoreAtomicCommitPlan['compensateOnDbFailure'][number][] = [];
  const reconcile: HqTemplateStoreAtomicCommitPlan['reconcile'][number][] = [];
  const replacements = new Map<string, string>(Object.entries(dependencies.referenceTargets ?? {}));
  const resolved: HqTemplateResolution[] = [];
  const occupiedTemplateNames = [...snapshot.templates.map((entry) => entry.name)];
  const occupiedMediaNames = [...snapshot.media.map((entry) => entry.filename)];
  const guardedInventories = new Set<'template' | 'media'>();
  const sourceR2Keys = new Set(definition.media.map((entry) => entry.r2Key));
  const existingTargetR2Keys = new Set(snapshot.media.map((entry) => entry.r2Key));
  const plannedTargetR2Keys = new Set<string>();

  for (const item of items) {
    const resolution = requireResolution(item, context.resolutions);
    const targetId = idMap[item.sourceId];
    if (!targetId || /\s/.test(targetId)) throw new TemplateHqTemplateError('INVALID_ID_MAP', 409);
    if (resolution.mode === 'overwrite' && (targetId !== item.targetId || targetId !== resolution.targetId)) {
      throw new TemplateHqTemplateError('INVALID_ID_MAP', 409);
    }
    let name = item.name;
    if (resolution.mode === 'alias') {
      const occupied = item.itemKind === 'template' ? occupiedTemplateNames : occupiedMediaNames;
      const generated = nextMessageTemplateAlias(item.name, occupied);
      if (resolution.aliasName && normalizeName(resolution.aliasName) !== normalizeName(generated)) {
        throw new TemplateHqTemplateError('ALIAS_SELECTION_CONFLICT', 409);
      }
      name = generated;
    }
    if (resolution.mode !== 'overwrite') {
      const occupied = item.itemKind === 'template' ? occupiedTemplateNames : occupiedMediaNames;
      if (occupied.some(existing => normalizeName(existing) === normalizeName(name))) {
        throw new TemplateHqTemplateError('DUPLICATE_NAME', 409);
      }
      occupied.push(name);
    }
    // メディア名の変更は版を作らないため、同時の名前変更を上書きで消さないよう別に照合する。
    if (!guardedInventories.has(item.itemKind)) {
      const names: [string, string][] = item.itemKind === 'template'
        ? snapshot.templates.map(row => [row.id, row.name])
        : snapshot.media.map(row => [row.id, row.filename]);
      dbCommit.push(nameInventoryGuard(item.itemKind, context.targetAccountId, names, Boolean(definition.asset)));
      guardedInventories.add(item.itemKind);
    }
    resolved.push({
      ...resolution,
      targetId,
      aliasName: resolution.mode === 'alias' ? name : undefined,
      expectedRevision: item.expectedRevision ?? undefined,
    });
  }

  let stagedBytes = 0;
  for (const media of referencedMedia(definition)) {
    const sourceId = `media:${media.id}`;
    const item = items.find((entry) => entry.sourceId === sourceId)!;
    const resolution = requireResolution(item, context.resolutions);
    const targetId = idMap[sourceId];
    const target = snapshot.media.find((entry) => entry.id === item.targetId);
    const plannedResolution = resolved.find((entry) => entry.sourceId === sourceId)!;
    const filename = plannedResolution.aliasName ?? media.filename;
    const targetR2Key = dependencies.createTargetR2Key(media, targetId, context);
    const targetPublicUrl = dependencies.createTargetPublicUrl(targetR2Key, media, context);
    const ownerToken = dependencies.createOwnerToken(targetR2Key, context);
    if (!targetR2Key
      || !belongsToR2Prefix(targetR2Key, targetR2Prefix(context.targetAccountId))
      || sourceR2Keys.has(targetR2Key)
      || existingTargetR2Keys.has(targetR2Key)
      || plannedTargetR2Keys.has(targetR2Key)
      || !ownerToken
      || /\s/.test(ownerToken)) {
      throw new TemplateHqTemplateError('MEDIA_COPY_INVALID', 422);
    }
    plannedTargetR2Keys.add(targetR2Key);
    const binding = source.media.get(media.id);
    if (!binding) throw new TemplateHqTemplateError('SOURCE_MEDIA_AUTHORITY_MISMATCH', 422);
    if (['video', 'audio'].includes(media.kind) && dependencies.stageSourceObject) {
      const streamSource = await dependencies.stageSourceObject(media, binding);
      if (streamSource.r2Key !== binding.r2Key || streamSource.etag !== binding.etag || streamSource.sizeBytes !== media.sizeBytes || streamSource.contentHash !== normalizeSha256(media.contentHash)) throw new TemplateHqTemplateError('MEDIA_COPY_INVALID', 422);
      stage.push({ key: targetR2Key, ownerToken, bytes: new Uint8Array(), streamSource, contentType: media.mimeType });
    } else {
      const maxBytes = Math.min(media.sizeBytes, MESSAGE_TEMPLATE_MEDIA_MAX_BYTES, MESSAGE_TEMPLATE_TOTAL_MEDIA_MAX_BYTES - stagedBytes);
      const sourceObject = await dependencies.readSourceObjectIfUnchanged({ authority: source.authority, templateVersionId: source.version.templateVersionId, media, binding, maxBytes });
      if (sourceObject && sourceObject.bytes.byteLength > maxBytes) throw new TemplateHqTemplateError('MEDIA_SIZE_LIMIT', 422);
      const declaredHash = normalizeSha256(media.contentHash);
      if (!sourceObject || (binding.etag !== null && sourceObject.etag !== binding.etag) || sourceObject.bytes.byteLength !== media.sizeBytes || declaredHash === null || await sha256Hex(sourceObject.bytes) !== declaredHash || (media.publicUrl !== null && targetPublicUrl === null)) throw new TemplateHqTemplateError('MEDIA_COPY_INVALID', 422);
      stagedBytes += sourceObject.bytes.byteLength;
      stage.push({ key: targetR2Key, ownerToken, bytes: sourceObject.bytes, contentType: media.mimeType });
    }
    if (media.publicUrl !== null && targetPublicUrl === null) throw new TemplateHqTemplateError('MEDIA_COPY_INVALID', 422);
    compensateOnDbFailure.push({ key: targetR2Key, ownerToken });
    reconcile.push({ key: targetR2Key, ownerToken });
    replacements.set(media.id, targetId);
    replacements.set(media.r2Key, targetR2Key);
    if (media.publicUrl && targetPublicUrl) {
      replacements.set(media.publicUrl, targetPublicUrl);
      if (definition.template.messageType === 'imagemap' && media.publicUrl === `${JSON.parse(definition.template.messageContent).baseUrl}/1040`) replacements.set(media.publicUrl.slice(0, -5), targetPublicUrl.slice(0, -5));
    }

    if (resolution.mode === 'overwrite') {
      if (!target) throw new TemplateHqTemplateError(VERSION_CONFLICT_MESSAGE, 409);
      dbCommit.push(conflictGuard(
        `SELECT 1 FROM media m JOIN media_versions v ON v.media_id = m.id
          WHERE m.id = ? AND m.line_account_id = ? AND m.r2_key = ?
            AND NOT EXISTS (SELECT 1 FROM operation_audit l WHERE l.id='file-scan-delete:media:' || m.id AND l.action='deleting')
            AND v.version_no = (SELECT MAX(v2.version_no) FROM media_versions v2 WHERE v2.media_id = m.id)
            AND (v.created_at || ':' || COALESCE(v.content_hash, '') || ':' || v.r2_key) = ?`,
        [targetId, context.targetAccountId, target.r2Key, item.expectedRevision],
      ));
      dbCommit.push({
        sql: `UPDATE media SET filename=?,kind=?,mime_type=?,size_bytes=?,width=?,height=?,duration_ms=?,r2_key=?,public_url=?
              WHERE id=? AND line_account_id=? AND r2_key=?`,
        bindings: [filename, media.kind, media.mimeType, media.sizeBytes, media.width, media.height,
          media.durationMs, targetR2Key, targetPublicUrl, targetId, context.targetAccountId, target.r2Key],
      });
      dbCommit.push({ sql: "UPDATE media_file_scans SET confirmation_revision=confirmation_revision+1 WHERE line_account_id=? AND (media_id=? OR (subject_kind='media' AND subject_id=?))", bindings: [context.targetAccountId, targetId, targetId] });
    } else {
      dbCommit.push({
        sql: `INSERT INTO media
              (id,line_account_id,folder_id,kind,filename,mime_type,size_bytes,width,height,duration_ms,r2_key,public_url,uploaded_by,created_at)
              VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?,NULL,?)`,
        bindings: [targetId, context.targetAccountId, media.kind, filename, media.mimeType, media.sizeBytes,
          media.width, media.height, media.durationMs, targetR2Key, targetPublicUrl, now],
      });
    }
    dbCommit.push({
      sql: `INSERT INTO media_versions
            (id,media_id,version_no,r2_key,mime_type,size_bytes,width,height,duration_ms,content_hash,scan_status,scanned_at,created_at,published_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,'verified',?,?,?)`,
      bindings: [dependencies.createId('media_version', media.versionId, context), targetId,
        resolution.mode === 'overwrite' ? target!.versionNo + 1 : 1, targetR2Key, media.mimeType,
        media.sizeBytes, media.width, media.height, media.durationMs, media.contentHash, now, now, now],
    });
  }

  const rootItem = items[0]!;
  const rootResolution = requireResolution(rootItem, context.resolutions);
  const targetTemplateId = idMap[rootItem.sourceId]!;
  const rootName = resolved[0]?.aliasName ?? definition.template.name;
  let template = definition.template;
  if (definition.card) {
    for (const button of definition.card.buttons) if ((isLiffActionKind(button.action) || button.action === 'scenario') && !dependencies.cardTargets?.[`${button.action}:${button.value}`]) throw new TemplateHqTemplateError('REFERENCE_UNAVAILABLE', 422);
    const image = definition.media.find(item => item.id === definition.card!.imageMediaId);
    template = { ...template, ...composeHqMessageCard(definition.card, targetTemplateId, image?.publicUrl ?? undefined, dependencies.cardTargets) };
  }
  const liffLocators = definition.card
    ? collectLiffActionLocators(definition.card.buttons.filter(button => button.action === 'url').map(button => ({ uri: button.value })))
    : collectLiffActionLocators(definition);
  for (const locator of liffLocators.keys()) {
    if (!dependencies.liffTargets?.[locator]) throw new TemplateHqTemplateError('REFERENCE_UNAVAILABLE', 422);
  }
  const messageContent = replaceExactLocators(replaceLiffActionLocators(template, dependencies.liffTargets ?? {}).messageContent, replacements)!;
  const carouselActionsJson = replaceExactLocators(template.carouselActionsJson, replacements);
  const carouselTapLimitText = replaceExactLocators(template.carouselTapLimitText, replacements);
  const questionJson = replaceExactLocators(template.questionJson, replacements);
  if (!definition.asset) {
  if (rootResolution.mode === 'overwrite') {
    dbCommit.push(conflictGuard(
      'SELECT 1 FROM templates WHERE id = ? AND line_account_id = ? AND updated_at = ?',
      [targetTemplateId, context.targetAccountId, rootItem.expectedRevision],
    ));
    dbCommit.push({
      sql: `UPDATE templates SET confirmation_revision=confirmation_revision+1, name=?,category=?,message_type=?,message_content=?,carousel_actions_json=?,
            carousel_tap_limit_mode=?,carousel_tap_limit_text=?,question_json=?,question_status=?,
            published_version=published_version+1,published_at=?,draft_message_type=NULL,draft_message_content=NULL,
            draft_carousel_actions_json=NULL,draft_carousel_tap_limit_mode=NULL,draft_carousel_tap_limit_text=NULL,
            draft_question_json=NULL,draft_question_status=NULL,draft_revision=0,updated_at=?
            WHERE id=? AND line_account_id=? AND updated_at=?`,
      bindings: [rootName, template.category, template.messageType, messageContent, carouselActionsJson,
        template.carouselTapLimitMode, carouselTapLimitText, questionJson, template.questionStatus,
        now, now, targetTemplateId, context.targetAccountId, rootItem.expectedRevision],
    });
  } else {
    dbCommit.push({
      sql: `INSERT INTO templates
            (id,name,category,message_type,message_content,carousel_actions_json,carousel_tap_limit_mode,
             carousel_tap_limit_text,question_json,question_status,created_at,updated_at,line_account_id,
             published_version,published_at,draft_revision)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,0)`,
      bindings: [targetTemplateId, rootName, template.category, template.messageType, messageContent,
        carouselActionsJson, template.carouselTapLimitMode, carouselTapLimitText, questionJson,
        template.questionStatus, now, now, context.targetAccountId, now],
    });
  }
  } else {
    const asset=definition.asset;
    if(asset.kind==='rich_message') {
      const sourceBase=String(asset.payload.baseUrl);
      const target1040=replacements.get(`${sourceBase}/1040`);
      if(!target1040?.endsWith('/1040')) throw new TemplateHqTemplateError('MEDIA_COPY_INVALID',422);
      replacements.set(sourceBase,target1040.slice(0,-5));
    }
    const payload=JSON.parse(replaceExactLocators(JSON.stringify(replaceLiffActionLocators(asset.payload, dependencies.liffTargets ?? {})),replacements)!);
    // assetId と画像の旧所属を持ち越さない。
    payload.assetId=targetTemplateId;
    if(payload.imageMediaId) payload.imageMediaId=replacements.get(payload.imageMediaId) ?? null;
    // 各サイズも使用台帳の点検で見つかるよう、配布先URLを保存する。
    if (asset.kind === 'rich_message') {
      payload.imagemapImages = referencedMedia(definition).map(media => replacements.get(media.publicUrl!));
    }
    const json=JSON.stringify(payload);
    if(rootResolution.mode==='overwrite') {
      dbCommit.push(conflictGuard('SELECT 1 FROM broadcast_message_assets WHERE id=? AND line_account_id=? AND updated_at=?', [targetTemplateId,context.targetAccountId,rootItem.expectedRevision]));
      dbCommit.push({sql:`UPDATE broadcast_message_assets SET kind=?,name=?,payload_json=?,published_version=published_version+1,published_at=?,draft_payload_json=NULL,draft_revision=0,updated_at=? WHERE id=? AND line_account_id=? AND updated_at=?`,bindings:[asset.kind,rootName,json,now,now,targetTemplateId,context.targetAccountId,rootItem.expectedRevision]});
    } else dbCommit.push({sql:`INSERT INTO broadcast_message_assets(id,line_account_id,kind,name,payload_json,published_version,published_at,draft_revision,created_at,updated_at) VALUES (?,?,?,?,?,1,?,0,?,?)`,bindings:[targetTemplateId,context.targetAccountId,asset.kind,rootName,json,now,now,now]});
    if (!dependencies.initialDraft) dbCommit.push({sql:`INSERT INTO broadcast_asset_versions(id,asset_id,version_number,payload_json,created_at) SELECT ?,id,published_version,payload_json,? FROM broadcast_message_assets WHERE id=? AND line_account_id=?`,bindings:[crypto.randomUUID(),now,targetTemplateId,context.targetAccountId]});
    if(asset.kind==='rich_message') for(const m of referencedMedia(definition)) dbCommit.push({sql:'INSERT OR IGNORE INTO imagemap_images(id,line_account_id,r2_key,created_at) VALUES (?,?,?,?)',bindings:[crypto.randomUUID(),context.targetAccountId,replacements.get(m.r2Key)!,now]});
  }
  if(!definition.asset) {
    const bubbles=definition.messageBubbles ? replaceExactLocators(JSON.stringify(replaceLiffActionLocators(definition.messageBubbles,dependencies.liffTargets ?? {})),replacements) : null;
    dbCommit.push({sql:'UPDATE templates SET confirmation_revision=confirmation_revision+1, message_bubbles_json=?,draft_message_bubbles_json=NULL WHERE id=? AND line_account_id=?',bindings:[bubbles,targetTemplateId,context.targetAccountId]});
    if (!dependencies.initialDraft) dbCommit.push({sql:`INSERT INTO template_versions(id,template_id,version_number,message_type,message_content,carousel_actions_json,carousel_tap_limit_mode,carousel_tap_limit_text,question_json,question_status,message_bubbles_json,created_at,hq_template_version_id)
      SELECT ?,id,published_version,message_type,message_content,carousel_actions_json,carousel_tap_limit_mode,carousel_tap_limit_text,question_json,question_status,message_bubbles_json,?,? FROM templates WHERE id=? AND line_account_id=?`,bindings:[crypto.randomUUID(),now,source.version.templateVersionId,targetTemplateId,context.targetAccountId]});
  }
  if (dependencies.initialDraft) {
    if (rootResolution.mode === 'overwrite') throw new TemplateHqTemplateError('VERSION_CONFLICT', 409);
    dbCommit.push(definition.asset
      ? { sql: `UPDATE broadcast_message_assets SET draft_payload_json=payload_json,draft_revision=1,published_version=0,published_at=NULL WHERE id=? AND line_account_id=?`, bindings: [targetTemplateId, context.targetAccountId] }
      : { sql: `UPDATE templates SET confirmation_revision=confirmation_revision+1, draft_message_type=message_type,draft_message_content=message_content,
        draft_carousel_actions_json=carousel_actions_json,draft_carousel_tap_limit_mode=carousel_tap_limit_mode,draft_carousel_tap_limit_text=carousel_tap_limit_text,
        draft_question_json=question_json,draft_question_status=question_status,draft_message_bubbles_json=message_bubbles_json,
        draft_revision=1,published_version=0,published_at=NULL WHERE id=? AND line_account_id=?`, bindings: [targetTemplateId, context.targetAccountId] });
  }

  for (const media of referencedMedia(definition)) {
    dbCommit.push({
      sql: `INSERT INTO media_usages(media_id,ref_kind,ref_id,scanned_at) VALUES (?,'template',?,?)
            ON CONFLICT(media_id,ref_kind,ref_id) DO UPDATE SET scanned_at=excluded.scanned_at`,
      bindings: [idMap[`media:${media.id}`], targetTemplateId, now],
    });
  }

  return {
    tenantId: context.tenantId,
    targetAccountId: context.targetAccountId,
    preflightId: context.preflightId,
    idempotencyFingerprint: context.idempotencyFingerprint,
    snapshotToken: context.snapshotToken,
    mode: context.mode,
    resolutions: resolved,
    stage,
    dbCommit,
    compensateOnDbFailure,
    reconcile,
  };
}

function referenceSource(reference: HqTemplateReference): AuthorizedMessageTemplateSource {
  const metadata = reference as Partial<MessageTemplateReferenceMetadata>;
  if (!metadata.source) throw new TemplateHqTemplateError('INVALID_REFERENCE', 422);
  return metadata.source;
}

/** 認証済みの元権限と統括内 D1/R2 を実行時に接続する。input.definitionJson は信用せず、templateVersionId が選んだ不変版だけを正本とする。 */
export function createTemplateHqTemplateAdapter(
  authority: MessageTemplateSourceAuthority,
  dependencies: MessageTemplateAdapterDependencies,
): HqTemplateAdapter {
  return {
    type: 'template',
    async extractReferences(input) {
      const source = await loadAuthorizedSource(authority, input.templateVersionId, dependencies);
      const references: MessageTemplateReferenceMetadata[] = [{
        kind: 'template',
        sourceId: `template:${source.definition.template.id}`,
        source,
      }];
      for (const media of referencedMedia(source.definition)) {
        references.push({ kind: 'media', sourceId: `media:${media.id}`, source });
      }
      return { kind: 'OK', value: references };
    },
    async verifyReferences(context, references) {
      if (context.tenantId !== authority.tenantId) {
        throw new TemplateHqTemplateError('SOURCE_AUTHORITY_MISMATCH', 422);
      }
      const snapshot = await dependencies.loadTargetSnapshot(context);
      if (snapshot.tenantId !== context.tenantId
        || snapshot.targetAccountId !== context.targetAccountId
        || snapshot.snapshotToken !== context.snapshotToken) {
        throw new TemplateHqTemplateError(VERSION_CONFLICT_MESSAGE, 409);
      }
      const source = referenceSource(references[0]!);
      if (source.authority.tenantId !== authority.tenantId
        || source.authority.sourceAccountId !== authority.sourceAccountId) {
        throw new TemplateHqTemplateError('SOURCE_AUTHORITY_MISMATCH', 422);
      }
      const items = inspectMessageTemplateDefinition(source.definition, snapshot);
      const verified: VerifiedReference[] = references.map((reference) => {
        const item = items.find((candidate) => candidate.sourceId === reference.sourceId);
        if (!item || item.itemKind !== reference.kind) {
          throw new TemplateHqTemplateError('INVALID_REFERENCE', 422);
        }
        return {
          kind: reference.kind,
          sourceId: reference.sourceId,
          targetId: item.targetId ?? dependencies.createId(item.itemKind, item.sourceId, context),
          duplicate: item.duplicate,
          expectedRevision: item.expectedRevision,
        };
      });
      return { kind: 'OK', value: verified };
    },
    async detectDuplicates(_context, references) {
      const duplicates = (references as readonly VerifiedReference[])
        .filter((reference) => reference.duplicate)
        .map((reference) => ({
          sourceId: reference.sourceId,
          targetId: reference.targetId,
          reason: reference.kind === 'template' ? 'same_name' : 'same_content',
        }));
      return { kind: 'OK', value: duplicates };
    },
    async buildIdMap(context, references) {
      const map: Record<string, string> = {};
      for (const reference of references as readonly VerifiedReference[]) {
        const resolution = context.resolutions.find((entry) => entry.sourceId === reference.sourceId);
        if (!resolution) throw new TemplateHqTemplateError('SELECTION_REQUIRED', 409);
        if ((reference.duplicate && resolution.mode === 'create')
          || (!reference.duplicate && resolution.mode !== 'create')) {
          throw new TemplateHqTemplateError('SELECTION_REQUIRED', 409);
        }
        if (resolution.mode === 'overwrite') {
          if (!reference.duplicate || resolution.targetId !== reference.targetId
            || resolution.expectedRevision !== reference.expectedRevision) {
            throw new TemplateHqTemplateError(VERSION_CONFLICT_MESSAGE, 409);
          }
          map[reference.sourceId] = reference.targetId;
        } else {
          map[reference.sourceId] = dependencies.createId(
            reference.kind === 'template' ? 'template' : 'media',
            reference.sourceId,
            context,
          );
        }
      }
      return { kind: 'OK', value: map };
    },
    async buildCommitPlan(context, input, idMap) {
      if (context.tenantId !== authority.tenantId) {
        throw new TemplateHqTemplateError('SOURCE_AUTHORITY_MISMATCH', 422);
      }
      const source = await loadAuthorizedSource(authority, input.templateVersionId, dependencies);
      const snapshot = await dependencies.loadTargetSnapshot(context);
      return {
        kind: 'OK',
        value: await planMessageTemplateDistribution({ context, source, snapshot, idMap, dependencies }),
      };
    },
  };
}

/** route が D1/R2 の依存を渡すまで安全側で拒む。 */
export const templateHqTemplateAdapter = unsupportedHqTemplateAdapter('template');
