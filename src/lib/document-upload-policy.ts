export const DOCUMENT_FILE_FORMATS = Object.freeze({
  ".pdf": Object.freeze({
    canonicalMimeType: "application/pdf",
    acceptedMimeTypes: ["application/pdf"] as const,
  }),
  ".md": Object.freeze({
    canonicalMimeType: "text/markdown",
    acceptedMimeTypes: ["text/markdown", "text/plain"] as const,
  }),
  ".markdown": Object.freeze({
    canonicalMimeType: "text/markdown",
    acceptedMimeTypes: ["text/markdown", "text/plain"] as const,
  }),
  ".txt": Object.freeze({
    canonicalMimeType: "text/plain",
    acceptedMimeTypes: ["text/plain"] as const,
  }),
})

export type SupportedDocumentExtension = keyof typeof DOCUMENT_FILE_FORMATS

export type DocumentUploadLimits = Readonly<{
  maxFiles: number
  maxFileBytes: number
  maxPdfPages: number
  maxParsedCharacters: number
}>

export type DocumentUploadPolicy = DocumentUploadLimits &
  Readonly<{
    acceptedExtensions: readonly SupportedDocumentExtension[]
    accept: string
  }>

export const DEFAULT_DOCUMENT_UPLOAD_LIMITS: DocumentUploadLimits =
  Object.freeze({
    maxFiles: 10,
    maxFileBytes: 20 * 1024 * 1024,
    maxPdfPages: 200,
    maxParsedCharacters: 2_000_000,
  })

export function toDocumentUploadPolicy(
  limits: DocumentUploadLimits,
): DocumentUploadPolicy {
  const acceptedExtensions = Object.keys(
    DOCUMENT_FILE_FORMATS,
  ) as SupportedDocumentExtension[]
  return Object.freeze({
    ...limits,
    acceptedExtensions,
    accept: [
      ...acceptedExtensions,
      ...new Set(
        Object.values(DOCUMENT_FILE_FORMATS).flatMap(
          ({ acceptedMimeTypes }) => acceptedMimeTypes,
        ),
      ),
    ].join(","),
  })
}

export function isSupportedDocumentExtension(
  extension: string,
): extension is SupportedDocumentExtension {
  return extension in DOCUMENT_FILE_FORMATS
}

export function declaredMimeMatches(
  extension: SupportedDocumentExtension,
  mimeType: string,
): boolean {
  return (
    DOCUMENT_FILE_FORMATS[extension].acceptedMimeTypes as readonly string[]
  ).includes(mimeType)
}
