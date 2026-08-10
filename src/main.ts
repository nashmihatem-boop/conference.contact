import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';

const HARD_SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Nest's own `app.enableShutdownHooks()` awaits every provider's shutdown
 * hook in sequence and only exits once they've all resolved — if any one
 * of them hangs, the process never exits at all. That's not hypothetical:
 * confirmed directly here, with Redis unreachable, a restart triggered by
 * the dev watcher left the old process alive and unresponsive on its port
 * for minutes (ioredis's own disconnect apparently doesn't resolve
 * cleanly against a connection it can't reach). A container orchestrator
 * would eventually SIGKILL a process stuck like this, but only after its
 * own grace period — during which health checks fail and the old,
 * possibly-still-serving process never actually gets replaced.
 *
 * This still runs the same lifecycle hooks (app.close() triggers them),
 * but races that against a hard timeout so the process is guaranteed to
 * exit either way.
 */
function setupGracefulShutdown(app: { close: () => Promise<unknown> }): void {
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down...`);

    const forceExitTimer = setTimeout(() => {
      console.error(
        `Graceful shutdown did not finish within ${HARD_SHUTDOWN_TIMEOUT_MS}ms ` +
          '(most likely a dependency — e.g. Redis — not responding to a clean ' +
          'disconnect) — forcing exit.',
      );
      process.exit(1);
    }, HARD_SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    app
      .close()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error('Error during shutdown:', err);
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

async function bootstrap() {
  // Body parsing is off by default here so the Stripe webhook route can
  // get the raw Buffer it needs for signature verification — Nest's
  // automatic body parser would otherwise consume and JSON-parse it before
  // the controller ever sees the exact bytes Stripe signed.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  const config = app.get(ConfigService);

  // BullMQ workers hold open Redis connections and may be mid-job — this
  // gives them a chance to finish/release cleanly on SIGTERM (e.g. a
  // container orchestrator redeploying), with a hard timeout so a
  // dependency that won't close cleanly can't prevent the process from
  // ever exiting (see setupGracefulShutdown's doc comment).
  setupGracefulShutdown(app);

  // Without this, req.ip is whatever's on the raw TCP socket — the load
  // balancer's own address once this sits behind one, not the real client.
  // That's silently wrong in two places that matter: per-IP rate limiting
  // (ThrottlerGuard) would become one shared bucket for every user instead
  // of per-user, and RiskService's geo/impossible-travel signals would see
  // the same non-public IP for everyone. `1` trusts exactly one hop of
  // X-Forwarded-For — correct for the standard single-reverse-proxy shape
  // (Render/Railway/Fly/nginx in front of one Node process); adjust if the
  // real deployment topology ever has more hops than that.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cookieParser());

  // Must be registered before the generic JSON parser below — Express
  // matches middleware in registration order, so this specific path gets
  // the raw body while everything else still gets normal JSON parsing.
  app.use('/api/v1/webhooks/stripe', express.raw({ type: 'application/json' }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.enableCors({
    // `origin: false` (the previous value here) doesn't mean "no
    // production origin configured yet" — it means "disable CORS
    // entirely," which would have silently broken every request from the
    // Astro frontend the moment this went to production, since it's a
    // separate origin. FRONTEND_URL is already required config; use it.
    origin:
      config.get('NODE_ENV') === 'production'
        ? config.getOrThrow<string>('FRONTEND_URL')
        : true,
    credentials: true,
  });

  app.setGlobalPrefix('api/v1');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip properties not declared on the DTO
      forbidNonWhitelisted: true, // reject requests that include extra fields
      transform: true, // auto-convert payloads to their DTO class instances
    }),
  );

  if (config.get('NODE_ENV') !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('conference.contact API')
      .setDescription('Subscription SaaS backend')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = config.get<number>('PORT') ?? 3000;
  await app.listen(port);

  console.log(`API listening on http://localhost:${port}/api/v1`);
}
bootstrap().catch((err) => {
  console.error('Fatal error during bootstrap:', err);
  process.exit(1);
});
