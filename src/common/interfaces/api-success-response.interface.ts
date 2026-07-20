export interface ApiSuccessResponse<T> {
  success: true;
  statusCode: number;
  data: T;
  path: string;
  timestamp: string;
}
