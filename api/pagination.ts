import { z } from "zod";

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export const paginationInput = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type PaginationInput = z.infer<typeof paginationInput>;

export function paginationParams(
  input: Partial<PaginationInput> | null | undefined,
  defaultPageSize = DEFAULT_PAGE_SIZE,
) {
  const requestedPage = input?.page ?? 1;
  const pageSize = input?.pageSize ?? defaultPageSize;
  return { requestedPage, pageSize };
}

export function resolvePagination(total: number, requestedPage: number, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  return { page, pageSize, total, totalPages, offset: (page - 1) * pageSize };
}

export function paginatedResult<T>(items: T[], total: number, requestedPage: number, pageSize: number) {
  const { page, totalPages } = resolvePagination(total, requestedPage, pageSize);
  return { items, page, pageSize, total, totalPages };
}
