import { createHash } from "node:crypto"

import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { WorkerMessageHandler } from "pdfjs-dist/legacy/build/pdf.worker.mjs"

import type { DocumentUploadLimits } from "../../lib/document-upload-policy"
import {
  DocumentIngestionError,
  type DocumentIngestionHandler,
  type DocumentIngestionJob,
} from "./document-ingestion-consumer"

const DOCUMENTS_BUCKET = "documents"

type DocumentSourceRow = Readonly<{
  id: string
  storage_object_key: string
  mime_type: string
  sha256: string
  ingestion_version: number
}>

type ParsedParagraph = Readonly<{
  paragraphIndex: number
  kind: "heading" | "paragraph"
  content: string
  pageNumber: number | null
  headingLevel: number | null
  headingPath: readonly string[]
  source: SourceLocation
}>

type SourceLocation = Readonly<{
  start: number
  end: number
  locator: string
}>

type ParsedDocument = Readonly<{
  pageCount: number | null
  paragraphs: readonly ParsedParagraph[]
}>

type DocumentParsingHandlerOptions = Readonly<{
  supabaseUrl: string
  secretKey: string
  limits: DocumentUploadLimits
}>

export function createDocumentParsingHandler(
  options: DocumentParsingHandlerOptions,
): DocumentIngestionHandler {
  const client = createClient(options.supabaseUrl, options.secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  return async (job, context) => {
    assertNotAborted(context.signal)
    const mayParse = await beginParsing(client, job.documentId, context.claimId)
    if (!mayParse) return

    const document = await readDocumentSource(client, job)
    const bytes = await downloadDocument(client, document.storage_object_key)
    assertNotAborted(context.signal)
    assertContentMatches(bytes, job.contentSha256)

    const parsed = await parseDocument(
      document,
      bytes,
      options.limits,
      context.signal,
    )
    assertNotAborted(context.signal)
    await replaceParagraphs(client, job, context.claimId, parsed)
  }
}

async function beginParsing(
  client: SupabaseClient,
  documentId: string,
  claimId: string,
): Promise<boolean> {
  const { data, error } = await client.rpc("begin_document_parsing", {
    target_document_id: documentId,
    target_claim_id: claimId,
  })
  if (error) throw ingestionDataUnavailableError()
  if (typeof data !== "boolean") throw ingestionDataUnavailableError()
  return data
}

async function readDocumentSource(
  client: SupabaseClient,
  job: DocumentIngestionJob,
): Promise<DocumentSourceRow> {
  const { data, error } = await client
    .from("documents")
    .select("id,storage_object_key,mime_type,sha256,ingestion_version")
    .eq("id", job.documentId)
    .single()
  if (error || !data) throw ingestionDataUnavailableError()

  const row = data as DocumentSourceRow
  if (
    row.ingestion_version !== job.ingestionVersion ||
    row.sha256.toLowerCase() !== job.contentSha256
  ) {
    throw new DocumentIngestionError(
      "DOCUMENT_VERSION_MISMATCH",
      "Document 内容版本与摄取任务不一致。",
      false,
    )
  }
  return row
}

async function downloadDocument(
  client: SupabaseClient,
  objectKey: string,
): Promise<Uint8Array> {
  const { data, error } = await client.storage
    .from(DOCUMENTS_BUCKET)
    .download(objectKey)
  if (error || !data) throw storageReadError()
  return new Uint8Array(await data.arrayBuffer())
}

function assertContentMatches(bytes: Uint8Array, expectedSha256: string): void {
  const actualSha256 = createHash("sha256").update(bytes).digest("hex")
  if (actualSha256 !== expectedSha256) {
    throw new DocumentIngestionError(
      "DOCUMENT_CONTENT_MISMATCH",
      "Document 原始内容与已登记版本不一致。",
      false,
    )
  }
}

async function parseDocument(
  document: DocumentSourceRow,
  bytes: Uint8Array,
  limits: DocumentUploadLimits,
  signal: AbortSignal,
): Promise<ParsedDocument> {
  switch (document.mime_type) {
    case "text/plain":
      return parsePlainText(decodeUtf8(bytes), limits.maxParsedCharacters)
    case "text/markdown":
      return parseMarkdown(decodeUtf8(bytes), limits.maxParsedCharacters)
    case "application/pdf":
      return parsePdf(bytes, limits, signal)
    default:
      throw new DocumentIngestionError(
        "INVALID_FILE_TYPE",
        "Document 类型不受解析器支持。",
        false,
      )
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new DocumentIngestionError(
      "INVALID_TEXT_ENCODING",
      "文本文件必须使用 UTF-8 编码。",
      false,
    )
  }
}

function parsePlainText(
  source: string,
  maxParsedCharacters: number,
): ParsedDocument {
  assertTextCanBeParsed(source, maxParsedCharacters)
  const spans = splitParagraphSpans(source)
  if (spans.length === 0) throw emptyContentError()

  return {
    pageCount: null,
    paragraphs: spans.map((span, paragraphIndex) =>
      createTextParagraph({
        paragraphIndex,
        content: normalizeLineEndings(source.slice(span.start, span.end)),
        headingPath: [],
        pageNumber: null,
        source: characterLocation(span),
      }),
    ),
  }
}

function parseMarkdown(
  source: string,
  maxParsedCharacters: number,
): ParsedDocument {
  assertTextCanBeParsed(source, maxParsedCharacters)
  const paragraphs: ParsedParagraph[] = []
  const headings: Array<Readonly<{ level: number; title: string }>> = []
  const lines = source.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)
  let pendingStart: number | null = null
  let pendingEnd = 0
  let fence: Readonly<{ marker: "`" | "~"; length: number }> | null = null

  const flushParagraph = () => {
    if (pendingStart === null) return
    const span = trimSpan(source, pendingStart, pendingEnd)
    pendingStart = null
    if (span === null) return
    paragraphs.push(
      createTextParagraph({
        paragraphIndex: paragraphs.length,
        content: normalizeLineEndings(source.slice(span.start, span.end)),
        headingPath: headings.map(({ title }) => title),
        pageNumber: null,
        source: characterLocation(span),
      }),
    )
  }

  const appendHeading = (
    level: number,
    content: string,
    contentStart: number,
  ) => {
    while ((headings.at(-1)?.level ?? 0) >= level) {
      headings.pop()
    }
    headings.push({ level, title: content })
    const source = characterLocation({
      start: contentStart,
      end: contentStart + content.length,
    })
    paragraphs.push(
      createHeadingParagraph({
        paragraphIndex: paragraphs.length,
        content,
        level,
        headingPath: headings.map(({ title }) => title),
        source,
      }),
    )
  }

  for (const match of lines) {
    const rawLine = match[0]
    if (rawLine === "") continue
    const lineStart = match.index
    const line = rawLine.replace(/(?:\r\n|\r|\n)$/, "")
    const lineEnd = lineStart + line.length

    if (fence !== null) {
      pendingStart ??= lineStart
      pendingEnd = lineEnd
      if (isClosingFence(line, fence)) {
        fence = null
        flushParagraph()
      }
      continue
    }

    const openingFence = readOpeningFence(line)
    if (openingFence !== null) {
      flushParagraph()
      fence = openingFence
      pendingStart = lineStart
      pendingEnd = lineEnd
      continue
    }

    const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(line)
    if (setext && pendingStart !== null) {
      const span = trimSpan(source, pendingStart, pendingEnd)
      if (span && !/[\r\n]/.test(source.slice(span.start, span.end))) {
        pendingStart = null
        appendHeading(
          setext[1].startsWith("=") ? 1 : 2,
          source.slice(span.start, span.end),
          span.start,
        )
        continue
      }
    }

    const heading = /^( {0,3})(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line)
    if (heading) {
      flushParagraph()
      const level = heading[2].length
      const headingContent = heading[3].trimEnd()
      const contentStart = lineStart + line.indexOf(heading[3])
      appendHeading(level, headingContent, contentStart)
      continue
    }

    if (!line.trim()) {
      flushParagraph()
      continue
    }
    pendingStart ??= lineStart
    pendingEnd = lineEnd
  }
  flushParagraph()
  if (paragraphs.length === 0) throw emptyContentError()
  return { pageCount: null, paragraphs }
}

