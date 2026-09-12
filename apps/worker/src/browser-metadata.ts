import type { BrowserAttribution } from '@app-health/contracts';

/** Coarse categories only. The original user agent and IP never enter analytics storage. */
export function browserMetadata(request: Request, attribution?: BrowserAttribution) {
  const ua = request.headers.get('user-agent') ?? '';
  const device = !ua
    ? 'Unknown'
    : /ipad|tablet|android(?!.*mobile)/i.test(ua)
      ? 'Tablet'
      : /mobile|iphone|ipod/i.test(ua)
        ? 'Mobile'
        : 'Desktop';
  const browser = /edg\//i.test(ua)
    ? 'Edge'
    : /opr\//i.test(ua)
      ? 'Opera'
      : /firefox|fxios/i.test(ua)
        ? 'Firefox'
        : /chrome|crios/i.test(ua)
          ? 'Chrome'
          : /safari/i.test(ua)
            ? 'Safari'
            : 'Unknown';
  const cf = (request as Request & { cf?: { country?: unknown } }).cf;
  const country =
    typeof cf?.country === 'string' && /^[A-Z]{2}$/.test(cf.country) ? cf.country : 'Unknown';
  return { device, browser, country, channel: attributionChannel(attribution) };
}

function attributionChannel(attribution?: BrowserAttribution): string {
  const medium = attribution?.medium.toLowerCase() ?? '';
  const source = attribution?.source.toLowerCase() ?? '';
  if (/^(cpc|ppc|paid|paidsearch|paid-social|paid_social|display|cpm)$/.test(medium)) return 'Paid';
  if (/^(email|newsletter)$/.test(medium)) return 'Email';
  if (/^(social|social-network|social_media)$/.test(medium)) return 'Social';
  if (medium === 'organic') return 'Organic search';
  if (!source) return 'Direct / unknown';
  if (
    /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.yahoo\.com|baidu\.com)$/.test(source)
  )
    return 'Organic search';
  if (
    /(^|\.)(facebook\.com|instagram\.com|linkedin\.com|t\.co|x\.com|reddit\.com|pinterest\.com|tiktok\.com)$/.test(
      source,
    )
  )
    return 'Social';
  return 'Referral';
}
