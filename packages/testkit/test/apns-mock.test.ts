import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { importPKCS8, SignJWT } from "jose";
import { ApnsMock, fakeDeviceToken } from "../src";

let apns: ApnsMock;
beforeAll(async () => {
  apns = await ApnsMock.start();
});
afterAll(() => apns.stop());

async function providerToken(o: { kid?: string; iss?: string; iatOffset?: number } = {}) {
  const key = await importPKCS8(apns.p8, "ES256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: o.kid ?? apns.keyId })
    .setIssuer(o.iss ?? apns.teamId)
    .setIssuedAt(Math.floor(Date.now() / 1000) + (o.iatOffset ?? 0))
    .sign(key);
}

async function push(token: string, body: unknown, headers: Record<string, string> = {}, jwt?: string) {
  return fetch(`${apns.url}/3/device/${token}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${jwt ?? (await providerToken())}`,
      "apns-topic": apns.topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": "0",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("mock APNs", () => {
  const alert = { aps: { alert: { title: "Homerun", body: "You have a new update." }, "mutable-content": 1 } };

  test("accepts a valid push and records it", async () => {
    const token = fakeDeviceToken();
    const res = await push(token, alert);
    expect(res.status).toBe(200);
    expect(res.headers.get("apns-id")).toBeTruthy();
    const d = await apns.waitFor((x) => x.token === token);
    expect(d.payload).toEqual(alert);
    expect(d.pushType).toBe("alert");
  });

  test("checks the provider token", async () => {
    const token = fakeDeviceToken();
    const reason = async (r: Response) => [r.status, ((await r.json()) as { reason: string }).reason];
    expect(await reason(await push(token, alert, {}, await providerToken({ kid: "WRONGKID00" })))).toEqual([403, "InvalidProviderToken"]);
    expect(await reason(await push(token, alert, {}, await providerToken({ iss: "OTHERTEAM0" })))).toEqual([403, "InvalidProviderToken"]);
    expect(await reason(await push(token, alert, {}, await providerToken({ iatOffset: -3700 })))).toEqual([403, "ExpiredProviderToken"]);
    expect(await reason(await push(token, alert, { authorization: "" }))).toEqual([403, "MissingProviderToken"]);
  });

  test("checks headers, token and payload size", async () => {
    const token = fakeDeviceToken();
    const reason = async (r: Response) => [r.status, ((await r.json()) as { reason: string }).reason];
    expect(await reason(await push(token, alert, { "apns-topic": "com.other.app" }))).toEqual([400, "TopicDisallowed"]);
    expect(await reason(await push(token, alert, { "apns-push-type": "voip" }))).toEqual([400, "InvalidPushType"]);
    expect(await reason(await push("not-a-token", alert))).toEqual([400, "BadDeviceToken"]);
    expect(await reason(await push(token, { aps: {}, pad: "x".repeat(4100) }))).toEqual([413, "PayloadTooLarge"]);
    expect(await reason(await push(token, ""))).toEqual([400, "PayloadEmpty"]);
  });

  test("scripted responses and unregistered tokens", async () => {
    const token = fakeDeviceToken();
    apns.script(token, { status: 429, reason: "TooManyRequests" });
    expect((await push(token, alert)).status).toBe(429);
    expect((await push(token, alert)).status).toBe(200);
    apns.unregister(token);
    const gone = await push(token, alert);
    expect(gone.status).toBe(410);
    expect(await gone.json()).toMatchObject({ reason: "Unregistered", timestamp: expect.any(Number) });
  });
});
