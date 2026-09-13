let regions: Intl.DisplayNames | undefined;
/** Coarse country codes only; never interpret a city or arbitrary property as geography. */
export function countryName(code: string): string {
  if (!/^[A-Z]{2}$/.test(code) || code === 'XX' || code === 'T1') return 'Unknown';
  try {
    regions ??= new Intl.DisplayNames(['en'], { type: 'region' });
    return regions.of(code) ?? code;
  } catch {
    return code;
  }
}
