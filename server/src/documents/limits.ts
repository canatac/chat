export const MiB = 1024 * 1024;

// Plafonds communs au backend et au service Tika livré dans deploy/tika-config.json.
export const DOCUMENT_LIMITS = {
  fileBytes: 10 * MiB,
  textChars: 200_000,
  responseBytes: 4 * MiB,
  pdfPages: 20,
  imagePixels: 16_000_000,
  embeddedCount: 32,
  timeoutMs: 135_000,
  pending: 16,
} as const;

export class DocumentError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = 'DocumentError';
  }
}
