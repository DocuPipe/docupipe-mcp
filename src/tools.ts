import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ApiError, BudgetExhausted, Deadline, DocuPipeClient, UncertainOutcome } from "./client.js";
import { buildInputDocument, capResponse, documentSource, downloadTo, fitInline, writeJson } from "./files.js";
import { JOBS_WAIT_HEADROOM_MS, LIST_SCHEMAS_DEFAULT_LIMIT, LIST_SCHEMAS_MAX_LIMIT, MIN_REQUEST_MS, TOOL_BUDGET_MS } from "./constants.js";

type Args = Record<string, unknown>;
type NextCall = { tool: string; arguments: Args };

interface Progress {
  stage: string;
  ids: Record<string, string | string[]>;
  next?: NextCall;
  inFlight?: string;
}

class StillProcessing extends Error {}

class JobFailed extends Error {}

// a finished lookup whose answer is a failure (a job in error); returned with isError and the full payload
class ToolFailure extends Error {
  constructor(public readonly payload: Args) {
    super("tool failure");
  }
}

const COSTS = "Credits: upload 1/page for PDF, image, Word and HTML (CSV, Excel, JSON, text and XML upload free); extraction 2/page at standard effort, "
  + "4/page at high effort, 3/page with citations (always standard effort). Without a schema, drafting one costs 1 credit per page on at most the "
  + "first 5 pages. Creating a schema from json_schema is free.";

const effortLevel = z.enum(["standard", "high"]).optional()
  .describe("Extraction effort. 'standard' (default) is right for most documents; use 'high' only after standard missed or misread values.");
const citations = z.boolean().optional()
  .describe("Cite every value to its place on the page (bounding box and confidence). Runs at standard effort, 3 credits/page.");
const saveTo = z.string().optional().describe("Optional path to write the extracted JSON to, relative to the working directory.");

