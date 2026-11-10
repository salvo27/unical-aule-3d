import { handle, type WorkerEnv } from './handler.js';
import { MemoryCache } from './cache.js';

const memory = new MemoryCache();

export default {
  fetch: (request, env, ctx) =>
    handle(request, env, {
      fetch: (input, init) => fetch(input, init),
      cache: caches.default,
      memory,
      now: () => Date.now(),
      waitUntil: (p) => ctx.waitUntil(p),
      log: (line) => console.log(line),
    }),
} satisfies ExportedHandler<WorkerEnv>;
