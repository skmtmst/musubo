// Public entry point. Implementation is organized by responsibility.
export { resolvePinnedCommonVarAt, evaluatePinnedCommonVar } from './pinned.js';
export {
  COMMON_VAR_TYPES,
  type CommonVarType,
  type CommonVarResolutionFailureReason,
  type CommonVarResolutionEntry,
  type CommonVarResolution,
} from './resolution-types.js';
export {
  normalizeCommonVarValue,
  isSecretLikeValue,
  normalizeCommonVarValidityAt,
  resolveCommonVarValuesAt,
} from './values.js';
export {
  type CommonVar,
  type CommonVarExpiryBehavior,
  type CommonVarStatus,
  type CommonVarUsageKind,
} from './record-types.js';
export {
  type CommonVarVersion,
  type CommonVarUsageImpact,
  type CommonVarUsageItem,
  type CommonVarUsageSummary,
  type CommonVarSchedule,
  type CommonVarExpiryCandidate,
  type CommonVarReplacementTarget,
  type CommonVarReplacementPlan,
} from './types.js';
export {
  getCommonVarUsageCounts,
  getCommonVarUsageSummaries,
} from './usage-queries.js';
export {
  countCommonVars,
  COMMON_VARS_LIST_LIMIT,
  getCommonVars,
  getCommonVarUsageImpact,
  getCommonVarById,
  getCommonVarByIdIncludingArchived,
  CommonVarVersionConflictError,
  CommonVarFolderError,
  CommonVarKeyConflictError,
  CommonVarReasonRequiredError,
  CommonVarStatusTransitionError,
  createCommonVar,
} from './definitions.js';
export {
  updateCommonVar,
  setCommonVarStatus,
  listCommonVarExpiryCandidates,
  markCommonVarExpiryNotice,
  getCommonVarVersions,
  deleteCommonVar,
} from './revisions.js';
export {
  getCommonVarReplacementCandidates,
  getCommonVarReplacementPlan,
  applyCommonVarReplacementPlan,
} from './replacement.js';
export {
  getCommonVarMap,
  getCommonVarSchedules,
  createCommonVarSchedule,
  deleteCommonVarSchedule,
  isCommonVarsEnabled,
  applyDueCommonVarSchedules,
} from './schedules.js';
