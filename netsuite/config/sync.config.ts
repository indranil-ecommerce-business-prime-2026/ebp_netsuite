// ─────────────────────────────────────────────────────────────────────────────
// NETSUITE SYNC MODE SWITCH (per transaction type)
//
// "skip"   → Only CREATE new records. Skip if already synced.
// "update" → CREATE new + UPDATE existing records.
//
// HOW TO TOGGLE: Change the values below and restart the server.
// ─────────────────────────────────────────────────────────────────────────────

export const SYNC_MODE_SO:   "skip" | "update" = "update";   // SO needs update for status changes
export const SYNC_MODE_PO:   "skip" | "update" = "skip";     // PO: skip — prevents duplicate creation
export const SYNC_MODE_BILL: "skip" | "update" = "skip";     // Bill: skip — one-time creation

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
