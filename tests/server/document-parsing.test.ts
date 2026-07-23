import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { basename } from "node:path"

import { createClient } from "@supabase/supabase-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { DEFAULT_DOCUMENT_UPLOAD_LIMITS } from "../../src/lib/document-upload-policy"
import {
  createDocumentIngestionConsumer,
  DocumentIngestionError,
  type DocumentIngestionResult,
} from "../../src/server/documents/document-ingestion-consumer"
import { createDocumentParsingHandler } from "../../src/server/documents/document-parser"

const supabaseUrl = "http://127.0.0.1:54321"
const localServiceRoleKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"
const dataClient = createClient(
  supabaseUrl,
  process.env.ZHI_FLOW_SUPABASE_SECRET_KEY ?? localServiceRoleKey,
  { auth: { autoRefreshToken: false, persistSession: false } },
)
const createdKnowledgeBaseIds = new Set<string>()
const createdObjectKeys: string[] = []

beforeEach(() => {
  runDatabaseSql(
    "select pgmq.purge_queue('document_ingestion'); " +
      "select pgmq.purge_queue('document_ingestion_failed');",
  )
})

afterEach(async () => {
  if (createdObjectKeys.length > 0) {
    const { error } = await dataClient.storage
      .from("documents")
      .remove(createdObjectKeys.splice(0))
    if (error) throw error
  }
  if (createdKnowledgeBaseIds.size > 0) {
    const { error } = await dataClient
      .from("knowledge_bases")
      .delete()
      .in("id", [...createdKnowledgeBaseIds])
    createdKnowledgeBaseIds.clear()
    if (error) throw error
  }
  runDatabaseSql(
    "select pgmq.purge_queue('document_ingestion'); " +
      "select pgmq.purge_queue('document_ingestion_failed');",
  )
})

