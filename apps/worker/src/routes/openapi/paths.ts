import { stagingQaPaths } from './staging-qa-paths.js';
import { trackedLinkIdentityPaths } from './tracked-link-identity-paths.js';
import { bookingPhotosPaths } from './booking-photos-paths.js';
import { broadcastUploadPaths } from './broadcast-upload-paths.js';
import { mileageFolderPaths } from './mileage-folders-paths.js';
import { customerLookPaths } from './customer-look-paths.js';
import { gap1Paths } from '../gap1-openapi.js';
import { gap3Paths } from '../gap3-openapi.js';
import { gap2Paths } from '../gap2-openapi.js';
import { personalDataRetentionPaths } from '../personal-data-retention-openapi.js';
import { api5Paths } from '../api5-openapi.js';
import { behaviorFixPaths } from '../behavior-fix-openapi.js';
import { restaurantRest4Paths } from '../restaurant-rest4-openapi.js';
import { api1AuthoringPaths } from '../api1-authoring-openapi.js';
import { api2FollowupPaths } from '../api2-followups-openapi.js';
import { restaurantFollowupPaths } from '../restaurant-followup-openapi.js';
import { reservationBoardPaths } from '../reservation-board-openapi.js';
import { archiveRestorePaths } from '../archive-restore-openapi.js';
import { formDocumentPaths } from '../form-documents-openapi.js';
import { pagesParityPaths } from '../pages-parity-openapi.js';
import { folderUpgradePaths } from '../folder-upgrade-openapi.js';
import { auditPaths } from '../openapi-audit-paths.js';
import { tabCountPaths } from '../tab-counts-openapi.js';
import { api18Paths } from '../api18-openapi.js';
import { chatAttachmentPaths } from '../chat-attachments-openapi.js';
import { api17Paths } from '../api17-openapi.js';
import { api9Paths } from '../api9-openapi.js';
import { restaurantClosurePaths } from '../restaurant-closures-openapi.js';
import { stampPaths, hqBroadcastPaths } from '../proposal-e-openapi.js';
import { trafficPoolSavePaths } from '../traffic-pools-save-openapi.js';
import { tenantCompanyContactPaths } from '../tenant-company-contact-openapi.js';
import { bookingEntitlementPaths } from '../booking-entitlements-openapi.js';
import { bookingAssignmentPaths } from '../booking-assignment-openapi.js';
import { bookingPaymentAdminPaths } from '../booking-payment-admin-openapi.js';
import { hqAuthoringPaths } from './hq-authoring-paths.js';
import { notificationTeamsPaths } from './notification-teams-paths.js';
import { adPlatformsPaths } from './ad-platforms-paths.js';
import { eventApplicationPaths } from './event-application-paths.js';
import { photoPublicationsPaths } from './photo-publications-paths.js';
import { authenticationPaths } from './authentication-paths.js';
import { hqBannersPaths } from './hq-banners-paths.js';
import { nenMembersPaths } from './nen-members-paths.js';
import { hqBillingPaths } from './hq-billing-paths.js';
import { musuboOnboardingPaths } from './musubo-onboarding-paths.js';
import { opsSupportPaths } from './ops-support-paths.js';
import { hqTemplateUploadPaths, hqDistributionPaths } from './hq-distribution-paths.js';
import { stylePaths } from '../styles-openapi.js';
import { analyticsDashboardPaths } from './analytics-dashboard-paths.js';
import { adCostsPaths } from './ad-costs-paths.js';
import { friendsPaths } from './friends-paths.js';
import { tagsPaths } from './tags-paths.js';
import { friendAttributesPaths } from './friend-attributes-paths.js';
import { mediaScanningPaths } from './media-scanning-paths.js';
import { chatsPaths } from './chats-paths.js';
import { actionsRemindersPaths } from './actions-reminders-paths.js';
import { autoRepliesPaths } from './auto-replies-paths.js';
import { mileageScoresPaths } from './mileage-scores-paths.js';
import { scenariosPaths } from './scenarios-paths.js';
import { broadcastsPaths } from './broadcasts-paths.js';
import { nenDeliveryPaths } from './nen-delivery-paths.js';
import { accountsPaths } from './accounts-paths.js';
import { accountHandoversPaths } from './account-handovers-paths.js';
import { webhooksPaths } from './webhooks-paths.js';
import { conversionsPaths } from './conversions-paths.js';
import { affiliatesPaths } from './affiliates-paths.js';
import { templatesPhotoPolicyPaths } from './templates-photo-policy-paths.js';
import { settingsOperationsPaths } from './settings-operations-paths.js';
import { operatorNotificationsPaths } from './operator-notifications-paths.js';
import { lineWebhookPaths } from './line-webhook-paths.js';
import { bookingSelfPaths } from './booking-self-paths.js';
import { bookingChannelsPaths } from './booking-channels-paths.js';
import { bookingPaymentsPaths } from './booking-payments-paths.js';
import { bookingPrepayPaths } from './booking-prepay-paths.js';
import { bookingWaitlistPaths } from './booking-waitlist-paths.js';
import { bookingSettingsPaths } from './booking-settings-paths.js';
import { bookingAdminPaths } from './booking-admin-paths.js';
import { formsPaths } from './forms-paths.js';
import { eventsPaths } from './events-paths.js';
import { richMenusPaths } from './rich-menus-paths.js';
import { commonVarsPaths } from './common-vars-paths.js';
import { automationsPaths } from './automations-paths.js';
import { webinarsPaths } from './webinars-paths.js';

