export { starter } from './style-starter-set.js';
import { materializeInitialMenuAssets } from './style-initial-assets.js';
import { starter } from './style-starter-set.js';
import { restaurantDefaultFeatures, type AccountStyle, type SetupAnswer } from '@line-crm/shared';
import { storeFeatureInitialization } from '@line-crm/db/src/store-feature-initialization.js';

export * from './style-setup-core.js';
export * from './style-starter-definition.js';
export { featureReadiness, styleWarnings } from './style-readiness.js';
import { StyleError, checkStyle, readAnswers } from './style-setup-core.js';
import { readDefinition, standardStarter } from './style-starter-definition.js';
import { restaurantFollowupSeedStatement } from './restaurant-followup-rows.js';
import { insertStyleStarterItems } from './style-starter-insert.js';
import { logger } from '@line-crm/shared/server';
import { HqTemplateError } from './hq-templates/tag.js';
import { applyCatalogStarter, type StarterCatalogRuntime } from './style-starter-catalog-apply.js';
export {profile,profileAnswers,type StyleProfile} from './style-profile.js';
import {profile,profileAnswers,hasPendingStyleSelection} from './style-profile.js';
function assertVersion(expected: unknown, actual: number) {
  if (!Number.isInteger(expected) || expected !== actual)
    throw new StyleError('version_conflict', 409);
}
export async function saveProfile(
  db: D1Database,
  account: string,
  tenant: string | null,
  actor: string,
  input: Record<string, unknown>,
  options: { initialSelectionPending?: boolean; images?: R2Bucket; catalogRuntime?: StarterCatalogRuntime } = {},
) {
  const current = await profile(db, account);
  assertVersion(input.expectedVersion, current?.version ?? 0);
  const submittedAnswers =
    input.answers === undefined ? {} : readAnswers(input.answers);
  const chosenStyle =
    submittedAnswers.style?.mode === 'configured'
      ? submittedAnswers.style.value
      : undefined;
  if (chosenStyle !== undefined) {
    checkStyle(chosenStyle);
    if (input.style !== undefined && input.style !== chosenStyle)
      throw new StyleError('invalid_style');
  }
  const style = checkStyle(
    input.style ?? chosenStyle ?? current?.style ?? 'standard',
  );
  const answers = {
    ...JSON.parse(current?.answers_json ?? '{}'),
    ...submittedAnswers,
  } as Record<string, SetupAnswer>;
  const styleMode =
    options.initialSelectionPending ? 'later' : input.styleMode ??
    submittedAnswers.style?.mode ??
    (input.style !== undefined
      ? 'configured'
      : (current?.selection_mode ?? 'later'));
  if (!['configured', 'later', 'manual'].includes(styleMode as string))
    throw new StyleError('invalid_style_mode');
  const selected = styleMode === 'configured';
  const explicitSelection = input.style !== undefined || input.styleMode !== undefined || submittedAnswers.style !== undefined;
  const selectionPending = options.initialSelectionPending === true
    || (!explicitSelection && hasPendingStyleSelection(current));
  if (
    submittedAnswers.style &&
    input.styleMode !== undefined &&
    input.styleMode !== submittedAnswers.style.mode
  )
    throw new StyleError('invalid_style_mode');
  answers.style = {
    mode: styleMode as SetupAnswer['mode'],
    ...(selected ? { value: style } : {}),
    ...(selectionPending ? { selectionPending: true } : {}),
  };
  const now = new Date().toISOString(),
    version = (current?.version ?? 0) + 1;
  const settings = { ...JSON.parse(current?.settings_json ?? '{}') };
  if (input.settings !== undefined) {
    if (
      !input.settings ||
      typeof input.settings !== 'object' ||
      Array.isArray(input.settings)
    )
      throw new StyleError('invalid_settings');
    for (const [k, v] of Object.entries(input.settings)) {
      if (
        ![
          'returnDays',
          'recallFallbackDays',
          'recallMultiplier',
          'inactiveDays',
          'nextBookingHours',
          'noShowDays',
          'minimumSample',
        ].includes(k) ||
        typeof v !== 'number' ||
        !Number.isFinite(v) ||
        v <= 0 ||
        v > 365
      )
        throw new StyleError('invalid_settings');
      settings[k] = v;
    }
  }
  const cards = current?.style === style ? current.cards_json : null;
  const statements: D1PreparedStatement[] = [];
  // CAS が失敗したら、作成した見本も含め D1 batch 全体を中断する。
  statements.push(
    db
      .prepare(
        `SELECT json(CASE WHEN COALESCE((SELECT version FROM account_styles WHERE line_account_id=?),0)=? THEN '{}' ELSE 'STYLE_VERSION_CONFLICT' END)`,
      )
      .bind(account, current?.version ?? 0),
  );
  statements.push(
    db
      .prepare(
        `INSERT INTO account_styles(line_account_id,style,answers_json,cards_json,settings_json,version,updated_at,updated_by,selected_at,selection_mode,first_selected_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(line_account_id) DO UPDATE SET style=excluded.style,answers_json=excluded.answers_json,cards_json=excluded.cards_json,settings_json=excluded.settings_json,version=excluded.version,updated_at=excluded.updated_at,updated_by=excluded.updated_by,selected_at=excluded.selected_at,selection_mode=excluded.selection_mode,first_selected_at=COALESCE(account_styles.first_selected_at,excluded.first_selected_at)`,
      )
      .bind(
        account,
        style,
        JSON.stringify(answers),
        cards,
        JSON.stringify(settings),
        version,
        now,
        actor,
        selected ? now : null,
        styleMode,
        selected ? now : null,
      ),
  );
  if (selected && style === 'restaurant') {
    // 既存の手動設定は守る。初めて飲食店を選んだ時だけ、サイドバーと同じ初期値を一括保存する。
    statements.push(db.prepare(`INSERT OR IGNORE INTO account_settings
      (id, line_account_id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), account, 'feature.settings_bundle_v1', JSON.stringify({
        version: 1,
        data: { features: restaurantDefaultFeatures(), sidebarOrder: null, sidebarItemOrder: null },
      }), now, now));
  }
  if (selected && style === 'restaurant') statements.push(restaurantFollowupSeedStatement(db,{accountId:account}));
  const previousAnswers = JSON.parse(current?.answers_json ?? '{}') as Record<
    string,
    SetupAnswer
  >;
  statements.push(
    storeFeatureInitialization(db, account, tenant, actor, Date.parse(now)),
  );
  const changedAnswers = Object.fromEntries(
    Object.entries(submittedAnswers).filter(
      ([key, value]) =>
        JSON.stringify(previousAnswers[key]) !== JSON.stringify(value),
    ),
  );
  // 回答保存で実予約設定を変更しない。画面の確認後、既存の版付き設定 API で反映する。
  const bookingSettingsChanges = Object.entries(changedAnswers).map(
    ([key, answer]) => ({ key, answer }),
  );
  const preparedSet = await starter(db,tenant,style,answers.image?.value==='simple');
  if (selected && answers.image?.mode==='configured' && answers.image.value==='simple')
    await materializeInitialMenuAssets(db,options.images,account,style,preparedSet.definition);
  const { set, inserted, updated, skipped } = await insertStyleStarterItems(
    db,
    account,
    tenant,
    actor,
    input,
    selected || options.initialSelectionPending === true,
    style,
    answers,
    statements,
    now,
    {set:preparedSet},
  );
  statements.push(
    db
      .prepare(
        'INSERT INTO style_change_logs(id,line_account_id,actor_id,action,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .bind(
        crypto.randomUUID(),
        account,
        actor,
        'profile.save',
        current ? JSON.stringify(current) : null,
        JSON.stringify({ style, answers, version }),
        now,
      ),
  );
  try {
    await db.batch(statements);
  } catch (e) {
    if (String(e).includes('malformed JSON'))
      throw new StyleError('version_conflict', 409);
    throw e;
  }
  let catalogApplication: import('@line-crm/shared').StarterCatalogApplyResult | undefined;
  if(set.definition.mode==='catalog' && tenant && selected) {
    try { catalogApplication=await applyCatalogStarter(db,tenant,account,actor,style,options.catalogRuntime); }
    catch(error) {
      const expected=error instanceof StyleError || (error instanceof HqTemplateError && error.status<500);
      if(!expected) {
        logger.error('style_starter_catalog_failed');
        try{await options.catalogRuntime?.reportError?.(error instanceof Error?error:new Error('catalog_application_failed'))}catch{logger.error('style_starter_catalog_report_failed')}
      }
      catalogApplication={mode:'catalog',items:(set.definition.selections??[]).map(item=>({...item,state:expected?'blocked':'failed',reason:expected?error.code:'catalog_application_failed'}))};
    }
  }
  return {
    catalogApplication,
    style,
    styleMode,
    styleSelected: selected,
    shouldPromptStyleSelection: selectionPending,
    answers,
    settings,
    changedAnswers,
    bookingSettingsChanges,
    version,
    inserted,
    updated,
    skipped,
    starterSet: { id: set.id, version: set.version },
  };
}
/** 所有権と接続を検証した作成処理からだけ呼び、読取で設定を書かない。 */
export async function initializeAccountStyle(
  db: D1Database,
  account: string,
  tenant: string | null,
  actor: string,
  selectedStyle?: AccountStyle,
  catalogRuntime?: StarterCatalogRuntime,
) {
  if (selectedStyle !== undefined) {
    return saveProfile(db, account, tenant, actor, { expectedVersion: 0, style: checkStyle(selectedStyle) }, { catalogRuntime });
  }
  return saveProfile(db, account, tenant, actor, {
    expectedVersion: 0,
    style: 'standard',
  }, { initialSelectionPending: true, catalogRuntime });
}
