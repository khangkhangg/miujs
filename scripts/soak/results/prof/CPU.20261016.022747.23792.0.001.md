# CPU Profile

| Duration | Samples | Interval | Functions |
|----------|---------|----------|----------|
| 15.42s | 732 | 1.0ms | 105 |

**Top 10:** `send` 51.7%, `diff` 6.2%, `applyCloned` 4.2%, `(anonymous)` 3.3%, `applyCloned` 3.3%, `diff` 3.2%, `(anonymous)` 2.3%, `checkState` 2.1%, `now` 1.7%, `heapStats` 1.4%

## Hot Functions (Self Time)

| Self% | Self | Total% | Total | Function | Location |
|------:|-----:|-------:|------:|----------|----------|
| 51.7% | 7.97s | 51.7% | 7.97s | `send` | `[native code]` |
| 6.2% | 969.5ms | 22.9% | 3.53s | `diff` | `C:\Projects\MiuJS-framework\packages\realtime\src\diff.ts:54` |
| 4.2% | 650.3ms | 4.2% | 650.3ms | `applyCloned` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:184` |
| 3.3% | 524.0ms | 3.5% | 539.9ms | `(anonymous)` | `C:\Projects\MiuJS-framework\packages\miujs\src\schema.ts:302` |
| 3.3% | 517.6ms | 4.3% | 676.1ms | `applyCloned` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:190` |
| 3.2% | 497.2ms | 3.2% | 497.2ms | `diff` | `C:\Projects\MiuJS-framework\packages\realtime\src\diff.ts:57` |
| 2.3% | 369.7ms | 2.3% | 369.7ms | `(anonymous)` | `C:\Projects\MiuJS-framework\packages\miujs\src\schema.ts:260` |
| 2.1% | 335.8ms | 2.1% | 335.8ms | `checkState` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:894` |
| 1.7% | 270.4ms | 1.7% | 270.4ms | `now` | `C:\Projects\MiuJS-framework\packages\realtime\src\clock.ts:12` |
| 1.4% | 230.0ms | 1.4% | 230.0ms | `heapStats` | `[native code]` |
| 1.3% | 215.0ms | 53.1% | 8.19s | `safeSend` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:1238` |
| 1.3% | 203.5ms | 1.6% | 247.4ms | `checkState` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:895` |
| 1.3% | 203.3ms | 1.3% | 203.3ms | `setKey` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:211` |
| 1.2% | 190.8ms | 1.2% | 190.8ms | `diff` | `C:\Projects\MiuJS-framework\packages\realtime\src\diff.ts:47` |
| 1.1% | 179.9ms | 1.1% | 179.9ms | `join` | `C:\Projects\MiuJS-framework\packages\miujs\src\schema.ts:64` |
| 1.0% | 158.6ms | 1.0% | 158.6ms | `cloneObject` | `[native code]` |
| 0.8% | 135.5ms | 0.8% | 135.5ms | `move` | `C:\Projects\MiuJS-framework\scripts\soak\games-server.ts:38` |
| 0.7% | 121.2ms | 0.7% | 121.2ms | `flush` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:928` |
| 0.7% | 109.7ms | 0.7% | 109.7ms | `(anonymous)` | `C:\Projects\MiuJS-framework\packages\miujs\src\schema.ts` |
| 0.7% | 108.0ms | 1.0% | 169.3ms | `receive` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:446` |
| 0.6% | 107.1ms | 0.6% | 107.1ms | `escape` | `C:\Projects\MiuJS-framework\packages\realtime\src\diff.ts:15` |
| 0.6% | 95.5ms | 0.6% | 96.5ms | `own` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:205` |
| 0.5% | 92.2ms | 0.5% | 92.2ms | `checkState` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:900` |
| 0.5% | 83.5ms | 0.5% | 83.5ms | `setTimeout` | `[native code]` |
| 0.5% | 78.1ms | 5.2% | 810.5ms | `flush` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:927` |
| 0.4% | 75.9ms | 1.2% | 192.0ms | `(anonymous)` | `C:\Projects\MiuJS-framework\packages\miujs\src\schema.ts:276` |
| 0.4% | 64.9ms | 0.4% | 64.9ms | `stringify` | `[native code]` |
| 0.4% | 63.8ms | 9.1% | 1.40s | `validate` | `C:\Projects\MiuJS-framework\packages\miujs\src\schema.ts:405` |
| 0.3% | 61.5ms | 0.3% | 61.5ms | `handle` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:782` |
| 0.3% | 61.3ms | 0.3% | 61.3ms | `unescapeSeg` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:215` |
| 0.3% | 61.2ms | 0.3% | 61.2ms | `parse` | `[native code]` |
| 0.3% | 58.8ms | 0.3% | 58.8ms | `handle` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:812` |
| 0.3% | 57.3ms | 0.3% | 57.3ms | `walk` | `C:\Projects\MiuJS-framework\packages\miujs\src\router.ts:150` |
| 0.3% | 47.6ms | 0.6% | 92.9ms | `diff` | `C:\Projects\MiuJS-framework\packages\realtime\src\diff.ts:65` |
| 0.2% | 45.7ms | 6.5% | 1.01s | `flushLazy` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:968` |
| 0.2% | 45.2ms | 0.2% | 45.2ms | `jsonEqual` | `C:\Projects\MiuJS-framework\packages\realtime\src\diff.ts:26` |
| 0.2% | 45.2ms | 0.2% | 45.2ms | `applyCloned` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts` |
| 0.2% | 43.6ms | 4.7% | 739.3ms | `(anonymous)` | `C:\Projects\MiuJS-framework\packages\miujs\src\schema.ts:301` |
| 0.2% | 41.3ms | 0.2% | 41.3ms | `(anonymous)` | `C:\Projects\MiuJS-framework\packages\miujs\src\schema.ts:252` |
| 0.2% | 32.9ms | 0.2% | 32.9ms | `diff` | `C:\Projects\MiuJS-framework\packages\realtime\src\diff.ts:51` |
| 0.1% | 29.0ms | 2.3% | 358.7ms | `run` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:837` |
| 0.1% | 17.2ms | 0.1% | 17.2ms | `Response` | `[native code]` |
| 0.1% | 17.2ms | 0.1% | 17.2ms | `diff` | `C:\Projects\MiuJS-framework\packages\realtime\src\diff.ts:48` |
| 0.1% | 15.8ms | 0.1% | 15.8ms | `then` | `[native code]` |
| 0.1% | 15.4ms | 0.1% | 15.4ms | `validate` | `C:\Projects\MiuJS-framework\packages\miujs\src\schema.ts` |
| 0.0% | 14.7ms | 53.5% | 8.25s | `flush` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:931` |
| 0.0% | 13.7ms | 0.0% | 13.7ms | `diff` | `C:\Projects\MiuJS-framework\packages\realtime\src\diff.ts` |
| 0.0% | 13.2ms | 0.0% | 13.2ms | `unref` | `[native code]` |
| 0.0% | 13.2ms | 0.0% | 13.2ms | `applyCloned` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:177` |
| 0.0% | 13.1ms | 0.0% | 13.1ms | `stop` | `[native code]` |
| 0.0% | 12.0ms | 11.2% | 1.73s | `commit` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:864` |
| 0.0% | 9.7ms | 0.0% | 9.7ms | `(module)` | `C:\Projects\MiuJS-framework\scripts\soak\games-server.ts:26` |
| 0.0% | 3.0ms | 0.0% | 3.0ms | `serve` | `[native code]` |
| 0.0% | 1.7ms | 0.0% | 1.7ms | `(module)` | `bun:main:14` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `compile` | `C:\Projects\MiuJS-framework\packages\miujs\src\app.ts` |
| 0.0% | 869us | 0.0% | 869us | `(anonymous)` | `C:\Projects\MiuJS-framework\packages\miujs\src\schema.ts:295` |

