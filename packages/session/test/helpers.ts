// A tiny browser-like cookie jar for driving `app.fetch` across requests.
export class Jar {
  cookies = new Map<string, string>();

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  store(res: Response): string[] {
    const set = res.headers.getSetCookie();
    for (const line of set) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a));
      if (expired || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return set;
  }

  request(url: string, init: RequestInit = {}): Request {
    const headers = new Headers(init.headers);
    if (this.cookies.size && !headers.has("cookie")) headers.set("cookie", this.header());
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD" && !headers.has("origin")) headers.set("origin", new URL(url).origin);
    return new Request(url, { ...init, headers });
  }
}

export const SECRET = "test-secret-that-is-long-enough-0123456789";
