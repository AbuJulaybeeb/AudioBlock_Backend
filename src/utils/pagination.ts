/**
 * Standardized pagination for all list endpoints (#337).
 *
 * Convention: `page` (1-indexed) and `limit` (max 100) query params,
 * with a consistent response envelope.
 *
 * Usage in a controller:
 *   const { page, limit, skip } = parsePagination(req.query);
 *   const [items, total] = await repo.findAndCount({ skip, take: limit });
 *   res.json(paginatedResponse(items, total, page, limit));
 */

export interface PaginationParams {
  /** 1-indexed page number. */
  page: number;
  /** Items per page (1–100). */
  limit: number;
  /** Number of items to skip (derived). */
  skip: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasMore: boolean;
  };
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

/**
 * Parse `page` and `limit` from query params with validation and defaults.
 */
export function parsePagination(query: Record<string, unknown>): PaginationParams {
  const rawPage = Number(query.page);
  const rawLimit = Number(query.limit);

  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const limit =
    Number.isFinite(rawLimit) && rawLimit >= 1
      ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
      : DEFAULT_LIMIT;

  return { page, limit, skip: (page - 1) * limit };
}

/**
 * Build a paginated response envelope from a result set and total count.
 */
export function paginatedResponse<T>(
  items: T[],
  total: number,
  page: number,
  limit: number,
): PaginatedResponse<T> {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return {
    data: items,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasMore: page < totalPages,
    },
  };
}
