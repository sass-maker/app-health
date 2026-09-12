/** Leave room for the envelope beneath the collector's 256 KiB body limit. */
export function takeSizedBatch<T>(queue: T[], limit: number): T[] {
  let bytes = 1024;
  let count = 0;
  for (const item of queue) {
    const size = new TextEncoder().encode(JSON.stringify(item)).byteLength + 1;
    if (count >= limit || bytes + size > 256 * 1024) break;
    bytes += size;
    count++;
  }
  return queue.splice(0, count);
}
