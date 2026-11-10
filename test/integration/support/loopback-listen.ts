import { INestApplication } from '@nestjs/common';
import { NestApplication } from '@nestjs/core';
import { Server } from 'http';

// supertest connects to 127.0.0.1:<port> of whatever its target listens on.
// A server it starts itself listens on the wildcard address, and on macOS
// that can be handed a port another process already holds on 127.0.0.1, so
// the request lands on that process instead of the app. A server bound to
// 127.0.0.1 is never offered such a port.
const proto = NestApplication.prototype as unknown as {
  init: (this: NestApplication) => Promise<INestApplication>;
};
const originalInit = proto.init;

proto.init = async function (this: NestApplication): Promise<INestApplication> {
  const app = await (
    originalInit.bind(this) as () => Promise<INestApplication>
  )();
  const server = this.getHttpServer() as Server;
  if (!server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  }
  return app;
};