async function parsePdf(
  bytes: Uint8Array,
  limits: DocumentUploadLimits,
  signal: AbortSignal,
): Promise<ParsedDocument> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const workerGlobal = globalThis as typeof globalThis & {
    pdfjsWorker?: { WorkerMessageHandler: unknown }
  }
  workerGlobal.pdfjsWorker = { WorkerMessageHandler }
  const loadingTask = getDocument({
    data: bytes.slice(),
    useSystemFonts: true,
    verbosity: 0,
  })

  try {
    const pdf = await loadingTask.promise
    if (pdf.numPages > limits.maxPdfPages) {
      throw new DocumentIngestionError(
        "PDF_TOO_MANY_PAGES",
        `PDF 不能超过 ${limits.maxPdfPages} 页。`,
        false,
      )
    }

    const paragraphs: ParsedParagraph[] = []
    let characterCount = 0
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      assertNotAborted(signal)
      const page = await pdf.getPage(pageNumber)
      const textContent = await page.getTextContent()
      const pageSource = extractPdfPageSource(textContent.items)
      page.cleanup()

      characterCount += pageSource.length
      assertCharacterLimit(characterCount, limits.maxParsedCharacters)
      for (const span of splitParagraphSpans(pageSource)) {
        paragraphs.push(
          createTextParagraph({
            paragraphIndex: paragraphs.length,
            content: normalizeLineEndings(
              pageSource.slice(span.start, span.end),
            ),
            pageNumber,
            headingPath: [],
            source: {
              start: span.start,
              end: span.end,
              locator: `page:${pageNumber}:characters:${span.start}-${span.end}`,
            },
          }),
        )
      }
    }

    if (paragraphs.length === 0) {
      throw new DocumentIngestionError(
        "PDF_NO_TEXT",
        "PDF 未包含可提取文本，暂不支持扫描件。",
        false,
      )
    }
    return { pageCount: pdf.numPages, paragraphs }
  } catch (error) {
    if (error instanceof DocumentIngestionError) throw error
    if (
      error instanceof Error &&
      (error.name === "PasswordException" ||
        /password|encrypted/i.test(error.message))
    ) {
      throw new DocumentIngestionError(
        "PDF_ENCRYPTED",
        "暂不支持加密或受密码保护的 PDF。",
        false,
      )
    }
    throw new DocumentIngestionError(
      "PDF_DAMAGED",
      "PDF 已损坏或无法读取。",
      false,
    )
  } finally {
    await loadingTask.destroy()
  }
}