// 後の定義が先の定義を上書きする場合があるため、展開の優先順と挿入順を保つ。
export const paths = {
  ...trackedLinkIdentityPaths,
  ...bookingPhotosPaths,
  ...stagingQaPaths,
  ...api1AuthoringPaths,
  ...bookingAssignmentPaths,
  ...bookingPaymentAdminPaths,
  ...gap1Paths,
  ...gap2Paths,
  ...gap3Paths,
  ...bookingEntitlementPaths,
  ...behaviorFixPaths,
  ...customerLookPaths,
  ...pagesParityPaths,
  ...reservationBoardPaths,
  ...restaurantFollowupPaths,
  ...folderUpgradePaths,
  ...archiveRestorePaths,
  ...formDocumentPaths,
  ...tabCountPaths,
  ...tenantCompanyContactPaths,
  ...trafficPoolSavePaths,
  ...chatAttachmentPaths,
  ...mileageFolderPaths,
  ...broadcastUploadPaths,
  ...personalDataRetentionPaths,
  ...api5Paths,
  ...auditPaths,
  ...api18Paths,
  ...api2FollowupPaths,
  ...api17Paths,
  ...api9Paths,
  ...restaurantRest4Paths,
  ...restaurantClosurePaths,
  ...stampPaths,
  ...hqBroadcastPaths,
  ...hqAuthoringPaths,
  ...notificationTeamsPaths,
  ...adPlatformsPaths,
  ...eventApplicationPaths,
  ...photoPublicationsPaths,
  ...authenticationPaths,
  ...hqBannersPaths,
  ...nenMembersPaths,
  ...hqBillingPaths,
  ...musuboOnboardingPaths,
  ...opsSupportPaths,
  ...hqTemplateUploadPaths,
  ...stylePaths,
  ...hqDistributionPaths,
  ...analyticsDashboardPaths,
  ...adCostsPaths,
  ...friendsPaths,
  ...tagsPaths,
  ...friendAttributesPaths,
  ...mediaScanningPaths,
  ...chatsPaths,
  ...actionsRemindersPaths,
  ...autoRepliesPaths,
  ...mileageScoresPaths,
  ...scenariosPaths,
  ...broadcastsPaths,
  ...nenDeliveryPaths,
  ...accountsPaths,
  ...accountHandoversPaths,
  ...webhooksPaths,
  ...conversionsPaths,
  ...affiliatesPaths,
  ...templatesPhotoPolicyPaths,
  ...settingsOperationsPaths,
  ...operatorNotificationsPaths,
  ...lineWebhookPaths,
  ...bookingSelfPaths,
  ...bookingChannelsPaths,
  ...bookingPaymentsPaths,
  ...bookingPrepayPaths,
  ...bookingWaitlistPaths,
  ...bookingSettingsPaths,
  ...bookingAdminPaths,
  ...formsPaths,
  ...eventsPaths,
  ...richMenusPaths,
  ...commonVarsPaths,
  ...automationsPaths,
  ...webinarsPaths,
};
