// Canonical product-analytics event envelope (app-health.product-event.v1).
// One versioned shape for browser, server, and manual events: collectors map
// channel-specific payloads onto this contract before storage, so downstream
// projections never branch on transport. Scope (project + environment) is
// stamped from the credential, never trusted from the payload. No headers,
// cookies, request bodies, credentials, or unbounded free-form text are
// accepted anywhere in this envelope.

import { z } from 'zod';

export const PRODUCT_EVENT_SCHEMA = 'app-health.product-event.v1' as const;
export const MAX_PRODUCT_EVENT_PROPERTIES = 20;
export const MAX_PRODUCT_EVENT_NAME_LENGTH = 64;
export const MAX_PRODUCT_EVENT_PATH_LENGTH = 256;
export const MAX_PRODUCT_EVENT_KEY_LENGTH = 40;
export const MAX_PRODUCT_EVENT_VALUE_LENGTH = 200;
export const MAX_PRODUCT_EVENT_IDENTITY_LENGTH = 128;

const eventId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, 'uuid v4');

const eventName = z
  .string()
  .trim()
  .min(1)
  .max(MAX_PRODUCT_EVENT_NAME_LENGTH)
  .regex(/^[a-z][a-z0-9_.:-]*$/, 'lowercase dotted event name');

const path = z
  .string()
  .trim()
  .min(1)
  .max(MAX_PRODUCT_EVENT_PATH_LENGTH)
  .refine((v) => v.startsWith('/'), 'path must start with /')
  .refine((v) => !/[?#\\\s@]/.test(v), 'path carries no query, fragment, or credentials');

// Bounded flat properties: product facts only, never payloads. Depth stays 1 —
// nested objects are rejected rather than flattened so nothing sensitive can
// hide inside a container.
const properties = z
  .record(
    z
      .string()
      .trim()
      .min(1)
      .max(MAX_PRODUCT_EVENT_KEY_LENGTH)
      .regex(/^[a-z][a-z0-9_]*$/),
    z.union([
      z.string().trim().max(MAX_PRODUCT_EVENT_VALUE_LENGTH),
      z.number().finite(),
      z.boolean(),
    ]),
  )
  .refine((value) => Object.keys(value).length <= MAX_PRODUCT_EVENT_PROPERTIES, {
    message: `at most ${MAX_PRODUCT_EVENT_PROPERTIES} properties`,
  });

const revenue = z
  .object({
    amount_cents: z.number().int().min(0).max(10_000_000_000),
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .length(3)
      .regex(/^[A-Z]{3}$/, 'ISO 4217 currency'),
  })
  .strict();

// Anonymous product identity only. Collector-derived stable visitor/session
// hashes are bounded opaque strings; account identity is resolved server-side.
const identity = z
  .string()
  .trim()
  .min(1)
  .max(MAX_PRODUCT_EVENT_IDENTITY_LENGTH)
  .regex(/^[a-zA-Z0-9_-]+$/);

export const ProductEventV1 = z
  .object({
    schemaVersion: z.literal(PRODUCT_EVENT_SCHEMA),
    event_id: eventId,
    occurred_at: z.number().int().min(0),
    channel: z.enum(['browser', 'server', 'manual']),
    type: z.enum(['page_view', 'event', 'identify', 'revenue']),
    name: eventName.optional(),
    path: path.optional(),
    visitor_id: identity.optional(),
    session_id: identity.optional(),
    properties: properties.optional(),
    revenue: revenue.optional(),
  })
  .strict()
  .refine(
    (event) =>
      event.type === 'page_view'
        ? event.path !== undefined && event.name === undefined
        : event.type === 'event' || event.type === 'identify'
          ? event.name !== undefined
          : true,
    {
      message: 'page_view requires path and no name; event and identify require a name',
    },
  )
  .refine((event) => event.type !== 'revenue' || event.revenue !== undefined, {
    message: 'revenue events require a bounded revenue amount',
  })
  .refine((event) => event.type === 'revenue' || event.revenue === undefined, {
    message: 'revenue facts are only accepted on revenue events',
  });

export type ProductEventV1 = z.infer<typeof ProductEventV1>;
