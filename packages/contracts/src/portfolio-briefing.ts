import { z } from 'zod';
import { ReportDate } from './daily-engagement.js';

/**
 * Top-level traffic selection. Non-bot is the default browser report; Bots
 * reads the retained lightweight bot counters (pageviews by source, no browser
 * identity); All is their sum. Unrecognized automation remains in Non-bot.
 */
export const BriefingTraffic = z.enum(['non_bot', 'bots', 'all']);
export type BriefingTraffic = z.infer<typeof BriefingTraffic>;

export const PortfolioBriefingSourceV1 = z
  .object({
    name: z.string().min(1).max(100),
    pageviews: z.number().int().min(0),
    share: z.number().min(0).max(1),
  })
  .strict();

export const PortfolioBriefingProductV1 = z
  .object({
    app_id: z.string().min(1).max(100),
    catalog_id: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    pageviews: z.number().int().min(0).nullable(),
    top_sources: z.array(PortfolioBriefingSourceV1).max(5),
    sources_status: z.enum(['measured', 'unknown', 'not_applicable']),
    source_estimated: z.boolean(),
    previous_browser_visitors: z.number().int().min(0).nullable(),
    browser_change: z.number().int().nullable(),
    breakout: z.boolean(),
    comparison_reason: z.string().min(1).max(160),
  })
  .strict();

export const PortfolioBriefingV1 = z
  .object({
    date: ReportDate,
    timezone: z.literal('Asia/Kolkata'),
    traffic: BriefingTraffic,
    generated_at: z.number().int().min(0),
    products: z.array(PortfolioBriefingProductV1).max(55),
    sources: z.array(PortfolioBriefingSourceV1).max(10),
    comparison_note: z.string().min(1).max(300),
    filter_note: z.string().min(1).max(300),
  })
  .strict();

export type PortfolioBriefingV1 = z.infer<typeof PortfolioBriefingV1>;
