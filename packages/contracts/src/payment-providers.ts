import { z } from 'zod';
import { PaymentScopeV1, RevenueReportV1 } from './payments.js';

const id = z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/);
const secret = z
  .string()
  .min(8)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/);
export const PaymentProvider = z.enum(['stripe', 'polar', 'dodo']);
export type PaymentProvider = z.infer<typeof PaymentProvider>;
export const PaymentCredentials = z
  .object({
    api_key: secret,
    webhook_secrets: z.array(secret).min(1).max(4),
    signature_scheme: z.enum(['standard', 'polar_legacy']).default('standard'),
  })
  .strict();
export type PaymentCredentials = z.infer<typeof PaymentCredentials>;
export const PaymentConnectionInput = PaymentScopeV1.extend({
  provider: PaymentProvider,
  mode: z.enum(['live', 'test']),
  selector: id.optional(),
  credentials: PaymentCredentials.optional(),
  fixture: z.boolean().default(false),
}).strict();
export type PaymentConnectionInput = z.infer<typeof PaymentConnectionInput>;
export const PaymentRoutingRule = PaymentScopeV1.extend({ product_id: id }).strict();
export type PaymentRoutingRule = z.infer<typeof PaymentRoutingRule>;
export const PaymentRoutingInput = z
  .object({
    routing: z.enum(['exclusive', 'products']),
    rules: z.array(PaymentRoutingRule).max(100),
  })
  .strict()
  .refine((v) => new Set(v.rules.map((r) => r.product_id)).size === v.rules.length, {
    message: 'Each product must have one destination',
  });
export type PaymentRoutingInput = z.infer<typeof PaymentRoutingInput>;
export const PaymentConnection = PaymentScopeV1.extend({
  id: z.string().uuid(),
  provider: PaymentProvider,
  account_id: id,
  mode: z.enum(['live', 'test']),
  selector: id.nullable(),
  generation: z.number().int().positive(),
  status: z.enum(['active', 'disconnected']),
  routing: z.enum(['exclusive', 'products']),
  rules: z.array(PaymentRoutingRule).max(100),
  created_at: z.number().int().nonnegative(),
  verified_at: z.number().int().nonnegative(),
  webhook_at: z.number().int().nonnegative().nullable(),
  webhook_path: z.string().max(256),
  fixture: z.boolean(),
}).strict();
export type PaymentConnection = z.infer<typeof PaymentConnection>;
export const PaymentImportInput = z
  .object({
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
  })
  .strict()
  .refine((v) => v.to > v.from && v.to <= Date.now() + 60000, {
    message: 'Choose a nonempty historical interval',
  });
export type PaymentImportInput = z.infer<typeof PaymentImportInput>;
export const PaymentImportJob = z
  .object({
    id: z.string().uuid(),
    connection_id: z.string().uuid(),
    kind: z.enum(['import', 'webhook', 'reconcile']),
    status: z.enum(['queued', 'running', 'paused', 'finished', 'cancelled']),
    phase: z.enum(['payments', 'refunds', 'resource', 'done']),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    processed: z.number().int().nonnegative(),
    recorded: z.number().int().nonnegative(),
    unresolved: z.number().int().nonnegative(),
    filtered: z.number().int().nonnegative(),
    reason: z.string().max(100).nullable(),
    retry_at: z.number().int().nonnegative(),
    created_at: z.number().int().nonnegative(),
    updated_at: z.number().int().nonnegative(),
    coverage_note: z.string().max(1000),
  })
  .strict();
export type PaymentImportJob = z.infer<typeof PaymentImportJob>;
export const ProviderRevenueReportV1 = RevenueReportV1.omit({ basis: true })
  .extend({
    basis: z.literal('provider_object_created'),
    diagnostics_truncated: z.boolean().default(false),
    unresolved: z
      .array(
        z.object({ reason: z.string().max(100), count: z.number().int().nonnegative() }).strict(),
      )
      .max(50),
  })
  .strict();
export type ProviderRevenueReportV1 = z.infer<typeof ProviderRevenueReportV1>;
