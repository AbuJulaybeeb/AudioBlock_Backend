import { UserRole } from '../entities/User';

/**
 * Granular permissions checked by the RBAC middleware (Issue #100).
 *
 * A permission names a single capability. Roles are mapped to the set of
 * permissions they hold in {@link ROLE_PERMISSIONS}, so route handlers can
 * require a capability rather than hard-coding which roles happen to have it.
 */
export enum Permission {
  // Content moderation
  CONTENT_MODERATE = 'content:moderate',

  /**
   * Bulk song moderation (Issue #85). Held only by admins and above: a single
   * request can change the status of up to 50 songs, so it is deliberately not
   * granted to moderators alongside the per-song CONTENT_MODERATE capability.
   */
  CONTENT_MODERATE_BULK = 'content:moderate:bulk',

  // Background jobs / operational visibility
  JOBS_VIEW = 'jobs:view',

  // Search index maintenance
  SEARCH_MANAGE = 'search:manage',

  // User & role administration
  USER_MANAGE = 'user:manage',
  ROLE_ASSIGN = 'role:assign',

  // Artist verification review (Issue #92)
  VERIFICATION_REVIEW = 'verification:review',

  // Transaction logs visibility (Issue #39)
  TRANSACTION_LOGS_VIEW = 'transaction-logs:view',

  // Platform-wide AI feature usage (Issue #289)
  AI_USAGE_VIEW = 'ai-usage:view',
}

/**
 * Maps each role to the permissions it is granted.
 *
 * Roles are additive but not hierarchical: a role holds exactly the
 * permissions listed for it. `super_admin` is granted every permission so
 * that adding a new capability does not silently exclude the top role.
 */
export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  [UserRole.LISTENER]: [],
  [UserRole.ARTIST]: [],
  [UserRole.MODERATOR]: [
    Permission.CONTENT_MODERATE,
    Permission.JOBS_VIEW,
    Permission.VERIFICATION_REVIEW,
  ],
  [UserRole.ADMIN]: [
    Permission.CONTENT_MODERATE,
    Permission.CONTENT_MODERATE_BULK,
    Permission.JOBS_VIEW,
    Permission.SEARCH_MANAGE,
    Permission.USER_MANAGE,
    Permission.ROLE_ASSIGN,
    Permission.VERIFICATION_REVIEW,
    Permission.TRANSACTION_LOGS_VIEW,
    Permission.AI_USAGE_VIEW,
  ],
  [UserRole.SUPER_ADMIN]: Object.values(Permission),
};

/** True when `role` is granted `permission`. */
export function roleHasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
