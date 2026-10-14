// Load generator worker: N concurrent fetch loops against one URL for D seconds.
// Usage: bun load.ts '<json config>'  ->  prints {"count":n,"errors":n}
interface Config {
  url: string;
  method: string;
  body?: string;
  concurrency: number;
  seconds: number;
}

const cfg = JSON.parse(process.argv[2]!) as Config;
const init: RequestInit = {
  method: cfg.method,
  headers: cfg.body ? { "content-type": "application/json" } : undefined,
  body: cfg.body,
};
let count = 0;
let errors = 0;
const end = performance.now() + cfg.seconds * 1000;

async function loop() {
  while (performance.now() < end) {
    try {
      const res = await fetch(cfg.url, init);
      await res.arrayBuffer();
      if (res.status === 200) count++;
      else errors++;
    } catch {
      errors++;
    }
  }
}

await Promise.all(Array.from({ length: cfg.concurrency }, loop));
console.log(JSON.stringify({ count, errors }));