## Call Tree (Total Time)

| Total% | Total | Self% | Self | Function | Location |
|-------:|------:|------:|-----:|----------|----------|
| 60.9% | 9.40s | 0.0% | 0us | `(anonymous)` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:996` |
| 53.5% | 8.25s | 0.0% | 0us | `deliver` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:1160` |
| 53.5% | 8.25s | 0.0% | 14.7ms | `flush` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:931` |
| 53.1% | 8.19s | 1.3% | 215.0ms | `safeSend` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:1238` |
| 51.7% | 7.97s | 51.7% | 7.97s | `send` | `[native code]` |
| 36.5% | 5.64s | 0.0% | 0us | `message` | `C:\Projects\MiuJS-framework\packages\realtime\src\plugin.ts:234` |
| 36.5% | 5.64s | 0.0% | 0us | `message` | `C:\Projects\MiuJS-framework\packages\miujs\src\websocket.ts:90` |
| 31.9% | 4.92s | 0.0% | 0us | `run` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:843` |
| 22.9% | 3.53s | 6.2% | 969.5ms | `diff` | `C:\Projects\MiuJS-framework\packages\realtime\src\diff.ts:54` |
| 13.2% | 2.03s | 0.0% | 0us | `commit` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:865` |
| 11.2% | 1.73s | 0.0% | 12.0ms | `commit` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:864` |
| 9.1% | 1.40s | 0.4% | 63.8ms | `validate` | `C:\Projects\MiuJS-framework\packages\miujs\src\schema.ts:405` |
| 8.8% | 1.36s | 0.0% | 0us | `checkState` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:906` |
| 7.5% | 1.15s | 0.0% | 0us | `commit` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:879` |
| 6.5% | 1.01s | 0.2% | 45.7ms | `flushLazy` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:968` |
| 5.2% | 810.5ms | 0.5% | 78.1ms | `flush` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:927` |
| 4.7% | 739.3ms | 0.2% | 43.6ms | `(anonymous)` | `C:\Projects\MiuJS-framework\packages\miujs\src\schema.ts:301` |
| 4.3% | 676.1ms | 3.3% | 517.6ms | `applyCloned` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:190` |
| 4.2% | 650.3ms | 4.2% | 650.3ms | `applyCloned` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:184` |
| 3.5% | 539.9ms | 3.3% | 524.0ms | `(anonymous)` | `C:\Projects\MiuJS-framework\packages\miujs\src\schema.ts:302` |
| 3.2% | 497.2ms | 3.2% | 497.2ms | `diff` | `C:\Projects\MiuJS-framework\packages\realtime\src\diff.ts:57` |
| 2.4% | 376.4ms | 0.0% | 0us | `async fetch` | `C:\Projects\MiuJS-framework\scripts\soak\games-server.ts:105` |
| 2.3% | 369.7ms | 2.3% | 369.7ms | `(anonymous)` | `C:\Projects\MiuJS-framework\packages\miujs\src\schema.ts:260` |
| 2.3% | 358.7ms | 0.1% | 29.0ms | `run` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:837` |
| 2.1% | 335.8ms | 2.1% | 335.8ms | `checkState` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:894` |
| 2.1% | 329.7ms | 0.0% | 0us | `(anonymous)` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:812` |
| 1.7% | 270.4ms | 1.7% | 270.4ms | `now` | `C:\Projects\MiuJS-framework\packages\realtime\src\clock.ts:12` |
| 1.6% | 247.4ms | 1.3% | 203.5ms | `checkState` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:895` |
| 1.4% | 230.0ms | 1.4% | 230.0ms | `heapStats` | `[native code]` |
| 1.4% | 230.0ms | 0.0% | 0us | `mem` | `C:\Projects\MiuJS-framework\scripts\soak\games-server.ts:69` |
| 1.4% | 230.0ms | 0.0% | 0us | `async fetch` | `C:\Projects\MiuJS-framework\scripts\soak\games-server.ts:93` |
| 1.3% | 203.3ms | 1.3% | 203.3ms | `setKey` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:211` |
| 1.2% | 200.2ms | 0.0% | 0us | `flush` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:923` |
| 1.2% | 192.0ms | 0.4% | 75.9ms | `(anonymous)` | `C:\Projects\MiuJS-framework\packages\miujs\src\schema.ts:276` |
| 1.2% | 190.8ms | 1.2% | 190.8ms | `diff` | `C:\Projects\MiuJS-framework\packages\realtime\src\diff.ts:47` |
| 1.1% | 183.2ms | 0.0% | 0us | `receive` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:465` |
| 1.1% | 179.9ms | 1.1% | 179.9ms | `join` | `C:\Projects\MiuJS-framework\packages\miujs\src\schema.ts:64` |
| 1.0% | 169.3ms | 0.7% | 108.0ms | `receive` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:446` |
| 1.0% | 158.6ms | 1.0% | 158.6ms | `cloneObject` | `[native code]` |
| 1.0% | 157.6ms | 0.0% | 0us | `own` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:204` |
| 0.9% | 146.4ms | 0.0% | 0us | `applyCloned` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:196` |
| 0.8% | 135.5ms | 0.8% | 135.5ms | `move` | `C:\Projects\MiuJS-framework\scripts\soak\games-server.ts:38` |
| 0.7% | 121.2ms | 0.7% | 121.2ms | `flush` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:928` |
| 0.7% | 109.7ms | 0.7% | 109.7ms | `(anonymous)` | `C:\Projects\MiuJS-framework\packages\miujs\src\schema.ts` |
| 0.6% | 107.1ms | 0.6% | 107.1ms | `escape` | `C:\Projects\MiuJS-framework\packages\realtime\src\diff.ts:15` |
| 0.6% | 96.5ms | 0.6% | 95.5ms | `own` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:205` |
| 0.6% | 95.7ms | 0.0% | 0us | `applyCloned` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:187` |
| 0.6% | 92.9ms | 0.3% | 47.6ms | `diff` | `C:\Projects\MiuJS-framework\packages\realtime\src\diff.ts:65` |
| 0.5% | 92.2ms | 0.5% | 92.2ms | `checkState` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:900` |
| 0.5% | 83.5ms | 0.0% | 0us | `flushLazy` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:994` |
| 0.5% | 83.5ms | 0.5% | 83.5ms | `setTimeout` | `[native code]` |
| 0.4% | 64.9ms | 0.4% | 64.9ms | `stringify` | `[native code]` |
| 0.4% | 64.9ms | 0.0% | 0us | `encodeFrame` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:235` |
| 0.4% | 62.8ms | 0.0% | 0us | `handle` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:797` |
| 0.3% | 61.5ms | 0.3% | 61.5ms | `handle` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:782` |
| 0.3% | 61.3ms | 0.3% | 61.3ms | `unescapeSeg` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:215` |
| 0.3% | 61.2ms | 0.3% | 61.2ms | `parse` | `[native code]` |
| 0.3% | 58.8ms | 0.3% | 58.8ms | `handle` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:812` |
| 0.3% | 57.3ms | 0.0% | 0us | `walk` | `C:\Projects\MiuJS-framework\packages\miujs\src\router.ts:173` |
| 0.3% | 57.3ms | 0.0% | 0us | `dispatchCore` | `C:\Projects\MiuJS-framework\packages\miujs\src\app.ts:643` |
| 0.3% | 57.3ms | 0.0% | 0us | `walk` | `C:\Projects\MiuJS-framework\packages\miujs\src\router.ts:168` |
| 0.3% | 57.3ms | 0.3% | 57.3ms | `walk` | `C:\Projects\MiuJS-framework\packages\miujs\src\router.ts:150` |
| 0.3% | 56.8ms | 0.0% | 0us | `applyCloned` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:191` |
| 0.3% | 47.1ms | 0.0% | 0us | `callHandler` | `C:\Projects\MiuJS-framework\packages\miujs\src\app.ts:428` |
| 0.3% | 47.1ms | 0.0% | 0us | `async routeWithHooks` | `C:\Projects\MiuJS-framework\packages\miujs\src\app.ts:683` |
| 0.3% | 47.1ms | 0.0% | 0us | `runMatch` | `C:\Projects\MiuJS-framework\packages\miujs\src\app.ts:688` |
| 0.2% | 45.7ms | 0.0% | 0us | `flushLazy` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:963` |
| 0.2% | 45.2ms | 0.2% | 45.2ms | `jsonEqual` | `C:\Projects\MiuJS-framework\packages\realtime\src\diff.ts:26` |
| 0.2% | 45.2ms | 0.2% | 45.2ms | `applyCloned` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts` |
| 0.2% | 41.3ms | 0.2% | 41.3ms | `(anonymous)` | `C:\Projects\MiuJS-framework\packages\miujs\src\schema.ts:252` |
| 0.2% | 32.9ms | 0.2% | 32.9ms | `diff` | `C:\Projects\MiuJS-framework\packages\realtime\src\diff.ts:51` |
| 0.1% | 30.5ms | 0.0% | 0us | `admit` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:1196` |
| 0.1% | 30.5ms | 0.0% | 0us | `receive` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:429` |
| 0.1% | 29.8ms | 0.0% | 0us | `connect` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:380` |
| 0.1% | 29.8ms | 0.0% | 0us | `open` | `C:\Projects\MiuJS-framework\packages\miujs\src\websocket.ts:86` |
| 0.1% | 29.8ms | 0.0% | 0us | `upgrade` | `C:\Projects\MiuJS-framework\packages\miujs\src\websocket.ts:136` |
| 0.1% | 29.8ms | 0.0% | 0us | `open` | `C:\Projects\MiuJS-framework\packages\realtime\src\plugin.ts:231` |
| 0.1% | 29.8ms | 0.0% | 0us | `upgrade` | `[native code]` |
| 0.1% | 29.8ms | 0.0% | 0us | `join` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:736` |
| 0.1% | 17.2ms | 0.1% | 17.2ms | `Response` | `[native code]` |
| 0.1% | 17.2ms | 0.0% | 0us | `upgrade` | `C:\Projects\MiuJS-framework\packages\miujs\src\websocket.ts:141` |
| 0.1% | 17.2ms | 0.1% | 17.2ms | `diff` | `C:\Projects\MiuJS-framework\packages\realtime\src\diff.ts:48` |
| 0.1% | 15.8ms | 0.1% | 15.8ms | `then` | `[native code]` |
| 0.1% | 15.5ms | 0.0% | 0us | `applyCloned` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:194` |
| 0.1% | 15.4ms | 0.1% | 15.4ms | `validate` | `C:\Projects\MiuJS-framework\packages\miujs\src\schema.ts` |
| 0.0% | 15.0ms | 0.0% | 0us | `flush` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:946` |
| 0.0% | 13.7ms | 0.0% | 13.7ms | `diff` | `C:\Projects\MiuJS-framework\packages\realtime\src\diff.ts` |
| 0.0% | 13.2ms | 0.0% | 0us | `setTimerRef` | `C:\Projects\MiuJS-framework\packages\realtime\src\clock.ts:24` |
| 0.0% | 13.2ms | 0.0% | 0us | `flushLazy` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:999` |
| 0.0% | 13.2ms | 0.0% | 13.2ms | `unref` | `[native code]` |
| 0.0% | 13.2ms | 0.0% | 13.2ms | `applyCloned` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:177` |
| 0.0% | 13.1ms | 0.0% | 13.1ms | `stop` | `[native code]` |
| 0.0% | 13.1ms | 0.0% | 0us | `async (anonymous)` | `C:\Projects\MiuJS-framework\scripts\soak\games-server.ts:100` |
| 0.0% | 13.1ms | 0.0% | 0us | `async (anonymous)` | `C:\Projects\MiuJS-framework\scripts\soak\games-server.ts:101` |
| 0.0% | 9.7ms | 0.0% | 9.7ms | `(module)` | `C:\Projects\MiuJS-framework\scripts\soak\games-server.ts:26` |
| 0.0% | 3.0ms | 0.0% | 3.0ms | `serve` | `[native code]` |
| 0.0% | 3.0ms | 0.0% | 0us | `(module)` | `C:\Projects\MiuJS-framework\scripts\soak\games-server.ts:86` |
| 0.0% | 1.8ms | 0.0% | 0us | `applyCloned` | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:189` |
| 0.0% | 1.7ms | 0.0% | 1.7ms | `(module)` | `bun:main:14` |
| 0.0% | 1.0ms | 0.0% | 0us | `async init` | `C:\Projects\MiuJS-framework\packages\miujs\src\app.ts:370` |
| 0.0% | 1.0ms | 0.0% | 0us | `ready` | `C:\Projects\MiuJS-framework\packages\miujs\src\app.ts:313` |
| 0.0% | 1.0ms | 0.0% | 0us | `(module)` | `C:\Projects\MiuJS-framework\scripts\soak\games-server.ts:53` |
| 0.0% | 1.0ms | 0.0% | 0us | `async init` | `C:\Projects\MiuJS-framework\packages\miujs\src\app.ts:349` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `compile` | `C:\Projects\MiuJS-framework\packages\miujs\src\app.ts` |
| 0.0% | 869us | 0.0% | 869us | `(anonymous)` | `C:\Projects\MiuJS-framework\packages\miujs\src\schema.ts:295` |

## Function Details

### `send`
`[native code]` | Self: 51.7% (7.97s) | Total: 51.7% (7.97s) | Samples: 366

**Called by:**
- `safeSend` (366)

### `diff`
`C:\Projects\MiuJS-framework\packages\realtime\src\diff.ts:54` | Self: 6.2% (969.5ms) | Total: 22.9% (3.53s) | Samples: 40

**Called by:**
- `diff` (85)
- `commit` (82)
- `flush` (13)

**Calls:**
- `diff` (85)
- `diff` (23)
- `diff` (13)
- `escape` (6)
- `diff` (5)
- `diff` (5)
- `diff` (2)
- `diff` (1)

### `applyCloned`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:184` | Self: 4.2% (650.3ms) | Total: 4.2% (650.3ms) | Samples: 28

