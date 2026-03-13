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

export const SYNC_MODE: "skip" | "update" = "update";

// ⚠️ TEST_MODE: When true, stops after the first real insert/update (skips don't count).
// Set to false for full production sync.
export const TEST_MODE = true;
