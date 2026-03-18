// ─────────────────────────────────────────────────────────────────────────────
// NETSUITE SYNC MODE SWITCH
//
// "skip"   → Only CREATE new sales orders in NetSuite. Skip if already exists.
//            Use this until client confirms update behaviour is safe.
//
// "update" → CREATE new + UPDATE existing sales orders in NetSuite.
//            Switch to this once client confirms.
//
// HOW TO TOGGLE: Change the value below and restart the server.
// ─────────────────────────────────────────────────────────────────────────────

export const SYNC_MODE: "skip" | "update" = "skip";

// ⚠️ TEST_MODE: When true, stops after the first real insert/update (skips don't count).
// Set to false for full production sync.
export const TEST_MODE = false;

// ─────────────────────────────────────────────────────────────────────────────
// STOP_ON_ERROR: Controls what happens when one order fails.
//
// true  → Stop the entire sync batch. Safe for debugging — prevents cascading issues.
// false → Log the error, mark the order as failed, continue with remaining orders.
//         Failed orders can be retried via GET /retry-failed-so
// ─────────────────────────────────────────────────────────────────────────────
export const STOP_ON_ERROR = false;

// MAX_RETRIES: How many times a failed order can be retried before being permanently skipped.
export const MAX_RETRIES = 3;