**Called by:**
- `flushLazy` (17)
- `flush` (11)

### `(anonymous)`
`C:\Projects\MiuJS-framework\packages\miujs\src\schema.ts:302` | Self: 3.3% (524.0ms) | Total: 3.5% (539.9ms) | Samples: 28

**Called by:**
- `validate` (30)

**Calls:**
- `(anonymous)` (2)

### `applyCloned`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:190` | Self: 3.3% (517.6ms) | Total: 4.3% (676.1ms) | Samples: 22

**Called by:**
- `flush` (16)
- `flushLazy` (14)

**Calls:**
- `own` (5)
- `own` (3)

### `diff`
`C:\Projects\MiuJS-framework\packages\realtime\src\diff.ts:57` | Self: 3.2% (497.2ms) | Total: 3.2% (497.2ms) | Samples: 26

**Called by:**
- `diff` (23)
- `commit` (3)

### `(anonymous)`
`C:\Projects\MiuJS-framework\packages\miujs\src\schema.ts:260` | Self: 2.3% (369.7ms) | Total: 2.3% (369.7ms) | Samples: 26

**Called by:**
- `(anonymous)` (24)
- `(anonymous)` (2)

### `checkState`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:894` | Self: 2.1% (335.8ms) | Total: 2.1% (335.8ms) | Samples: 10