async function replaceParagraphs(
  client: SupabaseClient,
  job: DocumentIngestionJob,
  claimId: string,
  parsed: ParsedDocument,
): Promise<void> {
  const { data, error } = await client.rpc("replace_document_paragraphs", {
    target_document_id: job.documentId,
    target_document_version: job.ingestionVersion,
    target_claim_id: claimId,
    parsed_page_count: parsed.pageCount,
    parsed_paragraphs: parsed.paragraphs.map((paragraph) => ({
      paragraph_index: paragraph.paragraphIndex,
      kind: paragraph.kind,
      content: paragraph.content,
      page_number: paragraph.pageNumber,
      heading_level: paragraph.headingLevel,
      heading_path: paragraph.headingPath,
      source_start: paragraph.source.start,
      source_end: paragraph.source.end,
      source_locator: paragraph.source.locator,
    })),
  })
  if (error) throw parsedOutputWriteError()
  if (data !== true) return
}

function createTextParagraph(
  input: Readonly<{
    paragraphIndex: number
    content: string
    pageNumber: number | null
    headingPath: readonly string[]
    source: SourceLocation
  }>,
): ParsedParagraph {
  return {
    ...input,
    kind: "paragraph",
    headingLevel: null,
  }
}

function createHeadingParagraph(
  input: Readonly<{
    paragraphIndex: number
    content: string
    level: number
    headingPath: readonly string[]
    source: SourceLocation
  }>,
): ParsedParagraph {
  return {
    paragraphIndex: input.paragraphIndex,
    kind: "heading",
    content: input.content,
    pageNumber: null,
    headingLevel: input.level,
    headingPath: input.headingPath,
    source: input.source,
  }
}

function characterLocation(
  span: Readonly<{ start: number; end: number }>,
): SourceLocation {
  return {
    ...span,
    locator: `characters:${span.start}-${span.end}`,
  }
}

function readOpeningFence(
  line: string,
): Readonly<{ marker: "`" | "~"; length: number }> | null {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line)
  if (!match) return null
  return {
    marker: match[1][0] as "`" | "~",
    length: match[1].length,
  }
}

function isClosingFence(
  line: string,
  fence: Readonly<{ marker: "`" | "~"; length: number }>,
): boolean {
  const indentation = line.length - line.trimStart().length
  if (indentation > 3) return false
  const trimmed = line.trim()
  let markerCount = 0
  while (trimmed[markerCount] === fence.marker) markerCount += 1
  return markerCount >= fence.length && markerCount === trimmed.length
}

