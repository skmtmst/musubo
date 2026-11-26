import { logger } from '@line-crm/shared/server';
import type { Env } from '../worker-env.js';
import { restaurantTestEnabled } from '../lib/environment-features.js';
import { isRestaurantIntakeRecipient, receiveRestaurantIntakeEmail } from './restaurant-email-intake.js';
import { receiveSupportEmail } from './support-email.js';

import { accountEmailPrefix, receiveAccountEmail } from './account-email-inbound.js';

type InboundEmailHandlers = {
  receiveRestaurantIntakeEmail: typeof receiveRestaurantIntakeEmail;
  receiveSupportEmail: typeof receiveSupportEmail;
};

const defaultHandlers: InboundEmailHandlers = {
  receiveRestaurantIntakeEmail,
  receiveSupportEmail,
};

/** 飲食店向けcatch-allと既存サポート受信を、宛先ローカル部で分離する。 */
export async function routeInboundEmail(
  message: ForwardableEmailMessage,
  env: Env['Bindings'],
  handlers: InboundEmailHandlers = defaultHandlers,
): Promise<void> {
  if (env.ACCOUNT_EMAIL_DOMAIN && message.to.toLowerCase().endsWith('@' + env.ACCOUNT_EMAIL_DOMAIN.trim().toLowerCase())) {
    if (!message.to.toLowerCase().startsWith(accountEmailPrefix)) {
      message.setReject('受信用アドレスが無効です');
      return;
    }
    try {
      await receiveAccountEmail(message, env);
    } catch {
      logger.error("account_email.receive_failed");
      throw new Error('店舗メールの受信処理を完了できませんでした');
    }
    return;
  }
  if (isRestaurantIntakeRecipient(message.to)) {
    if (!restaurantTestEnabled(env)) {
      message.setReject('予約メール受信は現在利用できません');
      return;
    }
    try {
      await handlers.receiveRestaurantIntakeEmail(message, env);
    } catch (error) {
      logger.error("restaurant_email.receive_failed");
      message.setReject('予約メール受信処理に失敗しました');
    }
    return;
  }

  try {
    await handlers.receiveSupportEmail(message, env);
  } catch (error) {
    logger.error("support_email.receive_failed");
    message.setReject('メール受信処理に失敗しました');
  }
}