**Called by:**
- `commit` (10)

### `now`
`C:\Projects\MiuJS-framework\packages\realtime\src\clock.ts:12` | Self: 1.7% (270.4ms) | Total: 1.7% (270.4ms) | Samples: 9

**Called by:**
- `(anonymous)` (6)
- `flushLazy` (2)
- `admit` (1)

### `heapStats`
`[native code]` | Self: 1.4% (230.0ms) | Total: 1.4% (230.0ms) | Samples: 4

**Called by:**
- `mem` (4)

### `safeSend`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:1238` | Self: 1.3% (215.0ms) | Total: 53.1% (8.19s) | Samples: 8

**Called by:**
- `deliver` (374)

**Calls:**
- `send` (366)

### `checkState`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:895` | Self: 1.3% (203.5ms) | Total: 1.6% (247.4ms) | Samples: 13

**Called by:**
- `commit` (16)

**Calls:**
- `unescapeSeg` (3)

### `setKey`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:211` | Self: 1.3% (203.3ms) | Total: 1.3% (203.3ms) | Samples: 8

**Called by:**
- `applyCloned` (6)
- `applyCloned` (2)

### `diff`
`C:\Projects\MiuJS-framework\packages\realtime\src\diff.ts:47` | Self: 1.2% (190.8ms) | Total: 1.2% (190.8ms) | Samples: 14