describe("Document 解析 Consumer", () => {
  it("从私有 Storage 解析 TXT 并保存可回溯的有序段落", async () => {
    const source = await readFixture("structured.txt")
    const documentId = await createQueuedStoredDocument({
      filename: "structured.txt",
      mimeType: "text/plain",
      bytes: source,
    })

    await expect(processDocument()).resolves.toMatchObject({
      outcome: "succeeded",
      documentId,
    })
    await expect(readDocumentState(documentId)).resolves.toMatchObject({
      status: "ready",
      current_stage: "parsing_completed",
      page_count: null,
      error_code: null,
      error_summary: null,
    })

    const paragraphs = await readParagraphs(documentId)
    expect(paragraphs).toEqual([
      {
        paragraph_index: 0,
        kind: "paragraph",
        content: "第一段保留内部\n换行。",
        page_number: null,
        heading_level: null,
        heading_path: [],
        source_start: 0,
        source_end: 11,
        source_locator: "characters:0-11",
      },
      {
        paragraph_index: 1,
        kind: "paragraph",
        content: "第二段包含特殊字符：& < > 😀",
        page_number: null,
        heading_level: null,
        heading_path: [],
        source_start: 13,
        source_end: 31,
        source_locator: "characters:13-31",
      },
    ])

    const decodedSource = new TextDecoder().decode(source)
    for (const paragraph of paragraphs) {
      expect(
        decodedSource.slice(paragraph.source_start, paragraph.source_end),
      ).toBe(paragraph.content)
    }
  })

  it("解析 Markdown 标题层级并把正文归入对应标题路径", async () => {
    const source = await readFixture("headings.md")
    const documentId = await createQueuedStoredDocument({
      filename: "headings.md",
      mimeType: "text/markdown",
      bytes: source,
    })

    await expect(processDocument()).resolves.toMatchObject({
      outcome: "succeeded",
      documentId,
    })
    const paragraphs = await readParagraphs(documentId)
    expect(paragraphs).toEqual([
      expect.objectContaining({
        paragraph_index: 0,
        kind: "heading",
        content: "产品说明",
        heading_level: 1,
        heading_path: ["产品说明"],
        source_start: 2,
        source_end: 6,
      }),
      expect.objectContaining({
        paragraph_index: 1,
        kind: "paragraph",
        content: "根级介绍。",
        heading_level: null,
        heading_path: ["产品说明"],
        source_start: 8,
        source_end: 13,
      }),
      expect.objectContaining({
        paragraph_index: 2,
        kind: "heading",
        content: "安装",
        heading_level: 2,
        heading_path: ["产品说明", "安装"],
        source_start: 18,
        source_end: 20,
      }),
      expect.objectContaining({
        paragraph_index: 3,
        kind: "paragraph",
        content: "先运行 `npm install`。",
        heading_level: null,
        heading_path: ["产品说明", "安装"],
        source_start: 22,
        source_end: 40,
      }),
      expect.objectContaining({
        paragraph_index: 4,
        kind: "heading",
        content: "验证",
        heading_level: 3,
        heading_path: ["产品说明", "安装", "验证"],
        source_start: 46,
        source_end: 48,
      }),
      expect.objectContaining({
        paragraph_index: 5,
        kind: "paragraph",
        content: "检查输出中的特殊字符：& < > 😀",
        heading_level: null,
        heading_path: ["产品说明", "安装", "验证"],
        source_start: 50,
        source_end: 69,
      }),
    ])

    const decodedSource = new TextDecoder().decode(source)
    for (const paragraph of paragraphs) {
      expect(
        decodedSource.slice(paragraph.source_start, paragraph.source_end),
      ).toBe(paragraph.content)
    }
  })

  it("区分 Markdown fenced code 与 Setext 标题", async () => {
    const source = await readFixture("markdown-edges.md")
    const documentId = await createQueuedStoredDocument({
      filename: "markdown-edges.md",
      mimeType: "text/markdown",
      bytes: source,
    })

    await expect(processDocument()).resolves.toMatchObject({
      outcome: "succeeded",
      documentId,
    })
    await expect(readParagraphs(documentId)).resolves.toEqual([
      expect.objectContaining({
        paragraph_index: 0,
        kind: "heading",
        content: "根标题",
        heading_level: 1,
        heading_path: ["根标题"],
      }),
      expect.objectContaining({
        paragraph_index: 1,
        kind: "paragraph",
        content: "```md\n# 代码块中的井号\n```",
        heading_level: null,
        heading_path: ["根标题"],
      }),
      expect.objectContaining({
        paragraph_index: 2,
        kind: "heading",
        content: "Setext 子标题",
        heading_level: 2,
        heading_path: ["根标题", "Setext 子标题"],
      }),
      expect.objectContaining({
        paragraph_index: 3,
        kind: "paragraph",
        content: "正文。",
        heading_level: null,
        heading_path: ["根标题", "Setext 子标题"],
      }),
    ])
  })

  it("解析多页文本型 PDF 并为每页保留独立定位", async () => {
    const source = await readFixture("two-pages.pdf")
    const documentId = await createQueuedStoredDocument({
      filename: "two-pages.pdf",
      mimeType: "application/pdf",
      bytes: source,
      pageCount: 2,
    })

    await expect(processDocument()).resolves.toMatchObject({
      outcome: "succeeded",
      documentId,
    })
    await expect(readDocumentState(documentId)).resolves.toMatchObject({
      status: "ready",
      current_stage: "parsing_completed",
      page_count: 2,
    })
    await expect(readParagraphs(documentId)).resolves.toEqual([
      {
        paragraph_index: 0,
        kind: "paragraph",
        content: "First PDF page.",
        page_number: 1,
        heading_level: null,
        heading_path: [],
        source_start: 0,
        source_end: 15,
        source_locator: "page:1:characters:0-15",
      },
      {
        paragraph_index: 1,
        kind: "paragraph",
        content: "Second PDF page.",
        page_number: 2,
        heading_level: null,
        heading_path: [],
        source_start: 0,
        source_end: 16,
        source_locator: "page:2:characters:0-16",
      },
    ])
  })

  it("使用 PDF 文本项版面间距保留页内段落边界", async () => {
    const source = await readFixture("pdf-paragraphs.pdf")
    const documentId = await createQueuedStoredDocument({
      filename: "pdf-paragraphs.pdf",
      mimeType: "application/pdf",
      bytes: source,
      pageCount: 1,
    })

    await expect(processDocument()).resolves.toMatchObject({
      outcome: "succeeded",
      documentId,
    })
    await expect(readParagraphs(documentId)).resolves.toEqual([
      expect.objectContaining({
        paragraph_index: 0,
        content: "First paragraph.",
        page_number: 1,
        source_locator: "page:1:characters:0-16",
      }),
      expect.objectContaining({
        paragraph_index: 1,
        content: "Second paragraph.",
        page_number: 1,
        source_locator: "page:1:characters:18-35",
      }),
    ])
  })

  it("解析结果提交后发生终态失败时清除全部段落", async () => {
    const source = await readFixture("structured.txt")
    const documentId = await createQueuedStoredDocument({
      filename: "fails-after-parsing.txt",
      mimeType: "text/plain",
      bytes: source,
    })
    const parsingHandler = createParsingHandler()
    const consumer = createDocumentIngestionConsumer({
      supabaseUrl,
      secretKey:
        process.env.ZHI_FLOW_SUPABASE_SECRET_KEY ?? localServiceRoleKey,
      handler: async (job, context) => {
        await parsingHandler(job, context)
        throw new DocumentIngestionError(
          "POST_PARSE_FAILURE",
          "解析完成后的步骤失败。",
          false,
        )
      },
    })

    await expect(consumer.processOne()).resolves.toMatchObject({
      outcome: "failed",
      documentId,
      errorCode: "POST_PARSE_FAILURE",
    })
    await expect(readDocumentState(documentId)).resolves.toMatchObject({
      status: "failed",
      current_stage: "failed",
      error_code: "POST_PARSE_FAILURE",
    })
    await expect(readParagraphs(documentId)).resolves.toEqual([])
  })

  it.each([
    {
      label: "错误 UTF-8",
      filename: "invalid.txt",
      mimeType: "text/plain",
      bytes: new Uint8Array([0xff, 0xfe, 0xfd]),
      errorCode: "INVALID_TEXT_ENCODING",
    },
    {
      label: "空白内容",
      filename: "blank.md",
      mimeType: "text/markdown",
      bytes: new TextEncoder().encode(" \n\t\n"),
      errorCode: "EMPTY_FILE",
    },
    {
      label: "超过解析字符上限",
      filename: "oversized.txt",
      mimeType: "text/plain",
      bytes: new TextEncoder().encode("1234"),
      errorCode: "PARSED_TEXT_TOO_LARGE",
      limits: { maxParsedCharacters: 3 },
    },
    {
      label: "超过 PDF 页数上限",
      filename: "two-pages.pdf",
      mimeType: "application/pdf",
      fixture: "two-pages.pdf",
      pageCount: 2,
      errorCode: "PDF_TOO_MANY_PAGES",
      limits: { maxPdfPages: 1 },
    },
    {
      label: "扫描 PDF",
      filename: "scanned.pdf",
      mimeType: "application/pdf",
      fixture: "scanned.pdf",
      pageCount: 1,
      errorCode: "PDF_NO_TEXT",
    },
    {
      label: "损坏 PDF",
      filename: "damaged.pdf",
      mimeType: "application/pdf",
      fixture: "damaged.pdf",
      errorCode: "PDF_DAMAGED",
    },
  ])(
    "拒绝$label并且不保留部分解析输出",
    async ({
      filename,
      mimeType,
      fixture,
      bytes: inlineBytes,
      pageCount,
      errorCode,
      limits,
    }) => {
      const bytes = fixture ? await readFixture(fixture) : inlineBytes!
      const documentId = await createQueuedStoredDocument({
        filename,
        mimeType,
        bytes,
        pageCount,
      })

      await expect(processDocument(limits)).resolves.toMatchObject({
        outcome: "failed",
        documentId,
        attemptCount: 1,
        errorCode,
      })
      await expect(readDocumentState(documentId)).resolves.toMatchObject({
        status: "failed",
        current_stage: "failed",
        attempt_count: 1,
        error_code: errorCode,
      })
      await expect(readParagraphs(documentId)).resolves.toEqual([])
    },
  )
})

