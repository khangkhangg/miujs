import { expect, test } from "bun:test";
import { LIVE_JS, VIEWER_JS } from "../src/client.ts";

// The viewer and live scripts are inlined into <script> tags, so they must never close the tag
// or open an HTML comment.
test("inlined viewer scripts contain no </script or <!--", () => {
  for (const code of [VIEWER_JS, LIVE_JS]) expect(code).not.toMatch(/<\/script|<!--/i);
});