**Called by:**
- `diff` (13)
- `commit` (1)

### `join`
`C:\Projects\MiuJS-framework\packages\miujs\src\schema.ts:64` | Self: 1.1% (179.9ms) | Total: 1.1% (179.9ms) | Samples: 10

**Called by:**
- `(anonymous)` (8)
- `(anonymous)` (2)

### `cloneObject`
`[native code]` | Self: 1.0% (158.6ms) | Total: 1.0% (158.6ms) | Samples: 8

**Called by:**
- `own` (7)
- `own` (1)

### `move`
`C:\Projects\MiuJS-framework\scripts\soak\games-server.ts:38` | Self: 0.8% (135.5ms) | Total: 0.8% (135.5ms) | Samples: 6

**Called by:**
- `(anonymous)` (6)

### `flush`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:928` | Self: 0.7% (121.2ms) | Total: 0.7% (121.2ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\Projects\MiuJS-framework\packages\miujs\src\schema.ts` | Self: 0.7% (109.7ms) | Total: 0.7% (109.7ms) | Samples: 6

**Called by:**
- `(anonymous)` (3)
- `validate` (3)

### `receive`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:446` | Self: 0.7% (108.0ms) | Total: 1.0% (169.3ms) | Samples: 2

**Called by:**
- `message` (4)

**Calls:**
- `parse` (2)

### `escape`
`C:\Projects\MiuJS-framework\packages\realtime\src\diff.ts:15` | Self: 0.6% (107.1ms) | Total: 0.6% (107.1ms) | Samples: 6

**Called by:**
- `diff` (6)

### `own`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:205` | Self: 0.6% (95.5ms) | Total: 0.6% (96.5ms) | Samples: 6

**Called by:**
- `applyCloned` (4)
- `applyCloned` (3)

**Calls:**
- `cloneObject` (1)

### `checkState`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:900` | Self: 0.5% (92.2ms) | Total: 0.5% (92.2ms) | Samples: 8

**Called by:**
- `commit` (8)

### `setTimeout`
`[native code]` | Self: 0.5% (83.5ms) | Total: 0.5% (83.5ms) | Samples: 6

**Called by:**
- `flushLazy` (6)

### `flush`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:927` | Self: 0.5% (78.1ms) | Total: 5.2% (810.5ms) | Samples: 5

**Called by:**
- `(anonymous)` (35)

**Calls:**
- `applyCloned` (16)
- `applyCloned` (11)
- `applyCloned` (2)
- `applyCloned` (1)

### `(anonymous)`
`C:\Projects\MiuJS-framework\packages\miujs\src\schema.ts:276` | Self: 0.4% (75.9ms) | Total: 1.2% (192.0ms) | Samples: 3

**Called by:**
- `(anonymous)` (11)

**Calls:**
- `join` (8)

### `stringify`
`[native code]` | Self: 0.4% (64.9ms) | Total: 0.4% (64.9ms) | Samples: 6

**Called by:**
- `encodeFrame` (6)

### `validate`
`C:\Projects\MiuJS-framework\packages\miujs\src\schema.ts:405` | Self: 0.4% (63.8ms) | Total: 9.1% (1.40s) | Samples: 4

**Called by:**
- `checkState` (80)
- `handle` (3)

**Calls:**
- `(anonymous)` (45)
- `(anonymous)` (30)
- `(anonymous)` (3)
- `(anonymous)` (1)

### `handle`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:782` | Self: 0.3% (61.5ms) | Total: 0.3% (61.5ms) | Samples: 2

**Called by:**
- `receive` (2)

### `unescapeSeg`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:215` | Self: 0.3% (61.3ms) | Total: 0.3% (61.3ms) | Samples: 5

**Called by:**
- `checkState` (3)
- `applyCloned` (1)
- `applyCloned` (1)

### `parse`
`[native code]` | Self: 0.3% (61.2ms) | Total: 0.3% (61.2ms) | Samples: 2

**Called by:**
- `receive` (2)

### `handle`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:812` | Self: 0.3% (58.8ms) | Total: 0.3% (58.8ms) | Samples: 3

**Called by:**
- `receive` (3)

### `walk`
`C:\Projects\MiuJS-framework\packages\miujs\src\router.ts:150` | Self: 0.3% (57.3ms) | Total: 0.3% (57.3ms) | Samples: 1

**Called by:**
- `walk` (1)

### `diff`
`C:\Projects\MiuJS-framework\packages\realtime\src\diff.ts:65` | Self: 0.3% (47.6ms) | Total: 0.6% (92.9ms) | Samples: 4

**Called by:**
- `diff` (5)

