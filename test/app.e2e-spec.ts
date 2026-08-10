import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppController } from '../src/app.controller';

// Deliberately test AppController in isolation rather than the full
// AppModule: booting the whole module tree here would pull in
// PrismaModule, and Prisma 7's WASM query-compiler runtime requires a
// dynamic `import()` that Jest's default (non-ESM) transform can't execute
// (`--experimental-vm-modules` would be needed). Real integration tests for
// modules that genuinely need a live database (auth, subscriptions, ...)
// should use a dedicated test-database setup once those modules exist,
// tracked in the README rather than worked around here for an unrelated
// health-check smoke test.
describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/ (GET) returns the health check payload', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect({ status: 'ok' });
  });

  afterEach(async () => {
    await app.close();
  });
});
