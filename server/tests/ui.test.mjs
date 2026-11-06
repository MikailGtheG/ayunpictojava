import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../public/app.mjs", import.meta.url), "utf8");
test("browser module exists and parses as JavaScript", () => {
  assert.match(page, /src="\.\/app\.mjs"/);
  const js = script.replace(/^\s*import\s*\{[^}]+\}\s*from\s*"\.\/[a-z-]+\.mjs";/gm, "");
  assert.doesNotThrow(() => new vm.Script(js));
});
test("browser does not transmit a legacy plaintext message", () => {
  assert.match(script, /await encryptPacket\(/);
  assert.match(script, /await decryptPacket\(/);
  assert.match(script, /await signMessage\(/);
  assert.match(script, /await verifyMessage\(/);
  assert.match(script, /socket\.send\(encrypted\)/);
  assert.doesNotMatch(script, /socket\.send\(bytes\)/);
});
test("crypto key is separate from the bearer admission token", () => {
  assert.match(page, /id="e2ee-key"/);
  assert.match(page, /id="trusted-fingerprints"/);
  assert.match(page, /id="own-fingerprint"/);
  assert.match(script, /parseTrustedFingerprints\(/);
  assert.match(script, /importRoomKey\(secret\)/);
  assert.match(script, /"auth\."\+cap/);
  assert.doesNotMatch(page, /localStorage|sessionStorage|indexedDB/);
  assert.doesNotMatch(page, /<script\s+src="https?:/);
});
