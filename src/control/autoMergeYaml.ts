/** Control-layer parse/serialize helpers for repos.yaml auto_merge. */
import { z } from 'zod';
import {
  resolveAutoMergePolicy,
  type AutoMergePolicy,
} from '../domain/autoMerge.js';

const boolish = z.union([z.boolean(), z.string()]).optional().transform((v, ctx) => {
  if (v === undefined) return undefined;
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid boolean' });
    return z.NEVER;
  }
  const t = v.trim().toLowerCase();
  if (t === 'true' || t === 'yes' || t === '1') return true;
  if (t === 'false' || t === 'no' || t === '0') return false;
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid boolean' });
  return z.NEVER;
});

export function serializeAutoMerge(p: AutoMergePolicy): Record<string, unknown> {
  return {
    enabled: p.enabled,
    dwell_minutes: p.dwellMinutes,
    max_size: p.maxSize,
  };
}

/** Zod schema for optional auto_merge block (snake_case on disk). */
export const autoMergeSchema = z
  .object({
    enabled: boolish,
    dwell_minutes: z.number().int().min(0).max(1440).optional(),
    max_size: z.enum(['S', 'M', 'L']).optional(),
  })
  .strict()
  .optional()
  .nullable()
  .transform((raw, ctx): AutoMergePolicy | null => {
    if (raw === undefined || raw === null) return null;
    try {
      return resolveAutoMergePolicy({
        enabled: raw.enabled,
        ...(raw.dwell_minutes !== undefined ? { dwellMinutes: raw.dwell_minutes } : {}),
        ...(raw.max_size !== undefined ? { maxSize: raw.max_size } : {}),
      });
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: (err as Error).message,
      });
      return z.NEVER;
    }
  });
