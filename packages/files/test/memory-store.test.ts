import { describe } from "bun:test";
import { memoryStore } from "../src/memory.ts";
import { storeSuite } from "./store-suite.ts";

describe("memoryStore", () => {
  storeSuite(() => memoryStore());
});
