import {
  API_KEY_ENV,
  BASE_URL_ENV,
  DEFAULT_BASE_URL,
  JOBS_WAIT_HEADROOM_MS,
  JOBS_WAIT_MAX_SECONDS,
  MIN_REQUEST_MS,
  POLL_INTERVAL_MS,
  READ_RETRIES,
  READ_RETRY_DELAY_MS,
  TOOL_BUDGET_MS,
  USER_AGENT,
} from "./constants.js";

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly detail: string) {
    super(`DocuPipe API error ${status}: ${detail}`);
  }
}

export class BudgetExhausted extends Error {
  constructor() {
    super("time budget for this tool call ran out");
  }
}

// a post whose response never arrived: the server may or may not have accepted (and charged) it
export class UncertainOutcome extends Error {}

export class Deadline {
  private readonly endsAt: number;

  constructor(budgetMs: number = TOOL_BUDGET_MS) {
    this.endsAt = Date.now() + budgetMs;
  }

  remainingMs(): number {
    return Math.max(0, this.endsAt - Date.now());
  }

  hasTimeFor(ms: number): boolean {
    return this.remainingMs() >= ms;
  }
}

export interface JobStatus {
  jobId: string;
  status: string;
  jobType?: string | null;
  errorMessage?: string | null;
}

export interface WaitResult {
  finished: boolean;
  anyError: boolean;
  jobs: JobStatus[];
}

type Method = "GET" | "POST";
type Query = Record<string, string | number | boolean | undefined>;

const UNSAFE_KEY_CHARACTERS = /[^\x21-\x7e]/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    return typeof detail === "string" ? detail : JSON.stringify(detail);
  }
  return fallback;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

export class DocuPipeClient {
  readonly baseUrl: string;
  private readonly apiKey: string;

  constructor() {
    const apiKey = process.env[API_KEY_ENV]?.trim();
    if (!apiKey) {
      throw new Error(`${API_KEY_ENV} is not set. Copy your API key from https://www.docupipe.ai/dashboard/settings/general and pass it as ${API_KEY_ENV}.`);
    }
    if (UNSAFE_KEY_CHARACTERS.test(apiKey)) {
      throw new Error(`${API_KEY_ENV} contains spaces, line breaks or other characters an API key never has. Copy it again from Settings.`);
    }
    this.apiKey = apiKey;
    this.baseUrl = (process.env[BASE_URL_ENV]?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  redact(text: string): string {
    return text.split(this.apiKey).join("[redacted]");
  }

  async request<T>(method: Method, path: string, deadline: Deadline, body?: unknown, query?: Query, safeToRepeat = method === "GET"): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    // reads are safe to retry; paid posts are never replayed after an uncertain outcome
    const attempts = safeToRepeat ? READ_RETRIES + 1 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (!deadline.hasTimeFor(MIN_REQUEST_MS)) throw new BudgetExhausted();
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          redirect: "manual",
          headers: {
            "X-API-Key": this.apiKey,
            "User-Agent": USER_AGENT,
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(deadline.remainingMs()),
        });
      } catch (error) {
        if (!safeToRepeat) {
          if (isTimeout(error)) throw new BudgetExhausted();
          throw new UncertainOutcome(`The connection to ${this.baseUrl} failed before DocuPipe answered ${method} ${path}.`);
        }
        if (isTimeout(error)) throw new BudgetExhausted();
        lastError = error;
        if (attempt < attempts - 1) await sleep(READ_RETRY_DELAY_MS);
        continue;
      }

      if (response.status >= 300 && response.status < 400) {
        throw new ApiError(response.status, `The API at ${this.baseUrl} answered with a redirect. It is not followed, so the API key is only ever sent to that address. Check ${BASE_URL_ENV}.`);
      }
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        if (isTimeout(error)) throw new BudgetExhausted();
        if (!safeToRepeat) throw new UncertainOutcome(`The response to ${method} ${path} was cut off.`);
        lastError = error;
        if (attempt < attempts - 1) await sleep(READ_RETRY_DELAY_MS);
        continue;
      }
      let parsed: unknown = undefined;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      if (!safeToRepeat && response.status >= 500) {
        throw new UncertainOutcome(`DocuPipe answered ${method} ${path} with HTTP ${response.status}, which does not say whether the request was carried out.`);
      }
      if (!safeToRepeat && response.ok && (parsed === undefined || typeof parsed !== "object")) {
        throw new UncertainOutcome(`DocuPipe accepted ${method} ${path} but its answer could not be read.`);
      }
      if (!response.ok) {
        const error = new ApiError(response.status, describeError(parsed, text.slice(0, 500) || response.statusText));
        if (safeToRepeat && response.status >= 500 && attempt < attempts - 1) {
          lastError = error;
          await sleep(READ_RETRY_DELAY_MS);
          continue;
        }
        throw error;
      }
      return parsed as T;
    }
    if (lastError instanceof ApiError) throw lastError;
    throw new Error(`Could not reach the DocuPipe API at ${this.baseUrl}.`);
  }

  get<T>(path: string, deadline: Deadline, query?: Query): Promise<T> {
    return this.request<T>("GET", path, deadline, undefined, query);
  }

  post<T>(path: string, body: unknown, deadline: Deadline, safeToRepeat = false): Promise<T> {
    return this.request<T>("POST", path, deadline, body, undefined, safeToRepeat);
  }

  async waitForJobs(jobIds: string[], deadline: Deadline): Promise<WaitResult> {
    let jobs: JobStatus[] = jobIds.map((jobId) => ({ jobId, status: "unknown" }));
    while (deadline.hasTimeFor(JOBS_WAIT_HEADROOM_MS + MIN_REQUEST_MS)) {
      const maxWaitSeconds = Math.max(1, Math.min(JOBS_WAIT_MAX_SECONDS, Math.floor((deadline.remainingMs() - JOBS_WAIT_HEADROOM_MS) / 1000)));
      const result = await this.post<{ allComplete: boolean; anyError: boolean; jobs: JobStatus[] }>("/jobs/wait", { jobIds, maxWaitSeconds }, deadline, true);
      jobs = result.jobs.map((job) => ({ ...job, status: job.status ?? "unknown" }));
      const anyError = result.anyError || jobs.some((job) => job.status === "error");
      if (result.allComplete || anyError) {
        return { finished: result.allComplete, anyError: anyError || jobs.some((job) => job.status !== "completed"), jobs };
      }
    }
    return { finished: false, anyError: false, jobs };
  }

  async pollUntil<T>(fetchOnce: () => Promise<T>, isDone: (value: T) => boolean, deadline: Deadline): Promise<{ finished: boolean; value: T }> {
    let value = await fetchOnce();
    while (!isDone(value)) {
      if (!deadline.hasTimeFor(POLL_INTERVAL_MS + MIN_REQUEST_MS)) return { finished: false, value };
      await sleep(POLL_INTERVAL_MS);
      value = await fetchOnce();
    }
    return { finished: true, value };
  }
}
