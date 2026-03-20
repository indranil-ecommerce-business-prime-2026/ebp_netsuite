import winston from "winston";
import path from "path";
import fs from "fs";
import cron from "node-cron";
import { execSync } from "child_process";

// ── Paths ────────────────────────────────────────────────────────────────────
const LOG_DIR     = path.resolve("logs");
const ARCHIVE_DIR = path.join(LOG_DIR, "archive");
const LOG_FILE    = path.join(LOG_DIR, "app.log");
const MAX_SIZE_MB = 25;
const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;

// Ensure directories exist
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

// ── PST timestamp ────────────────────────────────────────────────────────────
function getPSTTimestamp(): string {
    return new Date().toLocaleString("en-US", {
        timeZone: "America/Los_Angeles",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    });
}

// ── Extract module tag from message: "[SO-SYNC] blah" → module="SO-SYNC" ───
// Enables filtering:  jq 'select(.module=="CRON")'
//                     grep '"module":"SO-SYNC"' logs/app.log
const extractModule = winston.format((info) => {
    info.timestamp = getPSTTimestamp();
    const msg = String(info.message || "");
    const match = msg.match(/^\[([^\]]+)\]\s*/);
    if (match) {
        info.module = match[1];
        info.message = msg.slice(match[0].length);
    } else {
        info.module = "APP";
    }
    return info;
});

// ── Console format — human-readable ──────────────────────────────────────────
// Output: 03/21/2026, 14:30:05 [INFO ] [SO-SYNC] Found 200 orders
const consoleFormat = winston.format.printf(({ timestamp, level, module, message, ...meta }) => {
    const metaStr = Object.keys(meta).length > 0 ? " " + JSON.stringify(meta) : "";
    return `${timestamp} [${level.toUpperCase().padEnd(5)}] [${module}] ${message}${metaStr}`;
});

// ── File format — JSON per line (filterable with jq / grep) ──────────────────
// Output: {"t":"03/21/2026, 14:30:05","l":"info","m":"SO-SYNC","msg":"Found 200 orders","sent":150}
//
// Filter examples:
//   grep '"m":"CRON"' logs/app.log
//   cat logs/app.log | jq 'select(.l=="error")'
//   cat logs/app.log | jq 'select(.m=="SO-SYNC" and .l=="error")'
//   cat logs/app.log | jq 'select(.msg | test("PO.*failed"))'
const fileFormat = winston.format.printf(({ timestamp, level, module, message, ...meta }) => {
    const entry: Record<string, any> = {
        t: timestamp,
        l: level,
        m: module,
        msg: message,
    };
    // Flatten meta into entry (avoids nested "meta" wrapper)
    for (const [k, v] of Object.entries(meta)) {
        entry[k] = v;
    }
    return JSON.stringify(entry);
});

// ── Winston logger ──────────────────────────────────────────────────────────
const logger = winston.createLogger({
    level: "debug",
    transports: [
        // Console — colorized, human-readable
        new winston.transports.Console({
            format: winston.format.combine(
                extractModule(),
                winston.format.colorize({ level: true }),
                consoleFormat
            ),
        }),
        // File — JSON per line, filterable
        new winston.transports.File({
            filename: LOG_FILE,
            format: winston.format.combine(
                extractModule(),
                fileFormat
            ),
            maxsize: MAX_SIZE_BYTES,
            maxFiles: 1,
            tailable: true,
        }),
    ],
});

// ── Log rotation: check every 10 minutes, zip + archive if >= 25MB ──────────
function rotateLogIfNeeded() {
    try {
        if (!fs.existsSync(LOG_FILE)) return;

        const stats = fs.statSync(LOG_FILE);
        if (stats.size < MAX_SIZE_BYTES) return;

        const now = new Date();
        const tag = now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" })
            .replace(/[\/,: ]+/g, "-")
            .replace(/-+/g, "-");
        const archiveName = `app-${tag}.log.gz`;
        const archivePath = path.join(ARCHIVE_DIR, archiveName);

        // gzip the current log into archive
        execSync(`gzip -c "${LOG_FILE}" > "${archivePath}"`);

        // Truncate current log file (not delete — keeps file handle open)
        fs.writeFileSync(LOG_FILE, "");

        logger.info(`[LOG-ROTATE] Rotated → ${archiveName} (${(stats.size / 1024 / 1024).toFixed(1)}MB)`);
    } catch (err: any) {
        // Use console.error here since logger itself may be the problem
        console.error("[LOG-ROTATE] Error:", err.message);
    }
}

// Run rotation check every 10 minutes
cron.schedule("*/10 * * * *", rotateLogIfNeeded);

// Also run on startup
rotateLogIfNeeded();

export default logger;
