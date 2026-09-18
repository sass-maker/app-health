import type { SparseDistinctSketch } from '@app-health/contracts';

const DEFAULT_PRECISION = 12;
const SPARSE_LIMIT = 256;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function registersFor(precision: number): Uint8Array {
  if (!Number.isInteger(precision) || precision < 10 || precision > 16)
    throw new Error('distinct sketch precision must be between 10 and 16');
  return new Uint8Array(2 ** precision);
}

function denseEncode(registers: Uint8Array): string {
  let binary = '';
  for (const register of registers) binary += String.fromCharCode(register);
  return btoa(binary);
}

function denseDecode(value: string, precision: number): Uint8Array {
  const binary = atob(value);
  const registers = registersFor(precision);
  if (binary.length !== registers.length) throw new Error('invalid dense distinct sketch');
  for (let index = 0; index < binary.length; index += 1)
    registers[index] = binary.charCodeAt(index);
  return registers;
}

function sparseDecode(value: string): Set<string> {
  if (!value) return new Set();
  const hashes = value.split(',');
  if (hashes.length > SPARSE_LIMIT || hashes.some((hash) => !HASH_PATTERN.test(hash)))
    throw new Error('invalid sparse distinct sketch');
  return new Set(hashes);
}

function applyHash(registers: Uint8Array, precision: number, hash: string): void {
  if (!HASH_PATTERN.test(hash)) throw new Error('distinct input must be a SHA-256 digest');
  const bits = BigInt(`0x${hash.slice(0, 16)}`);
  const index = Number(bits >> BigInt(64 - precision));
  const remainder = (bits << BigInt(precision)) & ((1n << 64n) - 1n);
  const remainingBits = 64 - precision;
  let rank = 1;
  for (let bit = 63; bit >= precision && (remainder & (1n << BigInt(bit))) === 0n; bit -= 1)
    rank += 1;
  registers[index] = Math.max(registers[index], Math.min(rank, remainingBits + 1));
}

function denseEstimate(registers: Uint8Array): number {
  const buckets = registers.length;
  const alpha =
    buckets === 16
      ? 0.673
      : buckets === 32
        ? 0.697
        : buckets === 64
          ? 0.709
          : 0.7213 / (1 + 1.079 / buckets);
  let denominator = 0;
  let empty = 0;
  for (const register of registers) {
    denominator += 2 ** -register;
    if (register === 0) empty += 1;
  }
  const raw = (alpha * buckets * buckets) / denominator;
  return empty > 0 && raw <= 2.5 * buckets ? buckets * Math.log(buckets / empty) : raw;
}

/** Exact while sparse; converts to a mergeable HyperLogLog register set as cardinality grows. */
export class DistinctSketchAccumulator {
  private sparse: Set<string> | null;
  private dense: Uint8Array | null;

  constructor(
    readonly precision = DEFAULT_PRECISION,
    initial?: SparseDistinctSketch,
  ) {
    registersFor(precision);
    if (initial && initial.precision !== precision)
      throw new Error('cannot merge distinct sketches with different precision');
    this.sparse = initial?.encoding === 'sparse' ? sparseDecode(initial.registers) : new Set();
    this.dense = initial?.encoding === 'dense' ? denseDecode(initial.registers, precision) : null;
  }

  addDigest(hash: string): this {
    if (!HASH_PATTERN.test(hash)) throw new Error('distinct input must be a SHA-256 digest');
    if (this.sparse) {
      this.sparse.add(hash);
      if (this.sparse.size <= SPARSE_LIMIT) return this;
      this.dense = registersFor(this.precision);
      for (const value of this.sparse) applyHash(this.dense, this.precision, value);
      this.sparse = null;
      return this;
    }
    applyHash(this.dense!, this.precision, hash);
    return this;
  }

  merge(sketch: SparseDistinctSketch): this {
    if (sketch.precision !== this.precision)
      throw new Error('cannot merge distinct sketches with different precision');
    if (sketch.encoding === 'sparse') {
      for (const hash of sparseDecode(sketch.registers)) this.addDigest(hash);
      return this;
    }
    const incoming = denseDecode(sketch.registers, this.precision);
    if (this.sparse) {
      const hashes = this.sparse;
      this.sparse = null;
      this.dense = registersFor(this.precision);
      for (const hash of hashes) applyHash(this.dense, this.precision, hash);
    }
    for (let index = 0; index < incoming.length; index += 1)
      this.dense![index] = Math.max(this.dense![index], incoming[index]);
    return this;
  }

  estimate(): number {
    return this.sparse ? this.sparse.size : Math.round(denseEstimate(this.dense!));
  }

  snapshot(): SparseDistinctSketch {
    return this.sparse
      ? {
          schema_version: 1,
          precision: this.precision,
          encoding: 'sparse',
          registers: [...this.sparse].sort().join(','),
        }
      : {
          schema_version: 1,
          precision: this.precision,
          encoding: 'dense',
          registers: denseEncode(this.dense!),
        };
  }
}