**Calls:**
- `jsonEqual` (1)

### `flushLazy`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:968` | Self: 0.2% (45.7ms) | Total: 6.5% (1.01s) | Samples: 2

**Called by:**
- `commit` (48)

**Calls:**
- `applyCloned` (17)
- `applyCloned` (14)
- `applyCloned` (6)
- `applyCloned` (4)
- `applyCloned` (2)
- `applyCloned` (1)
- `applyCloned` (1)
- `applyCloned` (1)

### `jsonEqual`
`C:\Projects\MiuJS-framework\packages\realtime\src\diff.ts:26` | Self: 0.2% (45.2ms) | Total: 0.2% (45.2ms) | Samples: 1

**Called by:**
- `diff` (1)

### `applyCloned`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts` | Self: 0.2% (45.2ms) | Total: 0.2% (45.2ms) | Samples: 1

**Called by:**
- `flushLazy` (1)

### `(anonymous)`
`C:\Projects\MiuJS-framework\packages\miujs\src\schema.ts:301` | Self: 0.2% (43.6ms) | Total: 4.7% (739.3ms) | Samples: 2

**Called by:**
- `validate` (45)

**Calls:**
- `(anonymous)` (24)
- `(anonymous)` (11)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `join` (2)

### `(anonymous)`
`C:\Projects\MiuJS-framework\packages\miujs\src\schema.ts:252` | Self: 0.2% (41.3ms) | Total: 0.2% (41.3ms) | Samples: 3

**Called by:**
- `(anonymous)` (3)

### `diff`
`C:\Projects\MiuJS-framework\packages\realtime\src\diff.ts:51` | Self: 0.2% (32.9ms) | Total: 0.2% (32.9ms) | Samples: 6

**Called by:**
- `diff` (5)
- `commit` (1)

### `run`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:837` | Self: 0.1% (29.0ms) | Total: 2.3% (358.7ms) | Samples: 1

**Called by:**
- `message` (13)

**Calls:**
- `(anonymous)` (12)

### `Response`
`[native code]` | Self: 0.1% (17.2ms) | Total: 0.1% (17.2ms) | Samples: 1

**Called by:**
- `upgrade` (1)

### `diff`
`C:\Projects\MiuJS-framework\packages\realtime\src\diff.ts:48` | Self: 0.1% (17.2ms) | Total: 0.1% (17.2ms) | Samples: 2

**Called by:**
- `diff` (2)

### `then`
`[native code]` | Self: 0.1% (15.8ms) | Total: 0.1% (15.8ms) | Samples: 1

**Called by:**
- `async fetch` (1)

### `validate`
`C:\Projects\MiuJS-framework\packages\miujs\src\schema.ts` | Self: 0.1% (15.4ms) | Total: 0.1% (15.4ms) | Samples: 1

**Called by:**
- `checkState` (1)

### `flush`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:931` | Self: 0.0% (14.7ms) | Total: 53.5% (8.25s) | Samples: 1

**Called by:**
- `(anonymous)` (380)

**Calls:**
- `deliver` (379)

### `diff`
`C:\Projects\MiuJS-framework\packages\realtime\src\diff.ts` | Self: 0.0% (13.7ms) | Total: 0.0% (13.7ms) | Samples: 2

**Called by:**
- `commit` (1)
- `diff` (1)

### `unref`
`[native code]` | Self: 0.0% (13.2ms) | Total: 0.0% (13.2ms) | Samples: 1

**Called by:**
- `setTimerRef` (1)

### `applyCloned`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:177` | Self: 0.0% (13.2ms) | Total: 0.0% (13.2ms) | Samples: 1

**Called by:**
- `flushLazy` (1)

### `stop`
`[native code]` | Self: 0.0% (13.1ms) | Total: 0.0% (13.1ms) | Samples: 1

**Called by:**
- `async (anonymous)` (1)

### `commit`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:864` | Self: 0.0% (12.0ms) | Total: 11.2% (1.73s) | Samples: 1

**Called by:**
- `run` (89)

**Calls:**
- `diff` (82)
- `diff` (3)
- `diff` (1)
- `diff` (1)
- `diff` (1)

### `(module)`
`C:\Projects\MiuJS-framework\scripts\soak\games-server.ts:26` | Self: 0.0% (9.7ms) | Total: 0.0% (9.7ms) | Samples: 1

### `serve`
`[native code]` | Self: 0.0% (3.0ms) | Total: 0.0% (3.0ms) | Samples: 3

**Called by:**
- `(module)` (3)

### `(module)`
`bun:main:14` | Self: 0.0% (1.7ms) | Total: 0.0% (1.7ms) | Samples: 2

### `compile`
`C:\Projects\MiuJS-framework\packages\miujs\src\app.ts` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `async init` (1)

### `(anonymous)`
`C:\Projects\MiuJS-framework\packages\miujs\src\schema.ts:295` | Self: 0.0% (869us) | Total: 0.0% (869us) | Samples: 1

**Called by:**
- `validate` (1)

### `checkState`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:906` | Self: 0.0% (0us) | Total: 8.8% (1.36s) | Samples: 0

**Called by:**
- `commit` (81)

**Calls:**
- `validate` (80)
- `validate` (1)

### `receive`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:429` | Self: 0.0% (0us) | Total: 0.1% (30.5ms) | Samples: 0

**Called by:**
- `message` (1)

**Calls:**
- `admit` (1)

### `async fetch`
`C:\Projects\MiuJS-framework\scripts\soak\games-server.ts:93` | Self: 0.0% (0us) | Total: 1.4% (230.0ms) | Samples: 0

**Called by:**
- `async fetch` (4)

**Calls:**
- `mem` (4)

### `flushLazy`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:994` | Self: 0.0% (0us) | Total: 0.5% (83.5ms) | Samples: 0

**Called by:**
- `commit` (6)

**Calls:**
- `setTimeout` (6)

