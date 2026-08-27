import { buildApp } from './app.ts';

const port = Number(process.env.API_PORT ?? 3001);
const host = process.env.API_HOST ?? '0.0.0.0';

const app = buildApp({ logger: true, version: process.env.APP_VERSION ?? '0.0.0' });

await app.listen({ port, host });
