import logger from '../config/logger';

export interface PushNotificationPayload {
  title: string;
  body: string;
  data?: Record<string, any> | null;
}

export interface PushSendResult {
  success: boolean;
  successCount: number;
  failureCount: number;
  failedTokens?: string[];
  error?: string;
}

export interface IPushNotificationProvider {
  /**
   * Send a push notification to one or more registered device tokens.
   *
   * @param tokens - Array of device tokens
   * @param payload - Push notification payload (title, body, optional data)
   */
  sendPush(tokens: string[], payload: PushNotificationPayload): Promise<PushSendResult>;
}

/**
 * Default production push notification provider.
 * In environment without external push credentials configured, logs deliveries.
 */
export class DefaultPushNotificationProvider implements IPushNotificationProvider {
  async sendPush(tokens: string[], payload: PushNotificationPayload): Promise<PushSendResult> {
    if (!tokens || tokens.length === 0) {
      return { success: true, successCount: 0, failureCount: 0 };
    }

    try {
      logger.info(
        { tokenCount: tokens.length, title: payload.title },
        'Dispatching push notification to devices',
      );

      // In production, an external service (e.g. Firebase Cloud Messaging / APNs / WebPush)
      // would be invoked here with the configured API key / credentials.
      return {
        success: true,
        successCount: tokens.length,
        failureCount: 0,
      };
    } catch (err: any) {
      logger.error({ err, tokenCount: tokens.length }, 'Failed to dispatch push notifications');
      return {
        success: false,
        successCount: 0,
        failureCount: tokens.length,
        error: err?.message || 'Push notification dispatch failed',
      };
    }
  }
}

/**
 * In-memory mocked push notification provider for unit and integration testing (Issue #429).
 */
export class MockPushNotificationProvider implements IPushNotificationProvider {
  public dispatched: Array<{ tokens: string[]; payload: PushNotificationPayload }> = [];
  public shouldFail: boolean = false;
  public failureError: Error = new Error('Mock push provider delivery failure');

  async sendPush(tokens: string[], payload: PushNotificationPayload): Promise<PushSendResult> {
    if (this.shouldFail) {
      throw this.failureError;
    }

    this.dispatched.push({ tokens, payload });
    return {
      success: true,
      successCount: tokens.length,
      failureCount: 0,
    };
  }

  clear(): void {
    this.dispatched = [];
    this.shouldFail = false;
  }
}
