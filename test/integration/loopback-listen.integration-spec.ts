import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createServer } from 'http';
import { AddressInfo } from 'net';

describe('test app servers', () => {
  it('are listening on 127.0.0.1 once initialised, where supertest connects', async () => {
    const moduleRef = await Test.createTestingModule({}).compile();
    const app: INestApplication = moduleRef.createNestApplication();
    await app.init();
    try {
      const server = app.getHttpServer() as ReturnType<typeof createServer>;
      expect(server.listening).toBe(true);
      expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
    } finally {
      await app.close();
    }
  });
});
