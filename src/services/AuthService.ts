import { validate } from 'class-validator';
import { JWTDTO } from '../dtos/JWTDTO';
import { RegisterWithEmailDTO } from '../dtos/RegisterWithEmailDTO';
import { LoginWithEmailDTO } from '../dtos/LoginWithEmailDTO';
import { TokenIntrospectionResponse } from '../dtos/IntrospectTokenDTO';
import { Repository } from 'typeorm';
import { User, UserRole } from '../entities/User';
import { RefreshToken } from '../entities/RefreshToken';
import AppDataSource from '../config/db';
import jwt, { JwtPayload } from 'jsonwebtoken';
import redis from '../config/redis';
import { randomBytes, randomUUID } from 'crypto';
import bcrypt from 'bcrypt';
import { generateSecret, generateURI, verifySync } from 'otplib';
import QRCode from 'qrcode';
import { EmailService } from './EmailService';
import { AppError } from '../errors/AppError';
import { AuthAuditService } from './AuthAuditService';
import { AuthEventType } from '../entities/AuthAuditLog';
import { AccountMergeService } from './AccountMergeService';
import { Request } from 'express';
import logger from '../config/logger';

const PASSWORD_SALT_ROUNDS = 12;
const RECOVERY_CODE_COUNT = 8;
const RECOVERY_CODE_BYTES = 5;
const REFRESH_TOKEN_EXPIRY_SECONDS = 7 * 24 * 60 * 60;
const PARTIAL_TOKEN_EXPIRY_SECONDS = 300; // 5 minutes for 2FA step
const PASSWORD_RESET_TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour (#102)

type LoginWithEmailResult =
  | { user: User; token: string; refreshToken?: string; twoFactorRequired?: false }
  | { twoFactorRequired: true; partialToken: string; user: Pick<User, 'id' | 'email' | 'role'> };

export class AuthService {
  private userRepo: Repository<User>;
  private refreshTokenRepo: Repository<RefreshToken>;
  private emailService: EmailService;
  private auditService: AuthAuditService;
  private mergeService: AccountMergeService;

  constructor() {
    this.userRepo = AppDataSource.getRepository(User);
    this.refreshTokenRepo = AppDataSource.getRepository(RefreshToken);
    this.emailService = new EmailService();
    this.auditService = new AuthAuditService();
    this.mergeService = new AccountMergeService();
  }

  private signToken(user: User): string {
    const JWT_SECRET = process.env.JWT_SECRET as string;
    if (!JWT_SECRET) {
      throw new Error('JWT_SECRET not set in environment variables');
    }

    const payload = {
      id: user.id,
      dynamixUserId: user.dynamixUserId,
      email: user.email,
      walletAddress: user.walletAddress,
      stellarPublicKey: user.stellarPublicKey,
      role: user.role,
      username: user.username,
      profileImage: user.profileImage,
      name: user.name,
      rewardPoints: user.rewardPoints,
      emailVerified: user.emailVerified ?? (user.passwordHash ? false : undefined),
    };

    return jwt.sign(payload, JWT_SECRET, { expiresIn: '15m' });
  }

  private signRefreshToken(user: User): string {
    const REFRESH_SECRET = process.env.REFRESH_TOKEN_SECRET || process.env.JWT_SECRET || 'secret';
    // jti guarantees uniqueness: without it, two refresh tokens issued for the
    // same user within the same second are byte-identical, which collides on
    // the refresh_tokens.token unique index and defeats rotation.
    return jwt.sign({ id: user.id }, REFRESH_SECRET, {
      expiresIn: '7d',
      jwtid: randomUUID(),
    });
  }

  private async verifyRefreshToken(token: string): Promise<JwtPayload | null> {
    const REFRESH_SECRET = process.env.REFRESH_TOKEN_SECRET || process.env.JWT_SECRET || 'secret';
    try {
      return jwt.verify(token, REFRESH_SECRET) as JwtPayload;
    } catch {
      throw AppError.authentication('Invalid refresh token');
    }
  }

  /** Registers a user with email + password instead of a wallet signature. */
  async registerWithEmail(
    data: RegisterWithEmailDTO,
  ): Promise<{ user: User; token: string; refreshToken: string }> {
    const dto = Object.assign(new RegisterWithEmailDTO(), data);
    const errors = await validate(dto);
    if (errors.length > 0) {
      throw new Error(
        errors.map((error) => Object.values(error.constraints || {}).join(', ')).join(', '),
      );
    }

    if (await this.userRepo.findOneBy({ email: dto.email })) {
      throw AppError.conflict('User already exists');
    }

    const passwordHash = await bcrypt.hash(dto.password, PASSWORD_SALT_ROUNDS);
    const verificationToken = this.emailService.generateVerificationToken();
    const tokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const user = this.userRepo.create({
      email: dto.email,
      passwordHash,
      role: dto.role,
      username: dto.username,
      name: dto.name,
      emailVerificationToken: verificationToken,
      emailVerificationTokenExpiry: tokenExpiry,
      emailVerified: false,
    });
    const savedUser = await this.userRepo.save(user);

    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    await this.emailService.sendEmail(
      dto.email,
      'Verify your email',
      `<p>Please click <a href="${appUrl}/verify-email/${verificationToken}">here</a> to verify your email.</p>`,
    );

    const token = this.signToken(savedUser);
    const refreshToken = this.signRefreshToken(savedUser);
    await this.storeRefreshToken(savedUser.id, refreshToken);
    return { user: savedUser, token, refreshToken };
  }

  /** Logs in a user with email + password instead of a wallet signature. */
  async loginWithEmail(data: LoginWithEmailDTO, req?: Request): Promise<LoginWithEmailResult> {
    const dto = Object.assign(new LoginWithEmailDTO(), data);
    const errors = await validate(dto);
    if (errors.length > 0) {
      throw new Error(
        errors.map((error) => Object.values(error.constraints || {}).join(', ')).join(', '),
      );
    }

    const user = await this.userRepo.findOneBy({ email: dto.email });
    if (!user || !user.passwordHash) {
      if (req) {
        await this.auditService.logAuthEvent(AuthEventType.LOGIN_FAILED, req, {
          email: dto.email,
          success: false,
          failureReason: 'Invalid credentials',
        });
      }
      throw AppError.authentication('Invalid email or password');
    }

    const matches = await bcrypt.compare(dto.password, user.passwordHash);
    if (!matches) {
      if (req) {
        await this.auditService.logAuthEvent(AuthEventType.LOGIN_FAILED, req, {
          userId: user.id,
          email: dto.email,
          success: false,
          failureReason: 'Invalid password',
        });
      }
      throw AppError.authentication('Invalid email or password');
    }

    if (user.twoFactorEnabled) {
      if (!dto.twoFactorCode && !dto.recoveryCode) {
        return {
          twoFactorRequired: true,
          partialToken: this.generatePartialToken(user.id),
          user: { id: user.id, email: user.email, role: user.role },
        };
      }

      const verified = dto.twoFactorCode
        ? this.verifyTotpCode(user, dto.twoFactorCode)
        : await this.verifyAndConsumeRecoveryCode(user, dto.recoveryCode as string);

      if (!verified) {
        if (req) {
          await this.auditService.logAuthEvent(AuthEventType.LOGIN_FAILED, req, {
            userId: user.id,
            email: dto.email,
            success: false,
            failureReason: 'Invalid 2FA code',
          });
        }
        throw AppError.authentication('Invalid two-factor code');
      }
    }

    const token = this.signToken(user);

    if (req) {
      await this.auditService.logAuthEvent(AuthEventType.LOGIN_SUCCESS, req, {
        userId: user.id,
        email: user.email,
        success: true,
      });
    }

    return { user, token };
  }

  /**
   * Enable TOTP two-factor authentication for an email/password account.
   * Generates a secret, otpauth URL, QR code data URL, and one-time backup
   * recovery codes. Stores hashed recovery codes on the user record.
   *
   * @param userId - ID of the user enabling 2FA.
   * @returns Secret, otpauth URL, QR code data URL, and plaintext backup codes.
   * @throws {Error} If user not found or not an email/password account.
   */
  async enableTwoFactor(
    userId: string,
    req?: Request,
  ): Promise<{
    secret: string;
    otpauthUrl: string;
    qrCodeDataUrl: string;
    backupCodes: string[];
  }> {
    const user = await this.userRepo.findOneBy({ id: userId });
    if (!user) {
      throw new Error('User not found');
    }

    if (!user.passwordHash) {
      throw new Error('Two-factor authentication is only available for email/password accounts');
    }

    const secret = generateSecret();
    const label = user.email || user.username || user.id;
    const issuer = 'AudioBlocks';
    const otpauthUrl = generateURI({ label, issuer, secret });
    const backupCodes = this.generateRecoveryCodes();
    const recoveryCodeHashes = await Promise.all(
      backupCodes.map((code) =>
        bcrypt.hash(this.normalizeRecoveryCode(code), PASSWORD_SALT_ROUNDS),
      ),
    );

    user.twoFactorEnabled = true;
    user.twoFactorSecret = secret;
    user.twoFactorRecoveryCodeHashes = recoveryCodeHashes;
    await this.userRepo.save(user);

    if (req) {
      await this.auditService.logAuthEvent(AuthEventType.TWO_FACTOR_ENABLED, req, {
        userId: user.id,
        email: user.email,
        success: true,
      });
    }

    return {
      secret,
      otpauthUrl,
      qrCodeDataUrl: await QRCode.toDataURL(otpauthUrl),
      backupCodes,
    };
  }

  private verifyTotpCode(user: User, code: string): boolean {
    if (!user.twoFactorSecret) {
      return false;
    }

    return verifySync({
      token: code.replace(/\s/g, ''),
      secret: user.twoFactorSecret,
    }).valid;
  }

  /**
   * Verify a recovery code and consume it (single-use enforcement, #331).
   *
   * Each backup code is stored as a bcrypt hash. On successful verification
   * the matched hash is removed from the user's list and persisted, so the
   * same code can never be accepted twice. The length check before/after
   * the filter confirms the hash was actually removed, guarding against
   * duplicate hashes that could allow reuse.
   */
  private async verifyAndConsumeRecoveryCode(user: User, recoveryCode: string): Promise<boolean> {
    const hashes = user.twoFactorRecoveryCodeHashes || [];
    const normalized = this.normalizeRecoveryCode(recoveryCode);

    for (const hash of hashes) {
      if (await bcrypt.compare(normalized, hash)) {
        const before = hashes.length;
        const remaining = hashes.filter((storedHash) => storedHash !== hash);
        // Single-use: the hash must have been removed. If the array didn't
        // shrink, there were duplicate hashes — reject to prevent reuse.
        if (remaining.length !== before - 1) {
          return false;
        }
        user.twoFactorRecoveryCodeHashes = remaining;
        await this.userRepo.save(user);
        return true;
      }
    }

    return false;
  }

  private generateRecoveryCodes(): string[] {
    return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
      const value = randomBytes(RECOVERY_CODE_BYTES).toString('hex').toUpperCase();
      return `${value.slice(0, 5)}-${value.slice(5)}`;
    });
  }

  private normalizeRecoveryCode(code: string): string {
    return code.trim().replace(/\s/g, '').toUpperCase();
  }

  /**
   * Generate a one-time login nonce for wallet-signature authentication.
   * The nonce is stored in Redis with a 5-minute TTL.
   *
   * @param email - Email address to associate with the nonce.
   * @returns The generated hex nonce string.
   * @throws {Error} If email is not provided.
   */
  async getNonce(email: string): Promise<any> {
    if (!email) {
      throw new Error('Email is required');
    }

    const nonce = randomBytes(16).toString('hex');

    // store nonce with 5-min expiry
    await redis.set(`nonce:${email}`, nonce, 'EX', 300);

    console.log('Generated nonce:', nonce);
    console.log('Nonce from redis:', await redis.get(`nonce:${email}`));
    return nonce;
  }

  /**
   * Authenticate a user via wallet-signature verification.
   * Validates the nonce embedded in the signed message against Redis,
   * then issues a JWT.
   *
   * @param data - JWTDTO containing email, message, signature, and nonce.
   * @returns User entity and JWT token.
   * @throws {Error} If nonce invalid/expired, user not found, or validation fails.
   */
  async login(data: JWTDTO): Promise<{ user: User; token: string; refreshToken: string }> {
    const dto = Object.assign(new JWTDTO(), data);
    const errors = await validate(dto);

    if (errors.length > 0) {
      throw new Error(errors.map((error) => error.constraints).join(', '));
    }

    if (dto.message) {
      const nonceMatch = dto.message.match(/Nonce: (\w+)/);
      if (!nonceMatch) throw new Error('Nonce missing in message');
      const nonce = nonceMatch[1];

      const storedNonce = await redis.get(`nonce:${dto.email}`);
      console.log('Stored nonce:', storedNonce);
      if (!storedNonce || storedNonce !== nonce) {
        throw new Error('Invalid or expired nonce');
      }

      // Delete nonce immediately (one-time use)
      await redis.del(`nonce:${dto.email}`);
    }

    const user = await this.userRepo.findOneBy({ email: dto.email });
    if (!user) {
      throw new Error('User not found');
    }

    const token = this.signToken(user);
    const refreshToken = this.signRefreshToken(user);
    await this.storeRefreshToken(user.id, refreshToken);
    return { user, token, refreshToken };
  }

  private generatePartialToken(userId: string): string {
    const JWT_SECRET = process.env.JWT_SECRET as string;
    if (!JWT_SECRET) {
      throw AppError.businessLogic('JWT_SECRET not set in environment variables');
    }

    return jwt.sign({ id: userId, type: '2fa_partial' }, JWT_SECRET, {
      expiresIn: PARTIAL_TOKEN_EXPIRY_SECONDS,
    });
  }

  /**
   * Verify a TOTP code during 2FA enrollment. Confirms the user scanned
   * the QR code and can generate valid codes from their authenticator app.
   */
  async verifyTwoFactor(userId: string, code: string): Promise<void> {
    const user = await this.userRepo.findOneBy({ id: userId });
    if (!user) {
      throw AppError.notFound('User not found');
    }

    if (!user.twoFactorSecret) {
      throw AppError.businessLogic('Two-factor authentication not enrolled');
    }

    if (!this.verifyTotpCode(user, code)) {
      throw AppError.authentication('Invalid two-factor code');
    }
  }

  /**
   * Disable 2FA for a user. Requires a valid TOTP code or recovery code
   * to confirm the request is legitimate.
   */
  async disableTwoFactor(userId: string, code: string, req?: Request): Promise<void> {
    const user = await this.userRepo.findOneBy({ id: userId });
    if (!user) {
      throw AppError.notFound('User not found');
    }

    if (!user.twoFactorEnabled) {
      throw AppError.businessLogic('Two-factor authentication is not enabled');
    }

    const verified = this.verifyTotpCode(user, code);

    if (!verified) {
      throw AppError.authentication('Invalid two-factor code');
    }

    user.twoFactorEnabled = false;
    user.twoFactorSecret = undefined;
    user.twoFactorRecoveryCodeHashes = undefined;
    await this.userRepo.save(user);

    if (req) {
      await this.auditService.logAuthEvent(AuthEventType.TWO_FACTOR_DISABLED, req, {
        userId: user.id,
        email: user.email,
        success: true,
      });
    }
  }

  /**
   * Complete a 2FA-protected login by validating the partial token and
   * TOTP code. Returns a full JWT and refresh token on success.
   */
  async completeTwoFactorLogin(
    partialToken: string,
    code: string,
  ): Promise<{ token: string; refreshToken: string }> {
    const JWT_SECRET = process.env.JWT_SECRET as string;
    if (!JWT_SECRET) {
      throw AppError.businessLogic('JWT_SECRET not set in environment variables');
    }

    let payload: JwtPayload;
    try {
      payload = jwt.verify(partialToken, JWT_SECRET) as JwtPayload;
    } catch {
      throw AppError.authentication('Invalid or expired partial token');
    }

    if (payload.type !== '2fa_partial') {
      throw AppError.authentication('Invalid token type');
    }

    const userId = payload.id as string;
    const user = await this.userRepo.findOneBy({ id: userId });
    if (!user) {
      throw AppError.notFound('User not found');
    }

    if (!user.twoFactorEnabled) {
      throw AppError.businessLogic('Two-factor authentication is not enabled for this user');
    }

    const verified = this.verifyTotpCode(user, code);
    if (!verified) {
      throw AppError.authentication('Invalid two-factor code');
    }

    const token = this.signToken(user);
    const refreshToken = this.signRefreshToken(user);
    await this.storeRefreshToken(user.id, refreshToken);
    return { token, refreshToken };
  }

  private getRefreshTokenKey(userId: string): string {
    return `refresh:${userId}`;
  }

  private async storeRefreshToken(
    userId: string,
    refreshToken: string,
    familyId?: string,
  ): Promise<void> {
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + REFRESH_TOKEN_EXPIRY_SECONDS);
    const rt = this.refreshTokenRepo.create({
      userId,
      token: refreshToken,
      expiresAt,
      familyId: familyId || randomUUID(),
    });
    await this.refreshTokenRepo.save(rt);
  }

  async refreshToken(
    token: string,
    req?: Request,
  ): Promise<{ token: string; refreshToken: string }> {
    const payload = await this.verifyRefreshToken(token);
    const userId = payload?.id as string;
    if (!userId) {
      if (req) {
        await this.auditService.logAuthEvent(AuthEventType.TOKEN_REFRESH_FAILED, req, {
          success: false,
          failureReason: 'Invalid token payload',
        });
      }
      throw AppError.authentication('Invalid refresh token');
    }

    const rt = await this.refreshTokenRepo.findOne({ where: { token } });
    if (!rt) {
      if (req) {
        await this.auditService.logAuthEvent(AuthEventType.TOKEN_REFRESH_FAILED, req, {
          userId,
          success: false,
          failureReason: 'Token not found',
        });
      }
      throw AppError.authentication('Invalid refresh token');
    }

    if (rt.revoked) {
      // Reuse detected! Invalidate family
      if (rt.familyId) {
        await this.refreshTokenRepo.update({ familyId: rt.familyId }, { revoked: true });
      }
      if (req) {
        await this.auditService.logAuthEvent(AuthEventType.TOKEN_REFRESH_FAILED, req, {
          userId,
          success: false,
          failureReason: 'Token reuse detected',
        });
      }
      throw AppError.authentication('Refresh token reuse detected');
    }

    if (rt.expiresAt < new Date()) {
      if (req) {
        await this.auditService.logAuthEvent(AuthEventType.TOKEN_REFRESH_FAILED, req, {
          userId,
          success: false,
          failureReason: 'Token expired',
        });
      }
      throw AppError.authentication('Refresh token expired');
    }

    const user = await this.userRepo.findOneBy({ id: userId });
    if (!user) throw AppError.authentication('Invalid refresh token');

    // Revoke old token
    rt.revoked = true;
    await this.refreshTokenRepo.save(rt);

    const newToken = this.signToken(user);
    const newRefreshToken = this.signRefreshToken(user);
    await this.storeRefreshToken(user.id, newRefreshToken, rt.familyId);

    if (req) {
      await this.auditService.logAuthEvent(AuthEventType.TOKEN_REFRESH, req, {
        userId: user.id,
        email: user.email,
        success: true,
      });
    }

    return { token: newToken, refreshToken: newRefreshToken };
  }

  async logout(refreshToken: string, req?: Request): Promise<void> {
    const payload = await this.verifyRefreshToken(refreshToken);
    const userId = payload?.id as string;
    if (userId) {
      // Invalidate all for user
      await this.refreshTokenRepo.update({ userId }, { revoked: true });

      if (req) {
        await this.auditService.logAuthEvent(AuthEventType.LOGOUT, req, {
          userId,
          success: true,
        });
      }
    }
  }

  /**
   * @param token - The email verification token.
   * @returns Updated User entity with emailVerified set to true.
   * @throws {Error} If token invalid or expired.
   */
  async verifyEmail(token: string): Promise<User> {
    const user = await this.userRepo.findOne({
      where: { emailVerificationToken: token },
    });

    if (!user) {
      throw new Error('Invalid verification token');
    }

    if (user.emailVerificationTokenExpiry && user.emailVerificationTokenExpiry < new Date()) {
      throw new Error('Verification token has expired');
    }

    user.emailVerified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationTokenExpiry = undefined;
    return this.userRepo.save(user);
  }

  /**
   * Initiate a password reset flow. Generates a URL-safe reset token with a
   * 1-hour expiry and sends a reset link via email. Issuing a fresh token
   * overwrites (and thereby invalidates) any previously issued token, so only
   * the most recent link is ever valid. Silently succeeds if the user is not
   * found (prevents email enumeration).
   *
   * @param email - Email address of the account to reset.
   */
  async forgotPassword(email: string, req?: Request): Promise<void> {
    const user = await this.userRepo.findOneBy({ email });
    if (!user) return;

    const resetToken = this.emailService.generateResetToken();
    const tokenExpiry = new Date(Date.now() + PASSWORD_RESET_TOKEN_EXPIRY_MS);

    // Overwriting these fields invalidates any token issued by a prior request.
    user.passwordResetToken = resetToken;
    user.passwordResetTokenExpiry = tokenExpiry;
    await this.userRepo.save(user);

    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    await this.emailService.sendEmail(
      email,
      'Reset your password',
      `<p>Please click <a href="${appUrl}/reset-password/${resetToken}">here</a> to reset your password. This link expires in 1 hour.</p>`,
    );
  }

  /**
   * Reset a user's password using a valid reset token. Hashes the new password
   * and clears the reset token from the user record.
   *
   * @param token - The password reset token.
   * @param newPassword - The new plaintext password to set.
   * @throws {Error} If token invalid or expired.
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    const user = await this.userRepo.findOne({
      where: { passwordResetToken: token },
    });

    if (!user) {
      throw new Error('Invalid reset token');
    }

    if (user.passwordResetTokenExpiry && user.passwordResetTokenExpiry < new Date()) {
      throw new Error('Reset token has expired');
    }

    user.passwordHash = await bcrypt.hash(newPassword, PASSWORD_SALT_ROUNDS);
    user.passwordResetToken = undefined;
    user.passwordResetTokenExpiry = undefined;
    await this.userRepo.save(user);
  }

  /**
   * Introspect a token for internal services according to RFC 7662.
   * If the token is valid and user exists, returns active: true with claims.
   * If invalid, expired, or user not found, returns active: false.
   */
  async introspectToken(token: string): Promise<TokenIntrospectionResponse> {
    if (!token || typeof token !== 'string') {
      return { active: false };
    }

    const JWT_SECRET = process.env.JWT_SECRET || 'secret';
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;

      if (!decoded || !decoded.id) {
        return { active: false };
      }

      const user = await this.userRepo.findOne({
        where: { id: decoded.id },
      });

      if (!user) {
        return { active: false };
      }

      return {
        active: true,
        scope: 'read write internal',
        client_id: 'audioblock-internal',
        token_type: 'Bearer',
        sub: user.id,
        user_id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        wallet_address: user.walletAddress,
        stellar_public_key: user.stellarPublicKey,
        name: user.name,
        email_verified: user.emailVerified,
        exp: decoded.exp,
        iat: decoded.iat,
        iss: 'AudioBlock',
      };
    } catch {
      return { active: false };
    }
  }

  // eslint-disable-next-line complexity -- existing method tracked in docs/refactoring_priority.md
  async privyLogin(
    idToken: string,
    req?: Request,
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    refreshTokenFamily: string;
    user: any;
  }> {
    if (!idToken || typeof idToken !== 'string' || idToken.trim() === '') {
      if (req) {
        await this.auditService.logAuthEvent(AuthEventType.PRIVY_LOGIN_FAILED, req, {
          success: false,
          failureReason: 'Missing ID token',
        });
      }
      throw AppError.validation('Privy ID token is required');
    }

    const parts = idToken.trim().split('.');
    if (parts.length !== 3) {
      if (req) {
        await this.auditService.logAuthEvent(AuthEventType.PRIVY_LOGIN_FAILED, req, {
          success: false,
          failureReason: 'Malformed token',
        });
      }
      throw AppError.authentication('Invalid or malformed Privy ID token');
    }

    let payload: any;
    try {
      const payloadStr = Buffer.from(parts[1], 'base64').toString('utf-8');
      payload = JSON.parse(payloadStr);
    } catch {
      if (req) {
        await this.auditService.logAuthEvent(AuthEventType.PRIVY_LOGIN_FAILED, req, {
          success: false,
          failureReason: 'Token decode failed',
        });
      }
      throw AppError.authentication('Invalid or malformed Privy ID token');
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      if (req) {
        await this.auditService.logAuthEvent(AuthEventType.PRIVY_LOGIN_FAILED, req, {
          success: false,
          failureReason: 'Invalid token payload',
        });
      }
      throw AppError.authentication('Invalid or malformed Privy ID token');
    }

    const privyUserId = payload.sub || payload.id;
    if (!privyUserId) {
      if (req) {
        await this.auditService.logAuthEvent(AuthEventType.PRIVY_LOGIN_FAILED, req, {
          success: false,
          failureReason: 'Missing user ID',
        });
      }
      throw AppError.authentication('Privy user ID (sub) is required in token');
    }

    // Extract authentication data from token
    const email = payload.email;
    const walletAddress = payload.wallet_address || payload.walletAddress;
    const linkedAccounts = payload.linked_accounts || [];

    // Support for social login providers (Issue #610)
    const googleAccount = linkedAccounts.find((acc: any) => acc.type === 'google');
    const twitterAccount = linkedAccounts.find((acc: any) => acc.type === 'twitter');

    // Support for external wallet connections (Issue #613)
    const externalWallets = linkedAccounts.filter(
      (acc: any) =>
        acc.type === 'wallet' &&
        (acc.wallet_client === 'metamask' ||
          acc.wallet_client === 'walletconnect' ||
          acc.connector_type === 'injected' ||
          acc.connector_type === 'wallet_connect'),
    );

    // Support for phone/SMS OTP (Issue #611)
    const phone = payload.phone || payload.phone_number;

    // Issue #619: Auto-merge duplicate accounts during login
    let user: User | null = null;
    if (req) {
      user = await this.mergeService.autoMergeDuringLogin(privyUserId, email, walletAddress, req);
    }

    if (!user) {
      // Try to find existing user by Privy ID
      user = await this.userRepo.findOne({ where: { privyUserId } });
    }

    if (!user) {
      // Create new user if no existing account found
      user = this.userRepo.create({
        privyUserId,
        email: email || null,
        walletAddress: walletAddress || externalWallets[0]?.address || null,
        role: UserRole.LISTENER,
        emailVerified: payload.email_verified || !!email,
      });
      logger.info({ privyUserId, email, walletAddress }, 'Created new user from Privy login');
    }

    // Update user with latest data from Privy (supports all authentication methods)
    let updated = false;

    // Update email if changed
    if (email && email !== user.email && payload.email_verified) {
      user.email = email;
      user.emailVerified = true;
      updated = true;
    }

    // Update wallet if external wallet linked (Issue #613)
    if (externalWallets.length > 0 && !user.walletAddress) {
      user.walletAddress = externalWallets[0].address;
      updated = true;
      logger.info(
        { userId: user.id, wallet: externalWallets[0].address },
        'Linked external wallet',
      );
    } else if (walletAddress && !user.walletAddress) {
      user.walletAddress = walletAddress;
      updated = true;
    }

    // Update social account info (Issue #610)
    if (googleAccount) {
      // Google profile data might include email, name, etc.
      if (!user.email && googleAccount.email) {
        user.email = googleAccount.email;
        user.emailVerified = googleAccount.verified_email || false;
        updated = true;
      }
      logger.info({ userId: user.id, provider: 'google' }, 'Google account linked via Privy');
    }

    if (twitterAccount) {
      // Update Twitter profile information
      if (twitterAccount.username && !user.twitterUsername) {
        user.twitterUsername = twitterAccount.username;
        user.twitterId = twitterAccount.subject || twitterAccount.id;
        user.twitterDisplayName = twitterAccount.name;
        user.twitterProfileImage = twitterAccount.profile_picture_url;
        user.twitterVerified = twitterAccount.verified || false;
        user.twitterConnected = true;
        updated = true;
        logger.info(
          { userId: user.id, twitterUsername: user.twitterUsername },
          'Twitter account linked via Privy',
        );
      }
    }

    // Save user if updated
    if (updated || !user.id) {
      await this.userRepo.save(user);
    }

    const accessToken = this.signToken(user);
    const refreshToken = this.signRefreshToken(user);
    const refreshTokenFamily = randomUUID();

    // Store refresh token in database
    const refreshTokenEntity = this.refreshTokenRepo.create({
      token: refreshToken,
      userId: user.id,
      familyId: refreshTokenFamily,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_EXPIRY_SECONDS * 1000),
    });
    await this.refreshTokenRepo.save(refreshTokenEntity);

    if (req) {
      await this.auditService.logAuthEvent(AuthEventType.PRIVY_LOGIN_SUCCESS, req, {
        userId: user.id,
        email: user.email,
        privyUserId,
        success: true,
        metadata: {
          hasEmail: !!email,
          hasWallet: !!walletAddress,
          hasGoogle: !!googleAccount,
          hasTwitter: !!twitterAccount,
          externalWalletCount: externalWallets.length,
        },
      });
    }

    return {
      accessToken,
      refreshToken,
      refreshTokenFamily,
      user: {
        id: user.id,
        email: user.email,
        walletAddress: user.walletAddress,
        role: user.role,
        username: user.username,
        profileImage: user.profileImage,
      },
    };
  }

  async privyRefreshToken(
    userId: string,
    currentRefreshToken: string,
    req?: Request,
  ): Promise<{
    accessToken: string;
    refreshToken: string;
  }> {
    if (!userId || !currentRefreshToken) {
      await this.logRefreshFailure(req, userId, 'Missing parameters');
      throw AppError.validation('User ID and refresh token required');
    }

    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      await this.logRefreshFailure(req, userId, 'User not found');
      throw AppError.notFound('User not found');
    }

    const rt = await this.refreshTokenRepo.findOne({ where: { token: currentRefreshToken } });
    if (!rt) {
      await this.logRefreshFailure(req, userId, 'Token not found');
      throw AppError.authentication('Invalid refresh token');
    }

    if (rt.userId !== userId) {
      await this.refreshTokenRepo.update({ userId }, { revoked: true });
      await this.logRefreshFailure(req, userId, 'Token user mismatch');
      throw AppError.authentication('Invalid refresh token');
    }

    if (rt.revoked) {
      if (rt.familyId) {
        await this.refreshTokenRepo.update({ familyId: rt.familyId }, { revoked: true });
      }
      await this.logRefreshFailure(req, userId, 'Token reuse detected');
      throw AppError.authentication('Refresh token reuse detected');
    }

    if (rt.expiresAt < new Date()) {
      await this.logRefreshFailure(req, userId, 'Token expired');
      throw AppError.authentication('Refresh token expired');
    }

    rt.revoked = true;
    await this.refreshTokenRepo.save(rt);

    const accessToken = this.signToken(user);
    const refreshToken = this.signRefreshToken(user);
    await this.storeRefreshToken(userId, refreshToken, rt.familyId);

    if (req) {
      await this.auditService.logAuthEvent(AuthEventType.PRIVY_TOKEN_REFRESH, req, {
        userId,
        email: user.email,
        success: true,
      });
    }

    return { accessToken, refreshToken };
  }

  private async logRefreshFailure(
    req: Request | undefined,
    userId: string,
    failureReason: string,
  ): Promise<void> {
    if (req) {
      await this.auditService.logAuthEvent(AuthEventType.TOKEN_REFRESH_FAILED, req, {
        userId,
        success: false,
        failureReason,
      });
    }
  }

  async privyLogout(userId: string, req?: Request): Promise<void> {
    if (!userId) {
      throw new Error('User ID required');
    }

    // Revoke all refresh tokens for this user
    await this.refreshTokenRepo.update({ userId }, { revoked: true });

    if (req) {
      await this.auditService.logAuthEvent(AuthEventType.PRIVY_LOGOUT, req, {
        userId,
        success: true,
      });
    }
  }

  private generateAccessToken(payload: any): string {
    const JWT_SECRET = process.env.JWT_SECRET || 'secret';
    return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
  }
}
