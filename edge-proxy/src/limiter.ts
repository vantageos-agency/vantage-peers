import { type PoolKey, WINDOW_MS } from "./ip.js";

interface Bucket {
	count: number;
	resetAt: number;
}

export type Decision =
	| { allowed: true }
	| { allowed: false; retryAfterSeconds: number; pool: string };

/** Bound on live buckets per pool; the oldest is evicted past it. */
export const MAX_BUCKETS_PER_POOL = 200_000;

/**
 * Fixed-window counters, one map per pool. A request is admitted only when
 * EVERY pool it counts against has room, and it is counted in all of them only
 * then: a request that is refused costs its neighbours in the /24 or /48
 * nothing.
 */
export class RateLimiter {
	private readonly pools = new Map<string, Map<string, Bucket>>();

	constructor(
		private readonly now: () => number = Date.now,
		private readonly windowMs: number = WINDOW_MS,
		private readonly maxBuckets: number = MAX_BUCKETS_PER_POOL,
	) {}

	take(keys: PoolKey[]): Decision {
		const now = this.now();
		let worst: { retryAfterMs: number; pool: string } | null = null;
		for (const k of keys) {
			const b = this.pools.get(k.pool)?.get(k.key);
			if (b && b.resetAt > now && b.count >= k.limit) {
				const retryAfterMs = b.resetAt - now;
				if (!worst || retryAfterMs > worst.retryAfterMs)
					worst = { retryAfterMs, pool: k.pool };
			}
		}
		if (worst)
			return {
				allowed: false,
				retryAfterSeconds: Math.max(1, Math.ceil(worst.retryAfterMs / 1000)),
				pool: worst.pool,
			};
		for (const k of keys) this.count(k, now);
		return { allowed: true };
	}

	private count(k: PoolKey, now: number): void {
		let map = this.pools.get(k.pool);
		if (!map) {
			map = new Map();
			this.pools.set(k.pool, map);
		}
		const b = map.get(k.key);
		if (b && b.resetAt > now) {
			b.count += 1;
			return;
		}
		map.delete(k.key);
		if (map.size >= this.maxBuckets) {
			for (const [key, v] of map) if (v.resetAt <= now) map.delete(key);
			if (map.size >= this.maxBuckets) {
				const oldest = map.keys().next().value;
				if (oldest !== undefined) map.delete(oldest);
			}
		}
		map.set(k.key, { count: 1, resetAt: now + this.windowMs });
	}
}
