import { analyticsSourceChannel, type BrowserAttribution } from '@app-health/contracts';

/** Coarse categories only. The original user agent and IP never enter analytics storage. */
export function browserMetadata(request: Request, attribution?: BrowserAttribution) {
  const ua = request.headers.get('user-agent') ?? '';
  const device = classifyDevice(ua);
  const browser = classifyBrowser(ua);
  const cf = (request as Request & { cf?: { country?: unknown } }).cf;
  const country =
    typeof cf?.country === 'string' && /^[A-Z]{2}$/.test(cf.country) ? cf.country : 'Unknown';
  return {
    device,
    browser,
    country,
    channel: analyticsSourceChannel(attribution?.source ?? '', attribution?.medium ?? ''),
  };
}

function classifyDevice(ua: string): string {
  if (!ua) return 'Unknown';
  if (/ipad|tablet|android(?!.*mobile)/i.test(ua)) return 'Tablet';
  if (/mobile|iphone|ipod/i.test(ua)) return 'Mobile';
  return 'Desktop';
}

function classifyBrowser(ua: string): string {
  if (/edg\//i.test(ua)) return 'Edge';
  if (/opr\//i.test(ua)) return 'Opera';
  if (/firefox|fxios/i.test(ua)) return 'Firefox';
  if (/chrome|crios/i.test(ua)) return 'Chrome';
  if (/safari/i.test(ua)) return 'Safari';
  return 'Unknown';
}
