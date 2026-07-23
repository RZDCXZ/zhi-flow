import "server-only"

import { createHash, randomUUID } from "node:crypto"
import { extname } from "node:path"

import { WorkerMessageHandler } from "pdfjs-dist/legacy/build/pdf.worker.mjs"

import {
  declaredMimeMatches,
  DOCUMENT_FILE_FORMATS,
  isSupportedDocumentExtension,
  type SupportedDocumentExtension,
} from "@/lib/document-upload-policy"
import type { Document } from "@/lib/knowledge-base-api"
import { serverConfig } from "@/server/config"
import { createServerDataClient } from "@/server/supabase"

import {
  documentColumns,
  toDocument,
  type DocumentRow,
} from "./document-record"

const DOCUMENTS_BUCKET = "documents"

type InspectedFile = Readonly<{
  file: File
  bytes: Uint8Array
  extension: SupportedDocumentExtension
  mimeType: "application/pdf" | "text/markdown" | "text/plain"
  pageCount: number | null
  sha256: string
}>

export class DocumentUploadError extends Error {
  constructor(
    readonly code:
      | "EMPTY_FILE"
      | "FILE_TOO_LARGE"
      | "INVALID_FILE_TYPE"
      | "INVALID_TEXT_ENCODING"
      | "PARSED_TEXT_TOO_LARGE"
      | "PDF_ENCRYPTED"
      | "PDF_TOO_MANY_PAGES"
      | "PDF_NO_TEXT"
      | "PDF_DAMAGED"
      | "TOO_MANY_FILES"
      | "UPLOAD_FAILED",
    message: string,
  ) {
    super(message)
    this.name = "DocumentUploadError"
  }
}

export async function uploadDocuments(
  knowledgeBaseId: string,
  files: File[],
): Promise<Document[]> {
  const limits = serverConfig.upload
  if (files.length > limits.maxFiles) {
    throw new DocumentUploadError(
      "TOO_MANY_FILES",
      `单次最多上传 ${limits.maxFiles} 个文件。`,
    )
  }

  const inspectedFiles: InspectedFile[] = []
  for (const file of files) {
    inspectedFiles.push(await inspectFile(file, limits))
  }

  const client = createServerDataClient()
  const createdRows: DocumentRow[] = []
  const createdObjectKeys: string[] = []

  try {
    for (const inspected of inspectedFiles) {
      const objectKey = `${knowledgeBaseId}/${randomUUID()}${inspected.extension}`
      const { error: storageError } = await client.storage
        .from(DOCUMENTS_BUCKET)
        .upload(objectKey, inspected.bytes, {
          contentType: inspected.mimeType,
          upsert: false,
        })
      if (storageError) throw storageError
      createdObjectKeys.push(objectKey)

      const { data, error: documentError } = await client
        .from("documents")
        .insert({
          knowledge_base_id: knowledgeBaseId,
          original_filename: inspected.file.name,
          storage_object_key: objectKey,
          mime_type: inspected.mimeType,
          byte_size: inspected.file.size,
          page_count: inspected.pageCount,
          sha256: inspected.sha256,
          status: "uploaded",
          current_stage: "stored",
        })
        .select(documentColumns)
        .single()
      if (documentError) throw documentError
      createdRows.push(data as DocumentRow)
    }
  } catch {
    await cleanupCreatedUpload(createdRows, createdObjectKeys)
    throw new DocumentUploadError(
      "UPLOAD_FAILED",
      "文件暂时无法安全保存，请稍后重试。",
    )
  }

  return createdRows.map(toDocument)
}

