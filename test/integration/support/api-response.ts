import { Response } from 'supertest';

export function dataOf<T>(res: Pick<Response, 'body'>): T {
  return (res.body as { data: T }).data;
}

export function errorOf(res: Pick<Response, 'body'>): {
  code: string;
  message: string;
  details?: unknown;
} {
  return (
    res.body as {
      error: { code: string; message: string; details?: unknown };
    }
  ).error;
}
