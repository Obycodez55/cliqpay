export interface ApiErrorResponse {
  success: false;
  statusCode: number;
  error: {
    /** Stable machine-readable code (e.g. INSUFFICIENT_FUNDS, VALIDATION_FAILED) */
    code: string;
    message: string;
    details?: unknown;
  };
  path: string;
  timestamp: string;
}
