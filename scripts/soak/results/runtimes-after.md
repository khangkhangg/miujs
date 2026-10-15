
| App (bun) | Conc | ops/s | p50 ms | p95 ms | p99 ms | Errors | RSS start / peak / end MB | Heap warm → end → settled MB | Growth end / settled | Leak? |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- |
| quiz | 40 | 236 | 6.36 | 30.20 | 94.00 | 0 | 39.2 / 61.5 / 61.3 | 3.7 → 4.7 → 1.2 | 27.8% / -67.3% | suspected |

| App (bun) | Conc | ops/s | p50 ms | p95 ms | p99 ms | Errors | RSS start / peak / end MB | Heap warm → end → settled MB | Growth end / settled | Leak? |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- |
| core | 64 | 69,951 | 0.90 | 1.18 | 1.70 | 0 | 37.2 / 52.5 / 44.7 | 0.7 → 0.6 → 0.6 | -11.0% / -18.3% | no |

| App (node) | Conc | ops/s | p50 ms | p95 ms | p99 ms | Errors | RSS start / peak / end MB | Heap warm → end → settled MB | Growth end / settled | Leak? |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- |
| core | 64 | 26,772 | 2.29 | 3.37 | 5.15 | 0 | 69.6 / 193.4 / 189.9 | 9.0 → 8.9 → 8.8 | -1.8% / -2.8% | no |

| App (deno) | Conc | ops/s | p50 ms | p95 ms | p99 ms | Errors | RSS start / peak / end MB | Heap warm → end → settled MB | Growth end / settled | Leak? |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- |
| core | 64 | 67,385 | 0.86 | 1.84 | 2.65 | 0 | 37.7 / 48.1 / 46.8 | 3.7 → 3.6 → 3.6 | -0.5% / -1.2% | no |
