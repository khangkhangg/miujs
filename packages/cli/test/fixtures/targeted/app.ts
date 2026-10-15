import { definePlugin, miu, targetRuntime } from "miujs";

// Declares a binding only when built for Cloudflare, like the real batteries' defaults.
const targeted = definePlugin({ name: "targeted", cloudflare: () => (targetRuntime() === "workerd" ? { kv: ["TARGETED"] } : {}) });

export default miu({ name: "targeted-fixture", logLevel: "silent", plugins: [targeted] });
