import { config } from "zod";

// Zod probes `new Function("")` to decide whether to compile its parsers. The page's CSP has no
// 'unsafe-eval' and requires Trusted Types, so the probe only ever fails, and is reported as a
// violation each time. Saying so up front keeps the report empty, so a real violation stands out.
config({ jitless: true });
