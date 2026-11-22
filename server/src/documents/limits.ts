import { documentIssue, type DocumentIssue, type DocumentIssueCode } from './issues.js';

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

const defaultCodes: Partial<Record<number, DocumentIssueCode>> = { 404: 'missing', 409: 'pending', 413: 'size-limit', 415: 'unsupported', 422: 'unreadable', 429: 'service-busy', 503: 'service-unreachable', 507: 'storage-limit' };

export class DocumentError extends Error {
  readonly issue: DocumentIssue;
  constructor(public readonly statusCode: number, message: string, code?: DocumentIssueCode, diagnostic?: DocumentIssue['diagnostic']) {
    super(message);
    this.name = 'DocumentError';
    this.issue = documentIssue(code ?? defaultCodes[statusCode] ?? 'unknown', message, diagnostic);
  }
}
