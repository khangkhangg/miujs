// Latency statistics for load tests: a log-bucketed histogram (~1% precision) that merges across workers.

const MIN = 0.001; // ms
const GROWTH = Math.log(1.01);

export class Histogram {
  private buckets = new Map<number, number>();
  count = 0;
  sum = 0;
  max = 0;

  record(ms: number): void {
    const v = Math.max(ms, MIN);
    const idx = Math.ceil(Math.log(v / MIN) / GROWTH);
    this.buckets.set(idx, (this.buckets.get(idx) ?? 0) + 1);
    this.count++;
    this.sum += ms;
    if (ms > this.max) this.max = ms;
  }

  get mean(): number {
    return this.count ? this.sum / this.count : 0;
  }

  /** Value at percentile p (0..100): the upper bound of the bucket holding that rank. */
  percentile(p: number): number {
    if (!this.count) return 0;
    const rank = Math.ceil((p / 100) * this.count);
    let seen = 0;
    for (const idx of [...this.buckets.keys()].sort((a, b) => a - b)) {
      seen += this.buckets.get(idx)!;
      if (seen >= rank) return Math.min(MIN * Math.exp(idx * GROWTH), this.max);
    }
    return this.max;
  }

  merge(other: Histogram): void {
    for (const [idx, n] of other.buckets) this.buckets.set(idx, (this.buckets.get(idx) ?? 0) + n);
    this.count += other.count;
    this.sum += other.sum;
    this.max = Math.max(this.max, other.max);
  }

  toJSON() {
    return { buckets: [...this.buckets], count: this.count, sum: this.sum, max: this.max };
  }

  static fromJSON(j: ReturnType<Histogram["toJSON"]>): Histogram {
    const h = new Histogram();
    h.buckets = new Map(j.buckets);
    h.count = j.count;
    h.sum = j.sum;
    h.max = j.max;
    return h;
  }
}

export function pickWeighted<T>(items: T[], weight: (x: T) => number, random = Math.random): T {
  const total = items.reduce((s, x) => s + weight(x), 0);
  let r = random() * total;
  for (const x of items) {
    r -= weight(x);
    if (r < 0) return x;
  }
  return items[items.length - 1]!;
}
