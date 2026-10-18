import { Request, Response } from 'express';
import { PrivyWebhookService } from '../services/privy/PrivyWebhookService';
import { PrivyUserResolver } from '../services/privy/PrivyUserResolver';
import { UserService } from '../services/UserService';
import { AppError } from '../errors/AppError';
import { handleError } from '../utils/helpers';
import logger from '../config/logger';
import { DataSource } from 'typeorm';
import AppDataSource from '../config/db';

/**
 * Handles Privy webho
ofile updates from Privy dashboard
 * - user.linked_account: Stellar wallet linking via Privy (Issue #614)
 */
export class PrivyWebhookController {
  private webhookService: PrivyWebhookService;
  private userResolver: PrivyUserResolver;
  private userService: UserService;
  private dataSource: DataSource;

  constructor() {
    this.webhookService = new PrivyWebhookService(
      process.env.PRIVY_WEBHOOK_SECRET ||
        process.env.PRIVY_APP_SECRET ||
        'development-webhook-secret',
    );
    this.userResolver = new PrivyUserResolver();
    this.userService = new UserService();
    this.dataSource = AppDataSource;
  }

  handleWebhook = async (req: Request, res: Response) => {
    try {
      const event = req.body;
      const eventType = event?.type;

      switch (eventType) {
        case 'user.created':
          await this.handleUserCreated(event);
          break;

        case 'user.updated':
          await this.handleUserUpdated(event);
          break;

        case 'user.linked_account':
          await this.handleLinkedAccount(event);
          break;

        default:
          logger.warn({ eventType }, 'Unknown Privy webhook event type');
      }

      res.status(200).json({ success: true, received: true });
    } catch (error) {
      logger.error({ err: error }, 'Privy webhook processing failed');
      handleError(req, res, error);
    }
  };

  /**
   * Handle user.created event (Issue #612 - embedded wallet creation on signup).
   *
   * Creates a new local user account and links the Privy identity.
   * Privy automatically creates an embedded wallet for the user.
   */
  private async handleUserCreated(event: any): Promise<void> {
    const data = event.data;
    const privyUserId = data.user?.id || data.id;

    if (!privyUserId) {
      throw AppError.validation('Missing Privy user ID in webhook payload');
    }

    // Check if user already exists
    const existingUser = await this.dataSource.getRepository('User').findOne({
      where: { privyUserId },
    });

    if (existingUser) {
      logger.info({ privyUserId }, 'User already exists, skipping creation');
      return;
    }

    // Extract user data from Privy webhook
    const email = data.user?.email?.address || data.email;
    const walletAddress = data.user?.wallet?.address || data.wallet?.address;
    const linkedAccounts = data.user?.linked_accounts || [];

    // Issue #612: Support embedded wallet creation
    const embeddedWallet = linkedAccounts.find(
      (acc: any) => acc.type === 'wallet' && acc.wallet_client_type === 'privy',
    );

    // Issue #616: Default role is listener, can be upgraded later
    const role = 'listener';

    await this.userService.createUser({
      privyUserId,
      email: email || undefined,
      walletAddress: embeddedWallet?.address || walletAddress || undefined,
      role,
      emailVerified: !!email,
    });

    logger.info(
      {
        privyUserId,
        email,
        hasEmbeddedWallet: !!embeddedWallet,
        walletAddress: embeddedWallet?.address || walletAddress,
      },
      'Created user from Privy webhook',
    );
  }

  /**
   * Handle user.updated event.
   * Updates local user data when profile changes in Privy dashboard.
   */
  private async handleUserUpdated(event: any): Promise<void> {
    const data = event.data;
    const privyUserId = data.user?.id || data.id;

    if (!privyUserId) {
      throw AppError.validation('Missing Privy user ID in webhook payload');
    }

    const user = await this.dataSource.getRepository('User').findOne({
      where: { privyUserId },
    });

    if (!user) {
      logger.warn({ privyUserId }, 'User not found for update event, skipping');
      return;
    }

    // Update user fields from webhook data
    let updated = false;
    const email = data.user?.email?.address || data.email;

    if (email && email !== user.email) {
      user.email = email;
      user.emailVerified = true;
      updated = true;
    }

    if (updated) {
      await this.dataSource.getRepository('User').save(user);
      logger.info({ privyUserId, userId: user.id }, 'Updated user from Privy webhook');
    }
  }

  /**
   * Handle user.linked_account event (Issue #614 - Stellar wallet linking).
   *
   * When a user links an external wallet (including Stellar wallets),
   * update their account with the new wallet address.
   */
  private async handleLinkedAccount(event: any): Promise<void> {
    const data = event.data;
    const privyUserId = data.user?.id || data.user_id;
    const linkedAccount = data.linked_account || data.account;

    if (!privyUserId || !linkedAccount) {
      throw AppError.validation('Missing required fields in linked_account webhook');
    }

    const user = await this.dataSource.getRepository('User').findOne({
      where: { privyUserId },
    });

    if (!user) {
      logger.warn({ privyUserId }, 'User not found for linked_account event, skipping');
      return;
    }

    const accountType = linkedAccount.type;
    let updated = false;

    // Issue #614: Handle Stellar wallet linking
    if (accountType === 'wallet' || accountType === 'stellar_wallet') {
      const address = linkedAccount.address;
      const chainType = linkedAccount.chain_type || linkedAccount.chain;

      // Detect Stellar wallet by chain type or address format (starts with G)
      if (chainType === 'stellar' || (address && address.startsWith('G'))) {
        if (!user.stellarPublicKey) {
          user.stellarPublicKey = address;
          updated = true;
          logger.info({ privyUserId, stellarAddress: address }, 'Linked Stellar wallet');
        }
      } else {
        // Handle other blockchain wallets (Ethereum, etc.)
        if (!user.walletAddress) {
          user.walletAddress = address;
          updated = true;
          logger.info({ privyUserId, walletAddress: address, chainType }, 'Linked external wallet');
        }
      }
    }

    // Handle Twitter account linking (Issue #610)
    if (accountType === 'twitter' || accountType === 'twitter_oauth') {
      user.twitterId = linkedAccount.subject || linkedAccount.id;
      user.twitterUsername = linkedAccount.username;
      user.twitterDisplayName = linkedAccount.name;
      user.twitterProfileImage = linkedAccount.profile_picture_url;
      user.twitterVerified = linkedAccount.verified || false;
      user.twitterConnected = true;
      updated = true;
      logger.info(
        { privyUserId, twitterUsername: linkedAccount.username },
        'Linked Twitter account',
      );
    }

    // Handle Google account linking (Issue #610)
    if (accountType === 'google' || accountType === 'google_oauth') {
      if (!user.email && linkedAccount.email) {
        user.email = linkedAccount.email;
        user.emailVerified = linkedAccount.verified_email || false;
        updated = true;
        logger.info({ privyUserId, email: linkedAccount.email }, 'Linked Google account');
      }
    }

    if (updated) {
      await this.dataSource.getRepository('User').save(user);
    }
  }
}
