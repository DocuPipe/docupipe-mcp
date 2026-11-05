# DocuPipe MCP server

Use [DocuPipe](https://www.docupipe.ai) from Claude Code, Codex, Cursor and other MCP clients. Ask your agent to "pull the line items out of these invoices" and it uploads the files, extracts the fields you named and saves the JSON, in one tool call per file.

## Setup

1. [Sign up](https://www.docupipe.ai/auth/signup) and copy your API key from the Developers card on the [Settings page](https://www.docupipe.ai/dashboard/settings/general).
2. Add the server to your client, replacing `your-api-key`. Node.js 18 or newer is required.

**Claude Code**

```bash
claude mcp add docupipe --scope user -e DOCUPIPE_API_KEY=your-api-key -- npx -y @docupipe/mcp
```

**Codex**

```bash
codex mcp add docupipe --env DOCUPIPE_API_KEY=your-api-key -- npx -y @docupipe/mcp
```

**Cursor**: open this link to install, then replace `your-api-key` in Cursor's MCP settings:

```
cursor://anysphere.cursor-deeplink/mcp/install?name=docupipe&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBkb2N1cGlwZS9tY3AiXSwiZW52Ijp7IkRPQ1VQSVBFX0FQSV9LRVkiOiJ5b3VyLWFwaS1rZXkifX0=
```

Or add it by hand. Cursor and other clients that use an `mcp.json` file:

```json
{
  "mcpServers": {
    "docupipe": {
      "command": "npx",
      "args": ["-y", "@docupipe/mcp"],
      "env": { "DOCUPIPE_API_KEY": "your-api-key" }
    }
  }
}
```

Then ask, for example:

> Use DocuPipe to extract the invoice number, date, vendor and line items from every PDF in ./invoices and save one JSON file per invoice.

## Tools

| Tool | What it does |
|---|---|
| `extract` | File or URL in, structured JSON out: uploads, extracts with a saved schema, an inline JSON Schema or a schema DocuPipe drafts, waits, and can save the result |
| `upload_document` | Upload a local file or URL and wait for it to be read |
| `get_document` | Status, page count and parsed text of a document |
| `standardize` | Extract from an already uploaded document |
| `get_standardization` | Fetch an extraction result |
| `create_schema`, `list_schemas` | Save a JSON Schema, or reuse one the account already has |
| `list_classes`, `classify` | Classify a document into the account's classes |
| `split_document` | Split a file into sub-documents, with AI choosing where each one starts |
| `list_workflows`, `run_workflow` | Run a saved workflow on a file |
| `convert_to_excel`, `get_excel_conversion` | Turn a document into an `.xlsx` workbook without a schema, and save it locally |
| `get_job`, `wait_for_jobs` | Check or wait on any job |

Each call returns within about 45 seconds. When DocuPipe needs longer, the tool returns `status: "processing"` with every id created so far and the exact call to resume with. Resuming never uploads or extracts a second time.

## Credits

Tools use credits from your DocuPipe account. Upload is 1 credit per page for PDF, image, Word and HTML files (CSV, Excel, JSON, text and XML are free to upload). Extraction is 2 credits per page at standard effort and 4 at high effort. See [credits and billing](https://docs.docupipe.ai/docs/understanding-credits-and-billing) for every operation.

## Configuration

| Variable | |
|---|---|
| `DOCUPIPE_API_KEY` | Required. Your API key. |
| `DOCUPIPE_BASE_URL` | Optional. Overrides the API address. Defaults to `https://app.docupipe.ai`. |

Relative file paths resolve against the directory the server was started in, which for most clients is your project folder. Local files up to 100 MB are supported; pass a URL for larger files. Results larger than about 40,000 characters are written to `docupipe-results/` in that folder and the tool returns the path with a preview.

## Links

- [API documentation](https://docs.docupipe.ai)
- [Using DocuPipe from coding agents without this server](https://docs.docupipe.ai/reference/using-llms-with-these-docs)

## License

MIT
