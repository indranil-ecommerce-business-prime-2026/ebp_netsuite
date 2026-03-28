import log from "./logger.config";

// ─────────────────────────────────────────────────────────────────────────────
// Shared concurrency semaphore for NetSuite API calls
//
// Account concurrency limit: 5
// Reserve 1 slot for UI / other integrations → usable slots: 4
//
// Both SO sync and PO sync acquire from this shared pool.
// If SO is using 3 slots, PO can only use 1 — and vice versa.
// Workers stay high (5 each) but actual HTTP concurrency is capped here.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_CONCURRENT = parseInt(process.env.NS_MAX_CONCURRENT || "4", 10);

let active = 0;
const queue: Array<() => void> = [];

function acquire(): Promise<void> {
    if (active < MAX_CONCURRENT) {
        active++;
        return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
        queue.push(() => { active++; resolve(); });
    });
}

function release(): void {
    active--;
    if (queue.length > 0) {
        const next = queue.shift()!;
        next();
    }
}

/**
 * Wraps a NetSuite API call with the shared concurrency limiter.
 * Usage: `const result = await withConcurrency(() => postToNetsuite(payload));`
 */
export async function withConcurrency<T>(fn: () => Promise<T>, label?: string): Promise<T> {
    const wasQueued = active >= MAX_CONCURRENT;
    const t0 = wasQueued ? Date.now() : 0;

    if (wasQueued) {
        log.warn(`[Concurrency] QUEUED — all ${MAX_CONCURRENT} slots busy, ${queue.length + 1} waiting — ${label || "unknown"}`);
    }

    await acquire();

    if (wasQueued) {
        const waited = Date.now() - t0;
        log.warn(`[Concurrency] RESUMED after ${waited}ms wait (${active}/${MAX_CONCURRENT}) — ${label || "unknown"}`);
    }

    try {
        return await fn();
    } finally {
        release();
    }
}

/** Current usage stats — useful for diagnostics */
export function getConcurrencyStats() {
    return { active, queued: queue.length, max: MAX_CONCURRENT };
}
