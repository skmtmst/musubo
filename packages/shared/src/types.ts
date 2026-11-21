// 共有型の互換入口。型の正本は types/ 配下の機能別ファイルに置く。
// 新しい型も機能別ファイルで定義し、ここから同じ公開名で渡す。
// D1: TEXT/BLOB・ID・日時は string、INTEGER/REAL は number、NULL は null。

export type { TagCsvImportRowCode } from './tag-import-row-code.js';
export type { Tag } from './tag-types.js';
export type { AdConversionRetryResult } from './advertising-retry-types.js';

export type {
  Friend,
  FriendChatStatus,
  User,
  LineFriend,
  EcIdentityCandidateSummary,
  FriendActiveMonthComparison,
  FriendUpcomingItem,
  FriendSummary,
} from './types/friends.js';
export type {
  TagCsvImportInputRow,
  TagCsvImportRowStatus,
  TagCsvImportRowResult,
  TagCsvImportSummary,
  TagCsvImportPreview,
  TagCsvImportResult,
  TagGroup,
  FriendTag,
} from './types/tags.js';
export type {
  FriendFieldType,
  FriendField,
  FriendFieldListSummary,
} from './types/friend-fields.js';
export type {
  Folder,
} from './types/folders.js';
export type {
  SupportMark,
} from './types/support-marks.js';
export type {
  MediaItem,
  MediaUsage,
  MediaDeleteImpactReferenceKind,
  MediaDeleteImpactReference,
  MediaDeleteImpact,
  MediaReplacementBlocker,
  MediaReplacementReference,
  MediaReplacementImpact,
  MediaReplacementResult,
} from './types/media.js';
export type {
  CommonVar,
  CommonVarSchedule,
  CommonVarUsageKind,
  CommonVarDeleteImpactItem,
  CommonVarDeleteImpactUnavailableReference,
  CommonVarDeleteImpact,
  CommonVarChangeImpactItem,
  CommonVarChangeImpact,
} from './types/common-vars.js';
export type {
  SavedSearchConditionKind,
  SavedSearchCondition,
  SavedSearchConditions,
  SavedSegmentRule,
  SavedSegmentCondition,
  SavedSegmentConditions,
  SavedSearch,
  SavedSegmentPreset,
  SavedSearchUsageKind,
  SavedSearchReferenceMode,
  SavedSearchUsage,
} from './types/saved-searches.js';
export type {
  MessageType,
  LineMessageType,
  MessageDirection,
  MessageLog,
} from './types/messages.js';
export type {
  ScenarioTriggerType,
  DeliveryMode,
  Scenario,
  ScenarioStep,
  ScenarioStats,
  FriendScenarioStatus,
  FriendScenario,
} from './types/scenarios.js';
export type {
  TemplateUsages,
  Template,
} from './types/templates.js';
export type {
  BroadcastTargetType,
  BroadcastStatus,
  Broadcast,
} from './types/broadcasts.js';
export type {
  AutoReplyMatchType,
  AutoReply,
  AutoReplyDraftInput,
  AutoReplyDraftVersion,
  AutoReplyTestReasonCode,
  AutoReplyConflict,
  AutoReplyValidationResult,
  AutoReplyDryRunResult,
  AutoReplyPublishResult,
  AutoReplyEvaluationStatus,
  AutoReplyRun,
  AutoReplyRunsResponse,
  AutoReplyOperatorNotificationConfig,
} from './types/auto-replies.js';
export type {
  LineAccountTagSummary,
  LineAccountTagInput,
  LineAccountFolderList,
  LineAccountFolderInput,
  LineAccount,
  AccountHealthLog,
  AccountMigration,
  LineAccountConnectInput,
  LineAccountRegistrationTags,
  LineAccountRegistrationTag,
} from './types/line-accounts.js';
export type {
  TrafficPool,
  PoolAccount,
  CreateTrafficPoolRequest,
} from './types/traffic-pools.js';
export type {
  EntryRoute,
  EntryRouteGenre,
  EntryRouteCouponReceived,
  CreateEntryRouteInput,
  EntryRouteMonth,
  EntryRouteFunnel,
} from './types/entry-routes.js';
export type {
  ConversionMeasureMethod,
  ConversionPoint,
  ConversionEvent,
  AdEventMapping,
  SaveAdEventMappingRequest,
  MeasurementSiteReceipt,
  AdConversionCostSummary,
  AdPlatformConnectResult,
} from './types/conversions.js';
export type {
  Affiliate,
  AffiliateClick,
} from './types/affiliates.js';
export type {
  IncomingWebhook,
  IncomingWebhookCreated,
  OutgoingWebhook,
  OutgoingWebhookCreated,
  WebhookInteractionDirection,
  WebhookInteractionStatus,
  WebhookInteractionFailureReason,
  WebhookInteraction,
  WebhookInteractionSummary,
  WebhookInteractionList,
  OutgoingWebhookVersionConflict,
} from './types/webhooks.js';
export type {
  GoogleCalendarConnection,
  CalendarBooking,
} from './types/calendar.js';
export type {
  ReminderTriggerType,
  Reminder,
  ReminderStep,
  FriendReminder,
  ReminderLifecycleStatus,
  ReminderStopConditions,
  ReminderDraftStep,
  ReminderTargetCondition,
  ReminderDraftSettings,
  ReminderDraftVersion,
  ReminderValidationResult,
  ReminderPreviewResult,
  ReminderPublishResult,
  ReminderTestRecipientStatus,
  ReminderDeliveryRunStatus,
  ReminderDeliveryRun,
  ReminderDeliveryRunsResponse,
} from './types/reminders.js';
export type {
  ScoringRule,
  FriendScore,
} from './types/scoring.js';
export type {
  Operator,
  Chat,
} from './types/chat.js';
export type {
  NotificationRule,
  Notification,
  NotificationCenterCategory,
  NotificationCenterItem,
  NotificationCenterData,
  OperatorNotificationTeam,
} from './types/notifications.js';
export type {
  StripeEvent,
} from './types/payments.js';
export type {
  AutomationEventType,
  AutomationAction,
  Automation,
  AutomationLog,
} from './types/automations.js';
export type {
  AdminUser,
  AdminUserPublic,
  StaffMember,
  StaffProfile,
} from './types/staff.js';
export type {
  ApiResponse,
  PaginatedResponse,
} from './types/api-responses.js';
export type {
  FriendAddFirstTimeCriterion,
  FriendAddTiming,
  FriendAddReturningMode,
  FriendAddStartPosition,
  FriendAddAction,
  FriendAddRowActionType,
  FriendAddBranch,
  FriendAddRouting,
  FriendAddRoutingVersionStatus,
  FriendAddRoutingTestStatus,
  FriendAddRoutingVersion,
  FriendAddRoutingValidationCheck,
  FriendAddRoutingValidation,
  FriendAddRoutingDraftTestResult,
  FriendAddRoutingPublishResult,
  FriendAddEventKind,
  FriendAddEventAttributionStatus,
  FriendAddEventRoutingStatus,
  FriendAddEventItem,
  FriendAddEventSummary,
  FriendAddEventList,
  FriendAddEventViewState,
} from './types/friend-add.js';
export { FRIEND_ADD_ROUTING_DEFAULT } from './types/friend-add.js';
export type {
  ExecutionOwnerKind,
  ExecutionRunStatus,
  ExecutionRunIdentity,
  ExecutionRunListItem,
} from './types/execution-runs.js';
export type {
  HqBannerImageQuery,
  HqBannerImageCounts,
  HqTemplateFolder,
  HqScenarioDefinition,
  HqTemplateTextOverride,
  HqBannerFolderKind,
  HqBannerFolder,
} from './types/hq-content.js';
export type {
  GettingStartedStep, GettingStartedFirstRun,
  DashboardActivityItem,
} from './types/dashboard.js';
export type {
  PublicationViewSample,
  PublicationThirtyDayCount,
  PhotoPublicationOrderInput,
  PhotoPublicationPublishResult,
} from './types/publications.js';
export type {
  EventApplicationPreview,
} from './types/events.js';
export type {
  FormSubmissionPostActions,
  FormSubmissionDetail,
  FormSubmissionPage,
} from './types/forms.js';
