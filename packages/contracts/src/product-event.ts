// One canonical envelope for explicit product facts. Endpoint telemetry never maps here.
import { z } from 'zod';
import { BrowserAttribution } from './browser.js';
import { currencyMinorUnits } from './currency-minor-units.js';

export const PRODUCT_EVENT_SCHEMA = 'app-health.product-event.v1' as const;
export const MAX_PRODUCT_EVENT_PROPERTIES = 30;
export const MAX_PRODUCT_EVENT_NAME_LENGTH = 64;
export const MAX_PRODUCT_EVENT_PATH_LENGTH = 256;
export const MAX_PRODUCT_EVENT_KEY_LENGTH = 64;
export const MAX_PRODUCT_EVENT_VALUE_LENGTH = 255;
export const MAX_PRODUCT_EVENT_IDENTITY_LENGTH = 128;
export const ProductEventName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[\u0020-\u007e\u0080-\uffff]+$/);
export const ProductPropertyKey = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\u0020-\u007e\u0080-\uffff]+$/)
  .refine((value) => !['__proto__', 'constructor', 'prototype'].includes(value));
const scalar = z.union([
  z.string().max(255),
  z.number().finite().min(-1e12).max(1e12),
  z.boolean(),
]);
const path = z
  .string()
  .startsWith('/')
  .max(256)
  .regex(/^[^?#\\\s@]*$/);
const identity = z
  .string()
  .regex(/^(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/i);
const currency = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .refine((value) => currencyMinorUnits[value] !== undefined);
const minorRevenue = z
  .object({ amount_minor: z.number().int().min(0).max(1e12), currency })
  .strict();
const legacyRevenue = z
  .object({ amount_cents: z.number().int().min(0).max(1e10), currency })
  .strict()
  .refine((value) => currencyMinorUnits[value.currency] === 2)
  .transform((value) => ({ amount_minor: value.amount_cents, currency: value.currency }));
export const ProductRevenue = z.union([minorRevenue, legacyRevenue]);
export const ProductEventV1 = z
  .object({
    schemaVersion: z.literal(PRODUCT_EVENT_SCHEMA),
    event_id: z.string().uuid(),
    occurred_at: z.number().int().nonnegative(),
    channel: z.enum(['browser', 'server', 'manual']),
    type: z.enum(['page_view', 'event', 'identify', 'revenue']),
    name: ProductEventName.optional(),
    path: path.optional(),
    visitor_id: identity.optional(),
    session_id: identity.optional(),
    properties: z
      .unknown()
      .refine(
        (value) =>
          value !== null && typeof value === 'object' && !Object.hasOwn(value, '__proto__'),
      )
      .pipe(z.record(ProductPropertyKey, scalar))
      .refine((value) => Object.keys(value).length <= 30)
      .optional(),
    value: z.number().finite().min(-1e12).max(1e12).optional(),
    revenue: ProductRevenue.optional(),
    interactive: z.boolean().optional(),
    attribution: BrowserAttribution.optional(),
  })
  .strict()
  .refine(
    (event) =>
      event.type === 'page_view'
        ? event.path !== undefined && event.name === undefined
        : event.type === 'revenue' || event.name !== undefined,
    { message: 'page_view requires a path and no name; named events require a name' },
  )
  .refine(
    (event) =>
      event.type === 'revenue' ? event.revenue !== undefined : event.revenue === undefined,
    { message: 'revenue belongs only to a revenue event' },
  );
export type ProductEventV1 = z.infer<typeof ProductEventV1>;
export const ProductBatchV1 = z
  .object({
    schema_version: z.literal(1),
    batch_id: z.string().uuid(),
    environment: z
      .string()
      .regex(/^[a-z0-9_-]{1,64}$/)
      .optional(),
    environment_id: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,100}$/)
      .optional(),
    events: z.array(ProductEventV1).min(1).max(100),
  })
  .strict();
export type ProductBatchV1 = z.infer<typeof ProductBatchV1>;