function clean(args: Args): Args {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

class ToolRunner {
  constructor(private readonly client: DocuPipeClient) {}

  private async respond(toolName: string, payload: Args, isError: boolean): Promise<CallToolResult> {
    const capped = await capResponse(payload, `${toolName}-${Date.now()}`);
    return { content: [{ type: "text", text: this.client.redact(JSON.stringify(capped)) }], isError };
  }

  private processingPayload(progress: Progress): Args {
    // a resume call recorded before an unanswered post would repeat that post, so it is withheld
    const next = progress.inFlight ? undefined : progress.next;
    const payload: Args = {
      status: "processing",
      stage: progress.stage,
      ids: progress.ids,
      message: next
        ? "DocuPipe is still working. Call the tool in `next` to pick up where this left off; it never uploads or extracts a second time."
        : "DocuPipe is still working on the ids listed. Check them with get_job or wait_for_jobs.",
    };
    if (next) payload.next = next;
    if (progress.inFlight) {
      payload.warning = `The request ${progress.inFlight} was still in flight when time ran out, so it may or may not have been accepted and charged. `
        + "Do not repeat it until you have checked the account (list_schemas, get_job on the ids above, or the DocuPipe dashboard).";
    }
    return payload;
  }

  private errorPayload(error: unknown, progress: Progress): Args {
    const payload: Args = { status: "failed", stage: progress.stage, ids: progress.ids };
    if (error instanceof UncertainOutcome || (progress.inFlight && !(error instanceof ApiError))) {
      payload.status = "unknown_outcome";
      payload.error = error instanceof Error ? error.message : String(error);
      payload.warning = `DocuPipe may or may not have accepted ${progress.inFlight ?? "the last request"} and charged for it. Do not repeat it until `
        + "you have checked: the ids above, get_job, or the DocuPipe dashboard.";
      return payload;
    }
    if (error instanceof ApiError) {
      if (error.status === 401 || error.status === 403) {
        payload.error = `DocuPipe rejected the API key (${error.status}). Check DOCUPIPE_API_KEY; the key is on https://www.docupipe.ai/dashboard/settings/general.`;
      } else if (error.status === 402) {
        payload.error = `Not enough credits: ${error.detail}`;
      } else if (error.status === 404) {
        payload.error = `Not found: ${error.detail}. The id may be wrong, belong to another workspace, or not be finished yet (check the job with get_job).`;
      } else {
        payload.error = `DocuPipe API error ${error.status}: ${error.detail}`;
      }
    } else {
      payload.error = error instanceof Error ? error.message : String(error);
    }
    return payload;
  }

  async run(toolName: string, retryCall: NextCall | undefined, handler: (progress: Progress, deadline: Deadline) => Promise<Args>): Promise<CallToolResult> {
    const progress: Progress = { stage: "starting", ids: {}, next: retryCall };
    const deadline = new Deadline(TOOL_BUDGET_MS);
    try {
      return await this.respond(toolName, await handler(progress, deadline), false);
    } catch (error) {
      if (error instanceof ToolFailure) return this.respond(toolName, error.payload, true);
      if (error instanceof StillProcessing || error instanceof BudgetExhausted) return this.respond(toolName, this.processingPayload(progress), false);
      return this.respond(toolName, this.errorPayload(error, progress), true);
    }
  }
}

async function post<T extends Args>(client: DocuPipeClient, progress: Progress, path: string, body: unknown, deadline: Deadline, requiredIds: string[]): Promise<T> {
  if (!deadline.hasTimeFor(MIN_REQUEST_MS)) throw new BudgetExhausted();
  progress.inFlight = `POST ${path}`;
  const result = await client.post<T>(path, body, deadline);
  const missing = requiredIds.filter((key) => typeof result[key] !== "string" || !result[key]);
  if (missing.length > 0) throw new UncertainOutcome(`DocuPipe accepted POST ${path} but its answer lacks ${missing.join(", ")}.`);
  progress.inFlight = undefined;
  return result;
}

async function waitOrResume(client: DocuPipeClient, progress: Progress, jobIds: string[], deadline: Deadline, next: NextCall): Promise<void> {
  progress.next = next;
  const result = await client.waitForJobs(jobIds, deadline);
  const failed = result.jobs.filter((job) => job.status === "error" || (result.finished && job.status !== "completed"));
  if (failed.length > 0) {
    throw new JobFailed(failed.map((job) => `job ${job.jobId} (${job.jobType ?? "unknown type"}) ended in ${job.status}: ${job.errorMessage ?? "no error message"}`).join("; "));
  }
  if (!result.finished) throw new StillProcessing();
}

async function uploadDocument(client: DocuPipeClient, progress: Progress, args: Args, deadline: Deadline, extra: Args = {}): Promise<Args> {
  progress.stage = "uploading";
  const document = await buildInputDocument(args.file_path as string | undefined, args.url as string | undefined, deadline);
  const body = clean({ document, dataset: args.dataset, metadata: args.metadata, ...extra });
  const upload = await post<Args>(client, progress, "/document", body, deadline, ["documentId", "jobId"]);
  progress.ids.document_id = upload.documentId as string;
  progress.ids.upload_job_id = upload.jobId as string;
  return upload;
}

async function waitForDocument(client: DocuPipeClient, progress: Progress, documentId: string, uploadJobId: string | undefined, deadline: Deadline, next: NextCall): Promise<void> {
  progress.stage = "parsing";
  if (uploadJobId) {
    await waitOrResume(client, progress, [uploadJobId], deadline, next);
    return;
  }
  progress.next = next;
  const readDocument = async (): Promise<Args> => {
    try {
      return await client.get<Args>(`/document/${encodeURIComponent(documentId)}`, deadline);
    } catch (error) {
      if (error instanceof ApiError && error.status >= 500) {
        throw new Error(`Could not read the status of document ${documentId}. If it is still being uploaded, pass its upload_job_id so the tool can wait on it.`);
      }
      throw error;
    }
  };
  const polled = await client.pollUntil(
    readDocument,
    (doc) => doc.status !== "processing",
    deadline);
  if (!polled.finished) throw new StillProcessing();
  if (polled.value.status === "error") throw new JobFailed(`document ${documentId} failed to process`);
}

async function fetchStandardization(client: DocuPipeClient, standardizationId: string, args: Args, deadline: Deadline): Promise<Args> {
  const std = await client.get<Args>(`/standardization/${encodeURIComponent(standardizationId)}`, deadline);
  const payload: Args = clean({
    status: "completed",
    standardizationId: std.standardizationId,
    documentId: std.documentId,
    schemaId: std.schemaId,
    schemaName: std.schemaName,
    data: std.data,
    fieldMetadata: args.include_field_metadata ? std.fieldMetadata : undefined,
    transformedData: std.transformedData,
  });
  if (args.save_to) {
    const saved = await writeJson(args.save_to as string, std.data, deadline);
    payload.savedTo = saved.path;
  }
  const withData = await fitInline(payload, "data", `standardization-${standardizationId}`);
  return fitInline(withData, "fieldMetadata", `field-metadata-${standardizationId}`);
}

async function startStandardization(client: DocuPipeClient, progress: Progress, args: Args, documentId: string, schemaId: string | undefined, deadline: Deadline): Promise<{ standardizationId: string; jobId: string }> {
  progress.stage = "extracting";
  const started = await post<Args>(client, progress, "/v3/standardize", clean({
    documentId,
    schemaId,
    guidelines: args.guidelines,
    effortLevel: args.citations ? "standard" : args.effort_level,
    citations: args.citations,
  }), deadline, ["standardizationId", "jobId"]);
  const standardizationId = started.standardizationId as string;
  const jobId = started.jobId as string;
  progress.ids.standardization_id = standardizationId;
  progress.ids.standardization_job_id = jobId;
  if (started.schemaId) progress.ids.schema_id = started.schemaId as string;
  progress.next = {
    tool: "extract",
    arguments: clean({ standardization_id: standardizationId, standardization_job_id: jobId, save_to: args.save_to, include_field_metadata: args.include_field_metadata }),
  };
  return { standardizationId, jobId };
}

async function finishStandardization(client: DocuPipeClient, progress: Progress, standardizationId: string, jobId: string, args: Args, deadline: Deadline): Promise<Args> {
  progress.stage = "extracting";
  progress.ids.standardization_id = standardizationId;
  progress.ids.standardization_job_id = jobId;
  const next: NextCall = {
    tool: "extract",
    arguments: clean({ standardization_id: standardizationId, standardization_job_id: jobId, save_to: args.save_to, include_field_metadata: args.include_field_metadata }),
  };
  await waitOrResume(client, progress, [jobId], deadline, next);
  progress.stage = "fetching_result";
  const result = await fetchStandardization(client, standardizationId, args, deadline);
  return { ...result, ids: progress.ids };
}

function recordConversionIds(progress: Progress, response: Args): void {
  const fields: Record<string, string> = { documentId: "document_id", schemaId: "schema_id", standardizationId: "standardization_id", jobId: "standardization_job_id" };
  for (const [field, key] of Object.entries(fields)) {
    if (typeof response[field] === "string" && response[field]) progress.ids[key] = response[field] as string;
  }
}

async function pollConversion(client: DocuPipeClient, progress: Progress, conversionId: string, saveToPath: string | undefined, deadline: Deadline): Promise<Args> {
  progress.next = { tool: "get_excel_conversion", arguments: clean({ conversion_id: conversionId, save_to: saveToPath }) };
  const polled = await client.pollUntil(
    async () => {
      const response = await client.get<Args>(`/v3/convert/excel/${encodeURIComponent(conversionId)}`, deadline);
      recordConversionIds(progress, response);
      return response;
    },
    (conversion) => conversion.status === "completed" || conversion.status === "failed",
    deadline);
  const conversion = polled.value;
  if (!polled.finished) {
    progress.stage = String(conversion.status ?? "converting");
    throw new StillProcessing();
  }
  if (conversion.status === "failed") throw new JobFailed(`conversion ${conversionId} failed: ${conversion.errorMessage ?? "no error message"}`);
  const payload: Args = clean({
    status: "completed",
    conversionId,
    ids: progress.ids,
    excelUrl: conversion.excelUrl,
    excelUrlExpiresAt: conversion.excelUrlExpiresAt,
    preview: conversion.preview,
    warnings: conversion.warnings,
  });
  if (saveToPath && conversion.excelUrl) {
    progress.stage = "saving_workbook";
    const saved = await downloadTo(conversion.excelUrl as string, saveToPath, deadline);
    payload.savedTo = saved.path;
  }
  return fitInline(payload, "preview", `conversion-${conversionId}`);
}

export function registerTools(server: McpServer, client: DocuPipeClient): void {
  const runner = new ToolRunner(client);

  server.registerTool("extract", {
    title: "Extract data from a document",
    description: "One call from a file to structured JSON: uploads a local file or URL (or reuses a document_id), runs a DocuPipe extraction, waits and "
      + "returns the extracted data. Pass schema_id to reuse a saved schema, json_schema to define the fields inline, or neither to let DocuPipe draft a "
      + "schema from the document (its schemaId comes back so later calls give the same fields). If it returns status 'processing', call the tool in "
      + `'next' to resume; it never uploads or extracts twice. ${COSTS}`,
    inputSchema: {
      file_path: z.string().optional().describe("Local file to upload, relative to the working directory."),
      url: z.string().optional().describe("Public URL of the file to upload, instead of file_path."),
      document_id: z.string().optional().describe("An already uploaded document, instead of uploading again."),
      upload_job_id: z.string().optional().describe("The upload job of document_id, when resuming."),
      schema_id: z.string().optional().describe("Saved schema to extract with (list_schemas)."),
      json_schema: z.record(z.string(), z.unknown()).optional()
        .describe("Inline JSON Schema (type object, properties with a description each). Saved as a new schema first, free."),
      schema_name: z.string().optional().describe("Name for the schema created from json_schema."),
      guidelines: z.string().optional().describe("Plain-language extraction instructions. Without a schema they also steer the drafted schema."),
      effort_level: effortLevel,
      citations,
      standardization_id: z.string().optional().describe("Resume: an extraction already started. Requires standardization_job_id."),
      standardization_job_id: z.string().optional().describe("Resume: the job of standardization_id."),
      save_to: saveTo,
      include_field_metadata: z.boolean().optional().describe("Also return per-field page numbers and, with citations, boxes and confidence."),
    },
    annotations: { openWorldHint: true },
  }, async (args) => runner.run("extract", undefined, async (progress, deadline) => {
    if (args.standardization_id || args.standardization_job_id) {
      if (!args.standardization_id || !args.standardization_job_id) {
        throw new Error("To resume an extraction pass both standardization_id and standardization_job_id. Don't start a new extraction for the same "
          + "document; get_standardization fetches a finished result by its id alone.");
      }
      return finishStandardization(client, progress, args.standardization_id, args.standardization_job_id, args, deadline);
    }

    let documentId = args.document_id;
    let uploadJobId = args.upload_job_id;
    if (!documentId) {
      const upload = await uploadDocument(client, progress, args, deadline);
      documentId = upload.documentId as string;
      uploadJobId = upload.jobId as string;
    }
    progress.ids.document_id = documentId;
    if (uploadJobId) progress.ids.upload_job_id = uploadJobId;
    const options = clean({ guidelines: args.guidelines, effort_level: args.effort_level, citations: args.citations, save_to: args.save_to,
      include_field_metadata: args.include_field_metadata });
    progress.next = { tool: "extract", arguments: clean({ document_id: documentId, upload_job_id: uploadJobId, schema_id: args.schema_id,
      json_schema: args.schema_id ? undefined : args.json_schema, schema_name: args.schema_name, ...options }) };

    let schemaId = args.schema_id;
    if (!schemaId && args.json_schema) {
      progress.stage = "creating_schema";
      const created = await post<Args>(client, progress, "/schema", clean({
        schemaName: args.schema_name ?? `Schema for ${documentId}`,
        jsonSchema: args.json_schema,
        guidelines: args.guidelines,
      }), deadline, ["schemaId"]);
      schemaId = created.schemaId as string;
    }
    if (schemaId) progress.ids.schema_id = schemaId;

    const resumeArgs = clean({ document_id: documentId, upload_job_id: uploadJobId, schema_id: schemaId, ...options });
    progress.next = { tool: "extract", arguments: resumeArgs };
    await waitForDocument(client, progress, documentId, uploadJobId, deadline, { tool: "extract", arguments: resumeArgs });

    const started = await startStandardization(client, progress, args, documentId, schemaId, deadline);
    return finishStandardization(client, progress, started.standardizationId, started.jobId, args, deadline);
  }));

  server.registerTool("upload_document", {
    title: "Upload a document",
    description: "Upload a local file or URL to DocuPipe and wait for it to be read (OCR and parsing). Returns the document_id used by every other tool. "
      + "Credits: 1/page for PDF, image, Word and HTML; CSV, Excel, JSON, text and XML upload free.",
    inputSchema: {
      file_path: z.string().optional().describe("Local file, relative to the working directory."),
      url: z.string().optional().describe("Public URL of the file, instead of file_path."),
      dataset: z.string().optional().describe("Optional dataset name to group documents."),
      metadata: z.record(z.string(), z.unknown()).optional().describe("Optional metadata stored with the document."),
      wait: z.boolean().optional().describe("Wait for parsing to finish (default true)."),
    },
    annotations: { openWorldHint: true },
  }, async (args) => runner.run("upload_document", undefined, async (progress, deadline) => {
    documentSource(args.file_path, args.url);
    const upload = await uploadDocument(client, progress, args, deadline);
    if (args.wait !== false) {
      await waitOrResume(client, progress, [upload.jobId as string], deadline, { tool: "wait_for_jobs", arguments: { job_ids: [upload.jobId] } });
    }
    return { status: args.wait === false ? upload.status : "completed", documentId: upload.documentId, jobId: upload.jobId };
  }));

  server.registerTool("get_document", {
    title: "Get a document and its parsed text",
    description: "Fetch a document's processing status, page count and parsed text (tables as markdown). Set include_layout for per-page "
      + "sections with bounding boxes. Free.",
    inputSchema: {
      document_id: z.string(),
      include_layout: z.boolean().optional().describe("Return the full per-page layout (sections, tables, boxes) instead of plain text."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args) => runner.run("get_document", { tool: "get_document", arguments: args }, async (progress, deadline) => {
    progress.ids.document_id = args.document_id;
    const doc = await client.get<Args>(`/document/${encodeURIComponent(args.document_id)}`, deadline);
    const result = (doc.result as Args | null | undefined) ?? undefined;
    const payload = clean({
      documentId: doc.documentId,
      status: doc.status,
      filename: doc.filename,
      fileType: doc.fileType,
      numPages: doc.numPages,
      language: doc.language,
      dataset: doc.dataset,
      metadata: doc.metadata,
      classIds: doc.classIds,
      parentDocumentId: doc.parentDocumentId,
      text: args.include_layout ? undefined : result?.text,
      layout: args.include_layout ? result?.pages : undefined,
      transformedData: doc.transformedData,
    });
    return fitInline(payload, args.include_layout ? "layout" : "text", `document-${args.document_id}`);
  }));

  server.registerTool("standardize", {
    title: "Extract data from an uploaded document",
    description: "Run an extraction (standardization) on one uploaded, fully processed document and wait for the result. Use extract instead when "
      + `starting from a file. ${COSTS}`,
    inputSchema: {
      document_id: z.string(),
      schema_id: z.string().optional().describe("Saved schema; omit to have DocuPipe draft one from the document."),
      guidelines: z.string().optional(),
      effort_level: effortLevel,
      citations,
      wait: z.boolean().optional().describe("Wait for the result (default true)."),
      save_to: saveTo,
    },
    annotations: { openWorldHint: true },
  }, async (args) => runner.run("standardize", undefined, async (progress, deadline) => {
    progress.ids.document_id = args.document_id;
    const started = await startStandardization(client, progress, args, args.document_id, args.schema_id, deadline);
    if (args.wait === false) return { status: "processing", ids: progress.ids, next: progress.next };
    return finishStandardization(client, progress, started.standardizationId, started.jobId, args, deadline);
  }));

  server.registerTool("get_standardization", {
    title: "Get an extraction result",
    description: "Fetch the extracted JSON of a finished standardization. While the extraction is still running this answers not found; wait on its "
      + "job first. Free.",
    inputSchema: {
      standardization_id: z.string(),
      save_to: saveTo,
      include_field_metadata: z.boolean().optional().describe("Also return per-field page numbers and, with citations, boxes and confidence."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args) => runner.run("get_standardization", { tool: "get_standardization", arguments: args }, async (progress, deadline) => {
    progress.ids.standardization_id = args.standardization_id;
    return fetchStandardization(client, args.standardization_id, args, deadline);
  }));

  server.registerTool("create_schema", {
    title: "Create a schema",
    description: "Save a JSON Schema as a DocuPipe schema so every extraction returns the same fields. Free. Use type object with a description on "
      + "each property; arrays of objects for line items.",
    inputSchema: {
      schema_name: z.string(),
      json_schema: z.record(z.string(), z.unknown()),
      guidelines: z.string().optional().describe("Plain-language instructions applied whenever this schema is used."),
    },
    annotations: { openWorldHint: true },
  }, async (args) => runner.run("create_schema", undefined, async (progress, deadline) => {
    progress.stage = "creating_schema";
    const created = await post<Args>(client, progress, "/schema", clean({
      schemaName: args.schema_name,
      jsonSchema: args.json_schema,
      guidelines: args.guidelines,
    }), deadline, ["schemaId"]);
    return { schemaId: created.schemaId, schemaName: args.schema_name };
  }));

  server.registerTool("list_schemas", {
    title: "List schemas",
    description: "List the account's saved schemas (id and name), newest first, to reuse one instead of creating a new one. Free.",
    inputSchema: {
      limit: z.number().int().min(1).max(LIST_SCHEMAS_MAX_LIMIT).optional(),
      offset: z.number().int().min(0).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args) => runner.run("list_schemas", { tool: "list_schemas", arguments: args }, async (_progress, deadline) => {
    const schemas = await client.get<Args[]>("/schemas", deadline, {
      limit: args.limit ?? LIST_SCHEMAS_DEFAULT_LIMIT,
      offset: args.offset ?? 0,
      exclude_payload: true,
    });
    return { schemas: schemas.map((schema) => clean({ schemaId: schema.schemaId, schemaName: schema.schemaName, timestamp: schema.timestamp })) };
  }));

  server.registerTool("list_classes", {
    title: "List classes",
    description: "List the account's classification classes (id, name, description). classify needs class ids from here. Free.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async () => runner.run("list_classes", { tool: "list_classes", arguments: {} }, async (_progress, deadline) => {
    const classes = await client.get<Args[]>("/classes", deadline);
    return { classes: classes.map((item) => clean({ classId: item.classId, className: item.className, description: item.description })) };
  }));

  server.registerTool("classify", {
    title: "Classify a document",
    description: "Classify one uploaded document into the account's classes and wait for the answer. "
      + "Credits: 0.1/page, rounded up per document (at least 1).",
    inputSchema: {
      document_id: z.string(),
      class_ids: z.array(z.string()).optional().describe("Candidate classes (list_classes). Omit to use all classes."),
      multi_class: z.boolean().optional().describe("Allow more than one class per document."),
      include_unknown: z.boolean().optional().describe("Allow 'unknown' when nothing fits (single-class mode)."),
      instructions: z.string().optional(),
    },
    annotations: { openWorldHint: true },
  }, async (args) => runner.run("classify", undefined, async (progress, deadline) => {
    progress.stage = "classifying";
    progress.ids.document_id = args.document_id;
    const started = await post<Args>(client, progress, "/classify/batch", clean({
      documentIds: [args.document_id],
      classIds: args.class_ids,
      multiClass: args.multi_class,
      includeUnknown: args.include_unknown,
      instructions: args.instructions,
    }), deadline, ["jobId"]);
    const batchJobId = started.jobId as string;
    const classifyJobId = ((started.classificationJobIds as string[] | undefined) ?? [])[0] ?? batchJobId;
    progress.ids.batch_job_id = batchJobId;
    progress.ids.classification_job_id = classifyJobId;
    const jobIds = Array.from(new Set([batchJobId, classifyJobId]));
    try {
      await waitOrResume(client, progress, jobIds, deadline, { tool: "wait_for_jobs", arguments: { job_ids: jobIds } });
    } catch (error) {
      if (!(error instanceof JobFailed) || classifyJobId === batchJobId) throw error;
      const child = await client.get<Args>(`/job/${encodeURIComponent(classifyJobId)}`, deadline).catch(() => undefined);
      throw new JobFailed(child?.errorMessage ? `${error.message}; classification: ${child.errorMessage}` : error.message);
    }
    const job = await client.get<Args>(`/job/${encodeURIComponent(classifyJobId)}`, deadline);
    return clean({ status: "completed", documentId: args.document_id, jobId: classifyJobId, batchJobId, assignedClassIds: job.assignedClassIds,
      assignedClassNames: job.assignedClassNames });
  }));

  server.registerTool("split_document", {
    title: "Split a document",
    description: "Split one uploaded document into sub-documents, with AI deciding where each one starts, and wait for the new document ids. "
      + "Credits: 0.2/page, rounded up.",
    inputSchema: {
      document_id: z.string(),
      instructions: z.string().optional().describe("How to split, e.g. 'one document per invoice'. Can also skip parts you don't need."),
      dataset: z.string().optional().describe("Dataset for the new documents."),
    },
    annotations: { openWorldHint: true },
  }, async (args) => runner.run("split_document", undefined, async (progress, deadline) => {
    progress.stage = "splitting";
    progress.ids.document_id = args.document_id;
    const started = await post<Args>(client, progress, "/document/split", clean({
      documentId: args.document_id,
      instructions: args.instructions,
      dataset: args.dataset,
    }), deadline, ["jobId"]);
    const jobId = started.jobId as string;
    progress.ids.split_job_id = jobId;
    await waitOrResume(client, progress, [jobId], deadline, { tool: "get_job", arguments: { job_id: jobId } });
    const job = await client.get<Args>(`/job/${encodeURIComponent(jobId)}`, deadline);
    return clean({ status: "completed", jobId, numNewDocuments: job.numNewDocuments, newDocumentIds: job.newDocumentIds, details: job.details });
  }));

  server.registerTool("list_workflows", {
    title: "List workflows",
    description: "List workflows that run_workflow can start on one document: classic workflows and Architect workflows that are runnable and take a "
      + "single document. Free.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async () => runner.run("list_workflows", { tool: "list_workflows", arguments: {} }, async (_progress, deadline) => {
    const classic = await client.get<Args[]>("/workflows", deadline);
    const architect = await client.get<Args[]>("/v2/workflows", deadline);
    const classicIds = new Set(classic.map((wf) => wf.workflowId));
    const runnable = architect.filter((wf) => {
      const inputs = (wf.inputs as Args[] | undefined) ?? [];
      return wf.runnable === true && inputs.length === 1 && inputs[0].inputType === "single" && !classicIds.has(wf.workflowId);
    });
    return {
      workflows: [
        ...classic.map((wf) => clean({ workflowId: wf.workflowId, workflowName: wf.workflowName, kind: "classic" })),
        ...runnable.map((wf) => clean({ workflowId: wf.workflowId, workflowName: wf.workflowName, kind: "architect", steps: wf.steps })),
      ],
    };
  }));

  server.registerTool("run_workflow", {
    title: "Run a workflow on a document",
    description: "Upload a local file or URL with a workflow attached and, for Architect workflows, wait for the run's outputs. Classic workflows return "
      + "the ids of the jobs they started (use wait_for_jobs, then get_standardization). Credits: the upload plus each step the workflow runs. "
      + "Resume an Architect run with workflow_run_job_id.",
    inputSchema: {
      workflow_id: z.string().optional().describe("Workflow to run (list_workflows)."),
      file_path: z.string().optional(),
      url: z.string().optional(),
      dataset: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
      workflow_run_job_id: z.string().optional().describe("Resume: the run job returned earlier."),
    },
    annotations: { openWorldHint: true },
  }, async (args) => runner.run("run_workflow", undefined, async (progress, deadline) => {
    let runJobId = args.workflow_run_job_id;
    if (!runJobId) {
      if (!args.workflow_id) throw new Error("Pass workflow_id (and file_path or url), or workflow_run_job_id to resume.");
      const upload = await uploadDocument(client, progress, args, deadline, { workflowId: args.workflow_id });
      runJobId = upload.workflowV2RunJobId as string | undefined;
      if (!runJobId) {
        return clean({ status: "started", kind: "classic", documentId: upload.documentId, uploadJobId: upload.jobId,
          workflowResponse: upload.workflowResponse });
      }
    }
    progress.stage = "running_workflow";
    progress.ids.workflow_run_job_id = runJobId;
    await waitOrResume(client, progress, [runJobId], deadline, { tool: "run_workflow", arguments: { workflow_run_job_id: runJobId } });
    const job = await client.get<Args>(`/job/${encodeURIComponent(runJobId)}`, deadline);
    const payload = clean({ status: "completed", kind: "architect", jobId: runJobId, workflowId: job.workflowId,
      inputDocumentIds: job.inputDocumentIds, outputs: job.outputs, ids: progress.ids });
    return fitInline(payload, "outputs", `workflow-run-${runJobId}`);
  }));

  server.registerTool("convert_to_excel", {
    title: "Convert a document to Excel",
    description: "Turn a document into an .xlsx workbook without a schema (one sheet per table). Takes a local file, URL or document_id, waits for "
      + "the workbook and can save it locally. Credits: upload, plus 2/page for the conversion. Resume with the call in 'next'.",
    inputSchema: {
      file_path: z.string().optional(),
      url: z.string().optional(),
      document_id: z.string().optional(),
      upload_job_id: z.string().optional().describe("The upload job of document_id, when resuming."),
      instructions: z.string().optional().describe("What the spreadsheet should contain, e.g. which tables or columns to keep."),
      schema_id: z.string().optional().describe("A schemaId from an earlier conversion, to lay out similar files the same way."),
      save_to: z.string().optional().describe("Optional local path for the .xlsx file."),
    },
    annotations: { openWorldHint: true },
  }, async (args) => runner.run("convert_to_excel", undefined, async (progress, deadline) => {
    let documentId = args.document_id;
    let uploadJobId = args.upload_job_id;
    if (!documentId) {
      const upload = await uploadDocument(client, progress, args, deadline);
      documentId = upload.documentId as string;
      uploadJobId = upload.jobId as string;
    }
    progress.ids.document_id = documentId;
    await waitForDocument(client, progress, documentId, uploadJobId, deadline, {
      tool: "convert_to_excel",
      arguments: clean({ document_id: documentId, upload_job_id: uploadJobId, instructions: args.instructions, schema_id: args.schema_id, save_to: args.save_to }),
    });
    progress.stage = "converting";
    const started = await post<Args>(client, progress, "/v3/convert/excel", clean({
      documentId,
      instructions: args.instructions,
      schemaId: args.schema_id,
    }), deadline, ["conversionId"]);
    const conversionId = started.conversionId as string;
    progress.ids.conversion_id = conversionId;
    recordConversionIds(progress, started);
    return pollConversion(client, progress, conversionId, args.save_to, deadline);
  }));

  server.registerTool("get_excel_conversion", {
    title: "Get an Excel conversion",
    description: "Check an Excel conversion, wait for it to finish, and optionally save the .xlsx locally. The download link is fresh on every call. Free.",
    inputSchema: {
      conversion_id: z.string(),
      save_to: z.string().optional().describe("Optional local path for the .xlsx file."),
    },
    annotations: { openWorldHint: true },
  }, async (args) => runner.run("get_excel_conversion", undefined, async (progress, deadline) => {
    progress.stage = "converting";
    progress.ids.conversion_id = args.conversion_id;
    return pollConversion(client, progress, args.conversion_id, args.save_to, deadline);
  }));

  server.registerTool("get_job", {
    title: "Get a job",
    description: "Fetch one job's status, type, error message and results (for split, classify and workflow jobs). A job in error is returned as a "
      + "tool error. Free.",
    inputSchema: { job_id: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args) => runner.run("get_job", { tool: "get_job", arguments: args }, async (progress, deadline) => {
    progress.ids.job_id = args.job_id;
    const job = await client.get<Args>(`/job/${encodeURIComponent(args.job_id)}`, deadline);
    if (job.status === "error") throw new ToolFailure({ status: "failed", error: job.errorMessage ?? "the job ended in error", job });
    return job;
  }));

  server.registerTool("wait_for_jobs", {
    title: "Wait for jobs",
    description: "Wait until the listed jobs finish (any job type) and report each one's status. Returns early when all are done or one fails; call "
      + "again if some are still processing. An id that stays 'unknown' may be wrong or belong to another account (check it with get_job). Free.",
    inputSchema: {
      job_ids: z.array(z.string()).min(1),
      max_wait_seconds: z.number().int().min(1).max(Math.floor((TOOL_BUDGET_MS - JOBS_WAIT_HEADROOM_MS) / 1000)).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args) => runner.run("wait_for_jobs", { tool: "wait_for_jobs", arguments: args }, async (progress, deadline) => {
    progress.ids.job_ids = args.job_ids;
    const waitBudget = args.max_wait_seconds ? new Deadline(args.max_wait_seconds * 1000 + JOBS_WAIT_HEADROOM_MS + MIN_REQUEST_MS) : deadline;
    const result = await client.waitForJobs(args.job_ids, waitBudget);
    const payload = { allComplete: result.finished, anyError: result.anyError, jobs: result.jobs };
    if (result.jobs.some((job) => job.status === "error")) throw new ToolFailure({ status: "failed", ...payload });
    return payload;
  }));
}
