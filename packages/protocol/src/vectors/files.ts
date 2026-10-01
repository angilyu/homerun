import cacophony from "../../vectors/noise-cacophony.json";
import sealed from "../../vectors/sealed.json";
import live from "../../vectors/live.json";
import pairing from "../../vectors/pairing.json";
import linking from "../../vectors/linking.json";
import statement from "../../vectors/link-statement.json";
import apns from "../../vectors/apns-payload.json";
import wire from "../../vectors/relay-wire.json";
import encoding from "../../vectors/encoding.json";
import appAttest from "../../vectors/app-attest.json";

/** Every vector file, bundled, for environments without a file system (workerd). */
export const VECTOR_FILES: Record<string, unknown> = {
  "noise-cacophony.json": cacophony,
  "sealed.json": sealed,
  "live.json": live,
  "pairing.json": pairing,
  "linking.json": linking,
  "link-statement.json": statement,
  "apns-payload.json": apns,
  "relay-wire.json": wire,
  "encoding.json": encoding,
  "app-attest.json": appAttest,
};
