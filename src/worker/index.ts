import { serve, type CacheLike, type WorkerEnv } from './handler.js';
import { MemoryCache } from './cache.js';

const memory = new MemoryCache();
// The cinema programme changes a few times a week: its ticket office is read at most once an hour per isolate.
const slow = new MemoryCache({ ttlMs: 60 * 60_000, maxEntries: 4 });

// The Cache API may be missing or store nothing (*.pages.dev): then the memory cache alone keeps one call per 60 s.
function edgeCache(): CacheLike | null {
  try {
    return typeof caches === 'undefined' ? null : caches.default;
  } catch {
    return null;
  }
}

export default {
  fetch: (request, env, ctx) =>
    serve(request, env, {
      fetch: (input, init) => fetch(input, init),
      cache: edgeCache(),
      memory,
      slow,
      now: () => Date.now(),
      waitUntil: (p) => ctx.waitUntil(p),
      log: (line) => console.log(line),
    }),
} satisfies ExportedHandler<WorkerEnv>;
