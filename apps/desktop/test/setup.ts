import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach } from "bun:test";

// A DOM for component tests (plan §9). React Testing Library needs it before it loads.
GlobalRegistrator.register({ url: "http://localhost/" });

const { cleanup } = await import("@testing-library/react");
afterEach(() => cleanup());

// Screens update after RPC promises settle, outside act(); the tests wait with findBy/waitFor
// instead, so React's reminder is noise here. Every other console.error still prints.
const error = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("not wrapped in act(")) return;
  error(...args);
};
