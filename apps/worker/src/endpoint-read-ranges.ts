// Cover the interval with disjoint ranges. Daily/hourly interiors avoid reading
// every minute; minute edges keep the requested boundaries exact.
export function endpointReadRanges(from: number, to: number) {
  let ranges = [{ from, to, resolution: 60_000 }];
  for (const resolution of [86_400_000, 3_600_000]) {
    ranges = ranges.flatMap((range) => {
      if (range.resolution !== 60_000) return [range];
      const start = Math.ceil(range.from / resolution) * resolution;
      const end = Math.floor(range.to / resolution) * resolution;
      if (start >= end) return [range];
      return [
        ...(range.from < start ? [{ ...range, to: start }] : []),
        { from: start, to: end, resolution },
        ...(end < range.to ? [{ ...range, from: end }] : []),
      ];
    });
  }
  return ranges;
}