### `applyCloned`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:187` | Self: 0.0% (0us) | Total: 0.6% (95.7ms) | Samples: 0

**Called by:**
- `flushLazy` (6)

**Calls:**
- `own` (4)
- `own` (2)

### `applyCloned`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:191` | Self: 0.0% (0us) | Total: 0.3% (56.8ms) | Samples: 0

**Called by:**
- `flushLazy` (2)

**Calls:**
- `setKey` (2)

### `encodeFrame`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:235` | Self: 0.0% (0us) | Total: 0.4% (64.9ms) | Samples: 0

**Called by:**
- `deliver` (6)

**Calls:**
- `stringify` (6)

### `commit`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:865` | Self: 0.0% (0us) | Total: 13.2% (2.03s) | Samples: 0

**Called by:**
- `run` (115)

**Calls:**
- `checkState` (81)
- `checkState` (16)
- `checkState` (10)
- `checkState` (8)

### `flushLazy`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:963` | Self: 0.0% (0us) | Total: 0.2% (45.7ms) | Samples: 0

**Called by:**
- `commit` (2)

**Calls:**
- `now` (2)

### `applyCloned`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:194` | Self: 0.0% (0us) | Total: 0.1% (15.5ms) | Samples: 0

**Called by:**
- `flushLazy` (1)

**Calls:**
- `unescapeSeg` (1)

### `flush`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:946` | Self: 0.0% (0us) | Total: 0.0% (15.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `deliver` (1)

### `message`
`C:\Projects\MiuJS-framework\packages\miujs\src\websocket.ts:90` | Self: 0.0% (0us) | Total: 36.5% (5.64s) | Samples: 0

**Calls:**
- `message` (284)

### `(module)`
`C:\Projects\MiuJS-framework\scripts\soak\games-server.ts:86` | Self: 0.0% (0us) | Total: 0.0% (3.0ms) | Samples: 0

**Calls:**
- `serve` (3)

### `async fetch`
`C:\Projects\MiuJS-framework\scripts\soak\games-server.ts:105` | Self: 0.0% (0us) | Total: 2.4% (376.4ms) | Samples: 0

**Called by:**
- `async fetch` (2)

**Calls:**
- `async fetch` (4)
- `async fetch` (2)
- `dispatchCore` (1)
- `then` (1)

### `async init`
`C:\Projects\MiuJS-framework\packages\miujs\src\app.ts:349` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `async init` (1)

**Calls:**
- `compile` (1)

### `admit`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:1196` | Self: 0.0% (0us) | Total: 0.1% (30.5ms) | Samples: 0

**Called by:**
- `receive` (1)

**Calls:**
- `now` (1)

### `receive`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:465` | Self: 0.0% (0us) | Total: 1.1% (183.2ms) | Samples: 0

**Called by:**
- `message` (8)

**Calls:**
- `handle` (3)
- `handle` (3)
- `handle` (2)

### `async (anonymous)`
`C:\Projects\MiuJS-framework\scripts\soak\games-server.ts:101` | Self: 0.0% (0us) | Total: 0.0% (13.1ms) | Samples: 0

**Calls:**
- `async (anonymous)` (1)

### `connect`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:380` | Self: 0.0% (0us) | Total: 0.1% (29.8ms) | Samples: 0

**Called by:**
- `open` (3)

**Calls:**
- `join` (3)

### `mem`
`C:\Projects\MiuJS-framework\scripts\soak\games-server.ts:69` | Self: 0.0% (0us) | Total: 1.4% (230.0ms) | Samples: 0

**Called by:**
- `async fetch` (4)

**Calls:**
- `heapStats` (4)

### `deliver`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:1160` | Self: 0.0% (0us) | Total: 53.5% (8.25s) | Samples: 0

**Called by:**
- `flush` (379)
- `flush` (1)

**Calls:**
- `safeSend` (374)
- `encodeFrame` (6)

### `(anonymous)`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:996` | Self: 0.0% (0us) | Total: 60.9% (9.40s) | Samples: 0

**Calls:**
- `flush` (380)
- `flush` (35)
- `flush` (13)
- `flush` (1)
- `flush` (1)

### `message`
`C:\Projects\MiuJS-framework\packages\realtime\src\plugin.ts:234` | Self: 0.0% (0us) | Total: 36.5% (5.64s) | Samples: 0

**Called by:**
- `message` (284)

**Calls:**
- `run` (258)
- `run` (13)
- `receive` (8)
- `receive` (4)
- `receive` (1)

### `applyCloned`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:196` | Self: 0.0% (0us) | Total: 0.9% (146.4ms) | Samples: 0

**Called by:**
- `flushLazy` (4)
- `flush` (2)

**Calls:**
- `setKey` (6)

### `upgrade`
`[native code]` | Self: 0.0% (0us) | Total: 0.1% (29.8ms) | Samples: 0

**Called by:**
- `upgrade` (3)

**Calls:**
- `open` (3)

### `walk`
`C:\Projects\MiuJS-framework\packages\miujs\src\router.ts:168` | Self: 0.0% (0us) | Total: 0.3% (57.3ms) | Samples: 0

**Called by:**
- `dispatchCore` (1)

**Calls:**
- `walk` (1)

### `dispatchCore`
`C:\Projects\MiuJS-framework\packages\miujs\src\app.ts:643` | Self: 0.0% (0us) | Total: 0.3% (57.3ms) | Samples: 0

**Called by:**
- `async fetch` (1)

**Calls:**
- `walk` (1)

### `applyCloned`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:189` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Called by:**
- `flush` (1)

**Calls:**
- `unescapeSeg` (1)

### `async init`
`C:\Projects\MiuJS-framework\packages\miujs\src\app.ts:370` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `ready` (1)

**Calls:**
- `async init` (1)

### `callHandler`
`C:\Projects\MiuJS-framework\packages\miujs\src\app.ts:428` | Self: 0.0% (0us) | Total: 0.3% (47.1ms) | Samples: 0

