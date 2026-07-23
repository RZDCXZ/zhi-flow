"use client"

import { ChangeEvent, useCallback, useEffect, useState } from "react"
import {
  FileTextIcon,
  LibraryIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  declaredMimeMatches,
  DEFAULT_DOCUMENT_UPLOAD_LIMITS,
  isSupportedDocumentExtension,
  toDocumentUploadPolicy,
  type DocumentUploadPolicy,
} from "@/lib/document-upload-policy"
import type { Document, KnowledgeBase } from "@/lib/knowledge-base-api"

const defaultUploadPolicy = toDocumentUploadPolicy(
  DEFAULT_DOCUMENT_UPLOAD_LIMITS,
)

type UploadFeedback = Readonly<{
  filename: string
  status: "ready" | "uploading" | "uploaded" | "failed"
  message?: string
}>

export function KnowledgeBasePanel() {
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([])
  const [selectedKnowledgeBaseId, setSelectedKnowledgeBaseId] = useState<
    string | null
  >(null)
  const [documents, setDocuments] = useState<Document[]>([])
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [uploadFeedback, setUploadFeedback] = useState<UploadFeedback[]>([])
  const [uploadPolicy, setUploadPolicy] = useState<DocumentUploadPolicy | null>(
    null,
  )
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)

  const openKnowledgeBase = useCallback(async (knowledgeBaseId: string) => {
    const body = await fetchKnowledgeBase(knowledgeBaseId)
    setSelectedKnowledgeBaseId(body.knowledgeBase.id)
    setDocuments(body.documents)
  }, [])

  const refreshKnowledgeBases = useCallback(
    async (preferredKnowledgeBaseId?: string) => {
      const body = await fetchKnowledgeBases()
      setKnowledgeBases(body.knowledgeBases)
      const target =
        preferredKnowledgeBaseId ??
        selectedKnowledgeBaseId ??
        body.knowledgeBases[0]?.id
      if (target && body.knowledgeBases.some(({ id }) => id === target)) {
        await openKnowledgeBase(target)
      } else {
        setSelectedKnowledgeBaseId(null)
        setDocuments([])
      }
    },
    [openKnowledgeBase, selectedKnowledgeBaseId],
  )

  useEffect(() => {
    let ignore = false
    void (async () => {
      try {
        const [body, policy] = await Promise.all([
          fetchKnowledgeBases(),
          fetchDocumentUploadPolicy(),
        ])
        if (ignore) return
        setKnowledgeBases(body.knowledgeBases)
        setUploadPolicy(policy)
        const firstId = body.knowledgeBases[0]?.id
        if (!firstId) return
        const detail = await fetchKnowledgeBase(firstId)
        if (ignore) return
        setSelectedKnowledgeBaseId(detail.knowledgeBase.id)
        setDocuments(detail.documents)
      } catch (error) {
        if (!ignore) setErrorMessage(readUnknownError(error))
      }
    })()
    return () => {
      ignore = true
    }
  }, [])

  const selectedKnowledgeBase = knowledgeBases.find(
    ({ id }) => id === selectedKnowledgeBaseId,
  )
  const displayPolicy = uploadPolicy ?? defaultUploadPolicy

  async function createNewKnowledgeBase() {
    const name = window.prompt("知识库名称")?.trim()
    if (!name) return
    setIsBusy(true)
    setErrorMessage(null)
    try {
      const response = await fetch("/api/knowledge-bases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      })
      if (!response.ok) throw new Error(await readResponseError(response))
      const body = (await response.json()) as { knowledgeBase: KnowledgeBase }
      await refreshKnowledgeBases(body.knowledgeBase.id)
    } catch (error) {
      setErrorMessage(readUnknownError(error))
    } finally {
      setIsBusy(false)
    }
  }

  async function renameSelectedKnowledgeBase() {
    if (!selectedKnowledgeBase) return
    const name = window
      .prompt("新的知识库名称", selectedKnowledgeBase.name)
      ?.trim()
    if (!name || name === selectedKnowledgeBase.name) return
    setIsBusy(true)
    setErrorMessage(null)
    try {
      const response = await fetch(
        `/api/knowledge-bases/${selectedKnowledgeBase.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        },
      )
      if (!response.ok) throw new Error(await readResponseError(response))
      await refreshKnowledgeBases(selectedKnowledgeBase.id)
    } catch (error) {
      setErrorMessage(readUnknownError(error))
    } finally {
      setIsBusy(false)
    }
  }

  async function deleteSelectedKnowledgeBase() {
    if (!selectedKnowledgeBase) return
    const confirmation = window.prompt(
      `删除会级联移除 ${documents.length} 个 Document。请输入完整名称“${selectedKnowledgeBase.name}”确认。`,
    )
    if (confirmation?.trim() !== selectedKnowledgeBase.name) {
      if (confirmation !== null) setErrorMessage("知识库名称不匹配，未删除。")
      return
    }

    setIsBusy(true)
    setErrorMessage(null)
    try {
      const response = await fetch(
        `/api/knowledge-bases/${selectedKnowledgeBase.id}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmation: confirmation.trim() }),
        },
      )
      if (!response.ok) throw new Error(await readResponseError(response))
      setPendingFiles([])
      setUploadFeedback([])
      await refreshKnowledgeBases()
    } catch (error) {
      setErrorMessage(readUnknownError(error))
    } finally {
      setIsBusy(false)
    }
  }

  function selectFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ""
    if (uploadPolicy === null) {
      setUploadFeedback(
        files.map(({ name }) => ({
          filename: name,
          status: "failed",
          message: "上传限制尚未加载，请稍后重试。",
        })),
      )
      setPendingFiles([])
      return
    }
    const feedback = clientPreflight(files, uploadPolicy)
    setUploadFeedback(feedback)
    setPendingFiles(
      feedback.some(({ status }) => status === "failed") ? [] : files,
    )
  }

  async function uploadSelectedFiles() {
    if (!selectedKnowledgeBaseId || pendingFiles.length === 0) return
    setIsBusy(true)
    setErrorMessage(null)
    setUploadFeedback(
      pendingFiles.map(({ name }) => ({ filename: name, status: "uploading" })),
    )

    const form = new FormData()
    for (const file of pendingFiles) form.append("files", file)
    try {
      const response = await fetch(
        `/api/knowledge-bases/${selectedKnowledgeBaseId}/documents`,
        { method: "POST", body: form },
      )
      if (!response.ok) throw new Error(await readResponseError(response))
      const body = (await response.json()) as { documents: Document[] }
      setUploadFeedback(
        pendingFiles.map(({ name }) => {
          const document = body.documents.find(
            ({ originalFilename }) => originalFilename === name,
          )
          return {
            filename: name,
            status: "uploaded",
            message:
              document?.status === "queued"
                ? "已安全保存并排队"
                : (document?.errorSummary ?? "已安全保存，等待手动重新入队"),
          }
        }),
      )
      setPendingFiles([])
      await openKnowledgeBase(selectedKnowledgeBaseId)
    } catch (error) {
      const message = readUnknownError(error)
      setUploadFeedback(
        pendingFiles.map(({ name }) => ({
          filename: name,
          status: "failed",
          message,
        })),
      )
      setErrorMessage(message)
    } finally {
      setIsBusy(false)
    }
  }

  async function retryDocumentEnqueue(documentId: string) {
    if (!selectedKnowledgeBaseId) return
    setIsBusy(true)
    setErrorMessage(null)
    try {
      const response = await fetch(
        `/api/knowledge-bases/${selectedKnowledgeBaseId}` +
          `/documents/${documentId}/enqueue`,
        { method: "POST" },
      )
      if (!response.ok) throw new Error(await readResponseError(response))
      await openKnowledgeBase(selectedKnowledgeBaseId)
    } catch (error) {
      await openKnowledgeBase(selectedKnowledgeBaseId).catch(() => undefined)
      setErrorMessage(readUnknownError(error))
    } finally {
      setIsBusy(false)
    }
  }

  return (
    <div className="grid w-full gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <Card className="[--card-spacing:--spacing(5)]">
        <CardHeader className="gap-3">
          <CardTitle className="flex items-center gap-2 text-xl">
            <LibraryIcon className="size-5" />
            Knowledge Bases
          </CardTitle>
          <Button onClick={createNewKnowledgeBase} disabled={isBusy}>
            <PlusIcon data-icon="inline-start" />
            新建知识库
          </Button>
        </CardHeader>
        <CardContent className="grid gap-3">
          {knowledgeBases.length === 0 ? (
            <p className="text-sm leading-6 text-muted-foreground">
              尚无 Knowledge Base。新建后可上传私人资料。
            </p>
          ) : (
            <div className="grid gap-2">
              {knowledgeBases.map((knowledgeBase) => (
                <Button
                  key={knowledgeBase.id}
                  variant={
                    knowledgeBase.id === selectedKnowledgeBaseId
                      ? "secondary"
                      : "ghost"
                  }
                  className="h-auto justify-start py-2.5 text-left whitespace-normal"
                  disabled={isBusy}
                  onClick={() => void openKnowledgeBase(knowledgeBase.id)}
                >
                  {knowledgeBase.name}
                </Button>
              ))}
            </div>
          )}
          {selectedKnowledgeBase ? (
            <div className="grid grid-cols-2 gap-2 border-t pt-3">
              <Button
                variant="outline"
                disabled={isBusy}
                onClick={renameSelectedKnowledgeBase}
              >
                <PencilIcon data-icon="inline-start" />
                重命名
              </Button>
              <Button
                variant="destructive"
                disabled={isBusy}
                onClick={deleteSelectedKnowledgeBase}
              >
                <Trash2Icon data-icon="inline-start" />
                确认删除
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card className="[--card-spacing:--spacing(6)]">
        <CardHeader className="gap-2">
          <CardTitle className="text-xl">上传 Document</CardTitle>
          <CardDescription className="text-base leading-relaxed">
            PDF、Markdown、TXT · 单文件 {formatMiB(displayPolicy.maxFileBytes)}{" "}
            MiB · PDF {displayPolicy.maxPdfPages} 页 · 解析后最多{" "}
            {displayPolicy.maxParsedCharacters.toLocaleString("en-US")} 字符 ·
            单次最多 {displayPolicy.maxFiles} 个文件
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <div className="grid gap-3 rounded-xl border border-dashed p-4 sm:grid-cols-[1fr_auto] sm:items-end">
            <label className="grid gap-2 text-sm font-medium">
              选择私人文件
              <input
                type="file"
                multiple
                accept={displayPolicy.accept}
                disabled={!selectedKnowledgeBaseId || !uploadPolicy || isBusy}
                onChange={selectFiles}
                className="block w-full rounded-lg border bg-background px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5 file:font-medium disabled:opacity-60"
              />
            </label>
            <Button
              size="lg"
              disabled={
                !selectedKnowledgeBaseId || pendingFiles.length === 0 || isBusy
              }
              onClick={uploadSelectedFiles}
            >
              <UploadIcon data-icon="inline-start" />
              {isBusy && pendingFiles.length > 0 ? "上传中…" : "开始上传"}
            </Button>
          </div>

          {uploadFeedback.length > 0 ? (
            <div className="grid gap-2" aria-live="polite">
              {uploadFeedback.map((item) => (
                <p
                  key={item.filename}
                  className="rounded-lg border px-3 py-2 text-sm"
                >
                  {item.filename} · {uploadStatusLabel(item.status)}
                  {item.message ? ` · ${item.message}` : ""}
                </p>
              ))}
            </div>
          ) : null}

          {errorMessage ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              {errorMessage}
            </p>
          ) : null}

          <div className="grid gap-3">
            <h3 className="font-medium">Document 状态</h3>
            {!selectedKnowledgeBaseId ? (
              <p className="text-sm text-muted-foreground">
                请选择或新建 Knowledge Base。
              </p>
            ) : documents.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                尚无 Document。上传后将在这里显示可追踪状态。
              </p>
            ) : (
              documents.map((document) => (
                <article
                  key={document.id}
                  className="flex items-start gap-3 rounded-xl border p-4"
                >
                  <FileTextIcon className="mt-0.5 size-5 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      {document.originalFilename}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {formatBytes(document.byteSize)} ·{" "}
                      {document.pageCount ? `${document.pageCount} 页 · ` : ""}
                      {documentStatusLabel(document)}
                    </p>
                    {document.errorSummary ? (
                      <p className="mt-2 text-sm text-destructive">
                        {document.errorSummary}
                      </p>
                    ) : null}
                  </div>
                  {document.status === "uploaded" &&
                  document.currentStage === "enqueue_failed" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isBusy}
                      onClick={() => retryDocumentEnqueue(document.id)}
                    >
                      <RefreshCwIcon data-icon="inline-start" />
                      重新入队
                    </Button>
                  ) : null}
                </article>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function clientPreflight(
  files: File[],
  policy: DocumentUploadPolicy,
): UploadFeedback[] {
  if (files.length > policy.maxFiles) {
    return files.map(({ name }) => ({
      filename: name,
      status: "failed",
      message: `单次最多选择 ${policy.maxFiles} 个文件。`,
    }))
  }

  return files.map((file) => {
    const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase()
    let message: string | undefined
    if (file.size === 0) message = "文件不能为空。"
    else if (file.size > policy.maxFileBytes)
      message = `单个文件不能超过 ${formatMiB(policy.maxFileBytes)} MiB。`
    else if (
      !isSupportedDocumentExtension(extension) ||
      !policy.acceptedExtensions.includes(extension) ||
      !declaredMimeMatches(extension, file.type)
    )
      message = "扩展名或 MIME 不受支持。"

    return {
      filename: file.name,
      status: message ? "failed" : "ready",
      ...(message ? { message } : {}),
    }
  })
}

function documentStatusLabel(document: Document): string {
  const labels: Record<Document["status"], string> = {
    uploaded:
      document.currentStage === "enqueue_failed"
        ? "入队失败，可重试"
        : "已上传，等待入队",
    queued: "已排队",
    processing: "处理中",
    ready: "已就绪",
    failed: "处理失败",
    archived: "已归档",
  }
  return labels[document.status]
}

function uploadStatusLabel(status: UploadFeedback["status"]): string {
  if (status === "ready") return "等待上传"
  if (status === "uploading") return "正在上传"
  if (status === "uploaded") return "上传成功"
  return "上传失败"
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KiB`
}

function formatMiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toLocaleString("en-US", {
    maximumFractionDigits: 2,
  })
}

async function fetchKnowledgeBases(): Promise<{
  knowledgeBases: KnowledgeBase[]
}> {
  const response = await fetch("/api/knowledge-bases", { cache: "no-store" })
  if (!response.ok) throw new Error("无法读取知识库列表。")
  return (await response.json()) as { knowledgeBases: KnowledgeBase[] }
}

async function fetchDocumentUploadPolicy(): Promise<DocumentUploadPolicy> {
  const response = await fetch("/api/knowledge-bases/upload-policy", {
    cache: "no-store",
  })
  if (!response.ok) throw new Error("无法读取上传限制。")
  const body = (await response.json()) as { policy: DocumentUploadPolicy }
  return body.policy
}

async function fetchKnowledgeBase(knowledgeBaseId: string): Promise<{
  knowledgeBase: KnowledgeBase
  documents: Document[]
}> {
  const response = await fetch(`/api/knowledge-bases/${knowledgeBaseId}`, {
    cache: "no-store",
  })
  if (!response.ok) throw new Error("无法读取知识库。")
  return (await response.json()) as {
    knowledgeBase: KnowledgeBase
    documents: Document[]
  }
}

async function readResponseError(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null)
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "object" &&
    body.error !== null &&
    "message" in body.error &&
    typeof body.error.message === "string"
  ) {
    return body.error.message
  }
  return "操作失败，请稍后重试。"
}

function readUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请稍后重试。"
}