async function processDocument(
  limitOverrides: Partial<typeof DEFAULT_DOCUMENT_UPLOAD_LIMITS> = {},
): Promise<DocumentIngestionResult> {
  const consumer = createDocumentIngestionConsumer({
    supabaseUrl,
    secretKey: process.env.ZHI_FLOW_SUPABASE_SECRET_KEY ?? localServiceRoleKey,
    handler: createParsingHandler(limitOverrides),
  })
  return consumer.processOne()
}

function createParsingHandler(
  limitOverrides: Partial<typeof DEFAULT_DOCUMENT_UPLOAD_LIMITS> = {},
) {
  return createDocumentParsingHandler({
    supabaseUrl,
    secretKey: process.env.ZHI_FLOW_SUPABASE_SECRET_KEY ?? localServiceRoleKey,
    limits: { ...DEFAULT_DOCUMENT_UPLOAD_LIMITS, ...limitOverrides },
  })
}

async function createQueuedStoredDocument(input: {
  filename: string
  mimeType: string
  bytes: Uint8Array
  pageCount?: number | null
}): Promise<string> {
  const { data: knowledgeBase, error: knowledgeBaseError } = await dataClient
    .from("knowledge_bases")
    .insert({ name: `解析测试 ${crypto.randomUUID()}` })
    .select("id")
    .single()
  if (knowledgeBaseError) throw knowledgeBaseError
  createdKnowledgeBaseIds.add(knowledgeBase.id)

  const objectKey = `${knowledgeBase.id}/${crypto.randomUUID()}-${input.filename}`
  const { error: storageError } = await dataClient.storage
    .from("documents")
    .upload(objectKey, input.bytes, {
      contentType: input.mimeType,
      upsert: false,
    })
  if (storageError) throw storageError
  createdObjectKeys.push(objectKey)

  const { data: document, error: documentError } = await dataClient
    .from("documents")
    .insert({
      knowledge_base_id: knowledgeBase.id,
      original_filename: input.filename,
      storage_object_key: objectKey,
      mime_type: input.mimeType,
      byte_size: input.bytes.byteLength,
      page_count: input.pageCount ?? null,
      sha256: createHash("sha256").update(input.bytes).digest("hex"),
      status: "uploaded",
      current_stage: "stored",
    })
    .select("id")
    .single()
  if (documentError) throw documentError

  const { error: enqueueError } = await dataClient.rpc(
    "enqueue_document_ingestion",
    { target_document_id: document.id },
  )
  if (enqueueError) throw enqueueError
  return document.id
}

async function readParagraphs(documentId: string) {
  const { data, error } = await dataClient
    .from("document_paragraphs")
    .select(
      "paragraph_index,kind,content,page_number,heading_level,heading_path,source_start,source_end,source_locator",
    )
    .eq("document_id", documentId)
    .order("paragraph_index")
  if (error) throw error
  return data
}

async function readDocumentState(documentId: string) {
  const { data, error } = await dataClient
    .from("documents")
    .select(
      "status,current_stage,page_count,attempt_count,error_code,error_summary",
    )
    .eq("id", documentId)
    .single()
  if (error) throw error
  return data
}

async function readFixture(filename: string): Promise<Uint8Array> {
  return readFile(
    new URL(`../fixtures/documents/${basename(filename)}`, import.meta.url),
  )
}

function runDatabaseSql(sql: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      "supabase_db_zhi-flow",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
      "-c",
      sql,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  ).trim()
}
