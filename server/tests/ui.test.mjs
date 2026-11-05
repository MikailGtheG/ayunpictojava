import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const script = page.match(/<script type="module">([\s\S]*?)<\/script>/);
test("browser module exists and parses as JavaScript", () => {
  assert.ok(script, "Missing browser module script");
  const js = script[1].replace(/^\s*import\s*\{[^}]+\}\s*from\s*"\.\/crypto\.mjs";/, "");
  assert.doesNotThrow(() => new vm.Script(js));
});
test("browser does not transmit a legacy plaintext message", () => {
  assert.match(page, /await encryptPacket\(/);
  assert.match(page, /await decryptPacket\(/);
  assert.match(page, /socket\.send\(encrypted\)/);
  assert.doesNotMatch(page, /socket\.send\(bytes\)/);
});
test("crypto key is separate from the bearer admission token", () => {
  assert.match(page, /id="e2ee-key"/);
  assert.match(page, /importRoomKey\(secret\)/);
  assert.match(page, /"auth\."\+cap/);
  assert.doesNotMatch(page, /localStorage|sessionStorage|indexedDB/);
  assert.doesNotMatch(page, /<script\s+src="https?:/);
});
