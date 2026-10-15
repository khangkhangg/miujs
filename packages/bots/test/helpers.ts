// Requests as browsers and Cloudflare send them, shared by the tests.

export const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
export const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";
export const BROWSER_HEADERS = { "user-agent": CHROME, "accept-language": "en-US,en;q=0.9", "sec-fetch-mode": "navigate", "sec-fetch-site": "none", accept: "text/html" };

/** A request as Cloudflare delivers it to a Worker: `request.cf` set by the platform. */
export function cfRequest(url: string, headers: Record<string, string>, cf: Record<string, unknown>): Request {
  const req = new Request(url, { headers });
  Object.defineProperty(req, "cf", { value: cf });
  return req;
}
