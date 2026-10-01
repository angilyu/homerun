import { bad, badRule, ok, type Vector } from "./types";
import * as F from "./fixtures";

const H = 3_600_000;
const sealed = (body: unknown, over: Record<string, unknown> = {}) => ({
  v: 1,
  msg_id: F.MSG_ID,
  sender_device_id: F.PHONE,
  created_at: F.T0,
  expires_at: F.T0 + 12 * H,
  body,
  ...over,
});
const instruction = { type: "instruction", thread_id: F.THREAD, client_msg_id: F.CLIENT_MSG, text: "Deploy the site" };
const push = {
  type: "push",
  category: "input_request",
  title: "Approve: npm install",
  body: "Site maintenance wants to run npm install left-pad@1.3.0",
  thread_id: F.THREAD,
  request_id: F.REQUEST,
  actions: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }],
};
const answer = { type: "answer", request_id: F.REQUEST, response: { type: "approval", decision: "allow" }, via: "notification" };

export const relay: Vector[] = [
  ok("RelayEnvelopeHeader", "sealed to desktop", { v: 1, mode: "sealed", to_device_id: F.DEVICE, from_device_id: F.PHONE, expires_at: F.T0 + 12 * H }),
  ok("RelayEnvelopeHeader", "live", { v: 1, mode: "live", to_device_id: F.PHONE, from_device_id: F.DEVICE }),
  bad("RelayEnvelopeHeader", "version 2", { v: 2, mode: "live", to_device_id: F.PHONE, from_device_id: F.DEVICE }),
  bad("RelayEnvelopeHeader", "unknown mode", { v: 1, mode: "plain", to_device_id: F.PHONE, from_device_id: F.DEVICE }),
  ok("RelayPresence", "offline", { type: "presence", device_id: F.DEVICE, online: false, last_seen_at: F.T0 }),
  bad("RelayPresence", "missing online", { type: "presence", device_id: F.DEVICE, last_seen_at: F.T0 }),
  ok("SealedInner", "queued instruction", sealed(instruction)),
  ok("SealedInner", "instruction starting a new chat", sealed({ ...instruction, thread_id: null })),
  ok("SealedInner", "instruction running a task", sealed({ ...instruction, thread_id: null, task_id: F.TASK })),
  ok("SealedInner", "push", sealed(push, { sender_device_id: F.DEVICE, expires_at: F.T0 + 24 * H })),
  ok("SealedInner", "push without actions", sealed({ type: "push", category: "run_finished", title: "Done", body: "Opened PR #12" })),
  ok("SealedInner", "withdrawal", sealed({ type: "push", category: "input_request", title: "Answered", body: "", request_id: F.REQUEST, withdrawn: true })),
  bad("SealedInner", "withdrawn false", sealed({ type: "push", category: "input_request", title: "Answered", body: "", request_id: F.REQUEST, withdrawn: false })),
  ok("SealedInner", "lock-screen answer", sealed(answer, { expires_at: F.T0 + H })),
  bad("SealedInner", "short msg_id", sealed(instruction, { msg_id: "abc" })),
  bad("SealedInner", "missing expires_at", sealed(instruction, { expires_at: undefined })),
  bad("SealedInner", "answer via app", sealed({ ...answer, via: "app" })),
  bad("SealedInner", "unknown body", sealed({ type: "command", text: "rm -rf" })),
  bad("SealedInner", "push with five actions", sealed({ ...push, actions: Array(5).fill({ id: "a", label: "A" }) })),
  badRule("SealedInner", "expires before created", sealed(instruction, { expires_at: F.T0 - 1 })),
  ok("LivePayload", "json-rpc request", { jsonrpc: "2.0", id: 5, method: "threads.subscribe", params: { thread_id: F.THREAD, after_seq: 0 } }),
  bad("LivePayload", "bare object", { hello: "world" }),
  ok("PairingQrPayload", "qr", { v: 1, device_id: F.DEVICE, static_public_key: F.STATIC_KEY, pairing_code: "k3J9-xQ2m_Lp8vR4" }),
  bad("PairingQrPayload", "padded key", { v: 1, device_id: F.DEVICE, static_public_key: `${F.STATIC_KEY}=`, pairing_code: "k3J9-xQ2m_Lp8vR4" }),
  bad("PairingQrPayload", "short pairing code", { v: 1, device_id: F.DEVICE, static_public_key: F.STATIC_KEY, pairing_code: "1234" }),
];
