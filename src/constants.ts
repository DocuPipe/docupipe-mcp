export const SERVER_NAME = "docupipe";
export const SERVER_VERSION = "0.1.0";
export const USER_AGENT = `docupipe-mcp/${SERVER_VERSION}`;

export const DEFAULT_BASE_URL = "https://app.docupipe.ai";
export const API_KEY_ENV = "DOCUPIPE_API_KEY";
export const BASE_URL_ENV = "DOCUPIPE_BASE_URL";

// codex's default mcp tool timeout is 60 s, so every tool call finishes well inside it
export const TOOL_BUDGET_MS = 45_000;
export const MIN_REQUEST_MS = 3_000;
export const JOBS_WAIT_MAX_SECONDS = 25;
export const JOBS_WAIT_HEADROOM_MS = 5_000;
export const POLL_INTERVAL_MS = 3_000;
export const READ_RETRIES = 2;
export const READ_RETRY_DELAY_MS = 1_000;

export const MAX_INLINE_FILE_MB = 100;
export const MAX_DOWNLOAD_MB = 200;
export const MIN_DOWNLOAD_MS = 2_000;
export const INLINE_RESULT_MAX_CHARS = 40_000;
export const PREVIEW_CHARS = 2_000;
export const RESULTS_DIR = "docupipe-results";
// up to three spills per reply stay inside codex's 60 s tool timeout on top of the 45 s budget
export const SPILL_WRITE_TIMEOUT_MS = 2_000;
export const ESSENTIAL_RESPONSE_FIELDS = ["status", "stage", "error", "warning", "message", "next", "ids", "savedTo", "spilledFiles"];
export const LIST_SCHEMAS_DEFAULT_LIMIT = 100;
export const LIST_SCHEMAS_MAX_LIMIT = 1000;