function extractPdfPageSource(items: readonly unknown[]): string {
  let source = ""
  let previous:
    Readonly<{ xEnd: number; y: number; lineHeight: number }> | undefined

  for (const item of items) {
    if (!isPdfTextItem(item) || !item.str) continue
    const x = item.transform[4]
    const y = item.transform[5]
    const lineHeight = Math.max(
      1,
      Math.abs(item.transform[3]),
      Math.abs(item.height),
    )

    if (previous) {
      const verticalGap = Math.abs(y - previous.y)
      const referenceHeight = Math.max(lineHeight, previous.lineHeight)
      if (verticalGap > referenceHeight * 1.5) {
        source = ensureTrailingNewlines(source, 2)
      } else if (verticalGap > referenceHeight * 0.5) {
        source = ensureTrailingNewlines(source, 1)
      } else if (
        !source.endsWith("\n") &&
        x - previous.xEnd > referenceHeight * 0.15
      ) {
        source += " "
      }
    }

    source += item.str
    if (item.hasEOL) source = ensureTrailingNewlines(source, 1)
    previous = {
      xEnd: x + item.width,
      y,
      lineHeight,
    }
  }
  return source
}

function isPdfTextItem(value: unknown): value is Readonly<{
  str: string
  hasEOL: boolean
  width: number
  height: number
  transform: readonly number[]
}> {
  if (typeof value !== "object" || value === null) return false
  const item = value as Record<string, unknown>
  return (
    typeof item.str === "string" &&
    typeof item.hasEOL === "boolean" &&
    typeof item.width === "number" &&
    typeof item.height === "number" &&
    Array.isArray(item.transform) &&
    item.transform.length >= 6 &&
    item.transform.every((coordinate) => typeof coordinate === "number")
  )
}

function ensureTrailingNewlines(value: string, count: number): string {
  const existing = /\n*$/.exec(value)?.[0].length ?? 0
  return value + "\n".repeat(Math.max(0, count - existing))
}

function splitParagraphSpans(
  source: string,
): Array<Readonly<{ start: number; end: number }>> {
  const spans: Array<Readonly<{ start: number; end: number }>> = []
  const separator = /(?:\r\n|\r|\n)[ \t]*(?:\r\n|\r|\n)+/g
  let start = 0
  for (const match of source.matchAll(separator)) {
    const span = trimSpan(source, start, match.index)
    if (span) spans.push(span)
    start = match.index + match[0].length
  }
  const span = trimSpan(source, start, source.length)
  if (span) spans.push(span)
  return spans
}

function trimSpan(
  source: string,
  start: number,
  end: number,
): Readonly<{ start: number; end: number }> | null {
  while (start < end && /\s/u.test(source[start])) start += 1
  while (end > start && /\s/u.test(source[end - 1])) end -= 1
  return start === end ? null : { start, end }
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
}

function assertTextCanBeParsed(
  source: string,
  maxParsedCharacters: number,
): void {
  if (source.includes("\0")) {
    throw new DocumentIngestionError(
      "INVALID_FILE_TYPE",
      "Document 内容与文本类型不一致。",
      false,
    )
  }
  assertCharacterLimit(source.length, maxParsedCharacters)
  if (!source.trim()) throw emptyContentError()
}

function assertCharacterLimit(
  characterCount: number,
  maxParsedCharacters: number,
): void {
  if (characterCount > maxParsedCharacters) {
    throw new DocumentIngestionError(
      "PARSED_TEXT_TOO_LARGE",
      `解析后文本不能超过 ${maxParsedCharacters.toLocaleString("en-US")} 个字符。`,
      false,
    )
  }
}

function emptyContentError(): DocumentIngestionError {
  return new DocumentIngestionError(
    "EMPTY_FILE",
    "Document 不能只包含空白内容。",
    false,
  )
}

function ingestionDataUnavailableError(): DocumentIngestionError {
  return new DocumentIngestionError(
    "INGESTION_DATA_UNAVAILABLE",
    "Document 摄取数据暂时不可用，将自动重试。",
    true,
  )
}

function storageReadError(): DocumentIngestionError {
  return new DocumentIngestionError(
    "STORAGE_READ_FAILED",
    "Document 暂时无法从私有 Storage 读取，将自动重试。",
    true,
  )
}

function parsedOutputWriteError(): DocumentIngestionError {
  return new DocumentIngestionError(
    "PARSED_OUTPUT_WRITE_FAILED",
    "Document 解析结果暂时无法保存，将自动重试。",
    true,
  )
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DocumentIngestionError(
      "INGESTION_TASK_TIMEOUT",
      "Document 摄取超过任务时限，将自动重试。",
      true,
    )
  }
}