**Called by:**
- `runMatch` (4)

**Calls:**
- `upgrade` (3)
- `upgrade` (1)

### `setTimerRef`
`C:\Projects\MiuJS-framework\packages\realtime\src\clock.ts:24` | Self: 0.0% (0us) | Total: 0.0% (13.2ms) | Samples: 0

**Called by:**
- `flushLazy` (1)

**Calls:**
- `unref` (1)

### `handle`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:797` | Self: 0.0% (0us) | Total: 0.4% (62.8ms) | Samples: 0

**Called by:**
- `receive` (3)

**Calls:**
- `validate` (3)

### `(module)`
`C:\Projects\MiuJS-framework\scripts\soak\games-server.ts:53` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Calls:**
- `ready` (1)

### `async routeWithHooks`
`C:\Projects\MiuJS-framework\packages\miujs\src\app.ts:683` | Self: 0.0% (0us) | Total: 0.3% (47.1ms) | Samples: 0

**Calls:**
- `runMatch` (4)

### `async (anonymous)`
`C:\Projects\MiuJS-framework\scripts\soak\games-server.ts:100` | Self: 0.0% (0us) | Total: 0.0% (13.1ms) | Samples: 0

**Called by:**
- `async (anonymous)` (1)

**Calls:**
- `stop` (1)

### `upgrade`
`C:\Projects\MiuJS-framework\packages\miujs\src\websocket.ts:141` | Self: 0.0% (0us) | Total: 0.1% (17.2ms) | Samples: 0

**Called by:**
- `callHandler` (1)

**Calls:**
- `Response` (1)

### `flush`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:923` | Self: 0.0% (0us) | Total: 1.2% (200.2ms) | Samples: 0

**Called by:**
- `(anonymous)` (13)

**Calls:**
- `diff` (13)

### `flushLazy`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:999` | Self: 0.0% (0us) | Total: 0.0% (13.2ms) | Samples: 0

**Called by:**
- `commit` (1)

**Calls:**
- `setTimerRef` (1)

### `open`
`C:\Projects\MiuJS-framework\packages\realtime\src\plugin.ts:231` | Self: 0.0% (0us) | Total: 0.1% (29.8ms) | Samples: 0

**Called by:**
- `open` (3)

**Calls:**
- `connect` (3)

### `(anonymous)`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:812` | Self: 0.0% (0us) | Total: 2.1% (329.7ms) | Samples: 0

**Called by:**
- `run` (12)

**Calls:**
- `move` (6)
- `now` (6)

### `own`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:204` | Self: 0.0% (0us) | Total: 1.0% (157.6ms) | Samples: 0

**Called by:**
- `applyCloned` (5)
- `applyCloned` (2)

**Calls:**
- `cloneObject` (7)

### `commit`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:879` | Self: 0.0% (0us) | Total: 7.5% (1.15s) | Samples: 0

**Called by:**
- `run` (57)

**Calls:**
- `flushLazy` (48)
- `flushLazy` (6)
- `flushLazy` (2)
- `flushLazy` (1)

### `open`
`C:\Projects\MiuJS-framework\packages\miujs\src\websocket.ts:86` | Self: 0.0% (0us) | Total: 0.1% (29.8ms) | Samples: 0

**Called by:**
- `upgrade` (3)

**Calls:**
- `open` (3)

### `upgrade`
`C:\Projects\MiuJS-framework\packages\miujs\src\websocket.ts:136` | Self: 0.0% (0us) | Total: 0.1% (29.8ms) | Samples: 0

**Called by:**
- `callHandler` (3)

**Calls:**
- `upgrade` (3)

### `ready`
`C:\Projects\MiuJS-framework\packages\miujs\src\app.ts:313` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `async init` (1)

### `run`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:843` | Self: 0.0% (0us) | Total: 31.9% (4.92s) | Samples: 0

**Called by:**
- `message` (258)
- `join` (3)

**Calls:**
- `commit` (115)
- `commit` (89)
- `commit` (57)

### `walk`
`C:\Projects\MiuJS-framework\packages\miujs\src\router.ts:173` | Self: 0.0% (0us) | Total: 0.3% (57.3ms) | Samples: 0

**Called by:**
- `walk` (1)

**Calls:**
- `walk` (1)

### `runMatch`
`C:\Projects\MiuJS-framework\packages\miujs\src\app.ts:688` | Self: 0.0% (0us) | Total: 0.3% (47.1ms) | Samples: 0

**Called by:**
- `async routeWithHooks` (4)

**Calls:**
- `callHandler` (4)

### `join`
`C:\Projects\MiuJS-framework\packages\realtime\src\room.ts:736` | Self: 0.0% (0us) | Total: 0.1% (29.8ms) | Samples: 0

**Called by:**
- `connect` (3)

**Calls:**
- `run` (3)

## Files

| Self% | Self | File |
|------:|-----:|------|
| 56.0% | 8.63s | `[native code]` |
| 19.2% | 2.96s | `C:\Projects\MiuJS-framework\packages\realtime\src\room.ts` |
| 12.4% | 1.92s | `C:\Projects\MiuJS-framework\packages\realtime\src\diff.ts` |
| 9.2% | 1.42s | `C:\Projects\MiuJS-framework\packages\miujs\src\schema.ts` |
| 1.7% | 270.4ms | `C:\Projects\MiuJS-framework\packages\realtime\src\clock.ts` |
| 0.9% | 145.2ms | `C:\Projects\MiuJS-framework\scripts\soak\games-server.ts` |
| 0.3% | 57.3ms | `C:\Projects\MiuJS-framework\packages\miujs\src\router.ts` |
| 0.0% | 1.7ms | `bun:main` |
| 0.0% | 1.0ms | `C:\Projects\MiuJS-framework\packages\miujs\src\app.ts` |