async function inspectFile(
  file: File,
  limits: typeof serverConfig.upload,
): Promise<InspectedFile> {
  if (file.size === 0) {
    throw new DocumentUploadError("EMPTY_FILE", "文件不能为空。")
  }
  if (file.size > limits.maxFileBytes) {
    throw new DocumentUploadError(
      "FILE_TOO_LARGE",
      `单个文件不能超过 ${formatMiB(limits.maxFileBytes)} MiB。`,
    )
  }

  const extension = extname(file.name).toLowerCase()
  if (
    !isSupportedDocumentExtension(extension) ||
    !declaredMimeMatches(extension, file.type)
  ) {
    throw invalidFileType()
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const format = DOCUMENT_FILE_FORMATS[extension]

  if (extension === ".pdf") {
    if (!hasPdfSignature(bytes)) throw invalidFileType()
    const pageCount = await inspectPdf(bytes, limits)
    return {
      file,
      bytes,
      extension,
      mimeType: format.canonicalMimeType,
      pageCount,
      sha256,
    }
  }

  if (extension === ".md" || extension === ".markdown") {
    inspectText(bytes, limits.maxParsedCharacters)
    return {
      file,
      bytes,
      extension,
      mimeType: format.canonicalMimeType,
      pageCount: null,
      sha256,
    }
  }

  if (extension === ".txt") {
    inspectText(bytes, limits.maxParsedCharacters)
    return {
      file,
      bytes,
      extension,
      mimeType: format.canonicalMimeType,
      pageCount: null,
      sha256,
    }
  }

  throw invalidFileType()
}

function inspectText(bytes: Uint8Array, maxParsedCharacters: number): void {
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new DocumentUploadError(
      "INVALID_TEXT_ENCODING",
      "文本文件必须使用 UTF-8 编码。",
    )
  }
  if (text.includes("\0")) throw invalidFileType()
  if (!text.trim()) {
    throw new DocumentUploadError("EMPTY_FILE", "文件不能只包含空白内容。")
  }
  assertParsedCharacterLimit(text.length, maxParsedCharacters)
}

async function inspectPdf(
  bytes: Uint8Array,
  limits: typeof serverConfig.upload,
): Promise<number> {
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
      throw new DocumentUploadError(
        "PDF_TOO_MANY_PAGES",
        `PDF 不能超过 ${limits.maxPdfPages} 页。`,
      )
    }

    let characterCount = 0
    let hasVisibleText = false
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent()
      for (const item of content.items) {
        if (!("str" in item)) continue
        characterCount += item.str.length
        if (item.str.trim()) hasVisibleText = true
        assertParsedCharacterLimit(characterCount, limits.maxParsedCharacters)
      }
      page.cleanup()
    }

    if (!hasVisibleText) {
      throw new DocumentUploadError(
        "PDF_NO_TEXT",
        "PDF 未包含可提取文本，暂不支持扫描件。",
      )
    }
    return pdf.numPages
  } catch (error) {
    if (error instanceof DocumentUploadError) throw error
    console.error("PDF validation failed", {
      name: error instanceof Error ? error.name : "UnknownError",
      category: classifyPdfError(error),
    })
    if (
      error instanceof Error &&
      (error.name === "PasswordException" ||
        /password|encrypted/i.test(error.message))
    ) {
      throw new DocumentUploadError(
        "PDF_ENCRYPTED",
        "暂不支持加密或受密码保护的 PDF。",
      )
    }
    throw new DocumentUploadError("PDF_DAMAGED", "PDF 已损坏或无法读取。")
  } finally {
    await loadingTask.destroy()
  }
}

function assertParsedCharacterLimit(
  characterCount: number,
  maxParsedCharacters: number,
): void {
  if (characterCount > maxParsedCharacters) {
    throw new DocumentUploadError(
      "PARSED_TEXT_TOO_LARGE",
      `解析后文本不能超过 ${maxParsedCharacters.toLocaleString("en-US")} 个字符。`,
    )
  }
}

function hasPdfSignature(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  )
}

function invalidFileType(): DocumentUploadError {
  return new DocumentUploadError(
    "INVALID_FILE_TYPE",
    "仅支持内容与扩展名、MIME 一致的 PDF、Markdown 和 TXT 文件。",
  )
}

async function cleanupCreatedUpload(
  rows: DocumentRow[],
  objectKeys: string[],
): Promise<void> {
  const client = createServerDataClient()
  if (rows.length > 0) {
    await client
      .from("documents")
      .delete()
      .in(
        "id",
        rows.map(({ id }) => id),
      )
  }
  if (objectKeys.length > 0) {
    await client.storage.from(DOCUMENTS_BUCKET).remove(objectKeys)
  }
}

function classifyPdfError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown"
  if (error.name === "PasswordException") return "encrypted"
  if (error.name === "InvalidPDFException") return "invalid"
  if (error.name === "MissingPDFException") return "missing"
  return "unreadable"
}

function formatMiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toLocaleString("en-US", {
    maximumFractionDigits: 2,
  })
}
