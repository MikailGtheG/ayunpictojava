// Visual and behavior acceptance against the REAL local Rust relay.
// All screenshots show synthetic demo content; no real user keys or chat data.
// Chromium is installed by the matching screenshot workflow.
import { chromium, devices } from "playwright";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

const origin = "http://127.0.0.1:8787";
const screenshots = "screenshots";
const demoKey = "c3".repeat(32);

async function waitForIdentity(page) {
  await page.locator("#own-fingerprint").getAttribute("id");
  await page.waitForFunction(() => /^[a-f0-9]{64}$/.test(
    document.getElementById("own-fingerprint")?.textContent?.trim() ?? ""
  ), null, { timeout: 15_000 });
  return (await page.locator("#own-fingerprint").textContent()).trim();
}

async function screenshotSafe(page, name) {
  // Hide all credentials, including any that might be visible in a captured input.
  await page.locator("#token, #e2ee-key, #trusted-fingerprints").evaluateAll(els => {
    for (const el of els) {
      el.value = "";
      el.setAttribute("data-screen-capture", "redacted");
    }
  });
  await page.screenshot({ path: `${screenshots}/${name}.png`, fullPage: true, animations: "disabled" });
}

async function main() {
  await mkdir(screenshots, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  let alice, bob, mobile;
  try {
    const aliceContext = await browser.newContext({ viewport: { width: 1280, height: 920 }, locale: "de-DE" });
    const bobContext = await browser.newContext({ viewport: { width: 1280, height: 920 }, locale: "de-DE" });
    alice = await aliceContext.newPage();
    bob = await bobContext.newPage();
    for (const page of [alice, bob]) {
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(origin, { waitUntil: "networkidle" });
      await page.locator("#messages").waitFor({ state: "visible" });
      // Fail if the actual original artwork is missing: screenshots must
      // represent the main-fork images, never CSS placeholders.
      for (const asset of ["background.png", "drawui.png", "intro_bg.png", "logo.png"]) {
        const resource = await page.request.get(origin + "/original/images/" + asset);
        assert.equal(resource.status(), 200, "missing original sprite: " + asset);
        assert.match(resource.headers()["content-type"], /image\/png/);
      }
      const pixelFont = await page.request.get(origin + "/original/nds.ttf");
      assert.equal(pixelFont.status(), 200, "original nds.ttf missing");
      assert.equal(await page.locator("#lobby-logo").evaluate(image => image.naturalWidth), 93);
    }

    const aliceFingerprint = await waitForIdentity(alice);
    const bobFingerprint = await waitForIdentity(bob);
    assert.notEqual(aliceFingerprint, bobFingerprint, "each session needs its own ephemeral keypair");

    await alice.getByRole("button", { name: "Raum + Einladung erstellen" }).click();
    await alice.waitForFunction(() => document.getElementById("room").value.startsWith("ee")
      && document.getElementById("token").value.length === 64);
    const room = await alice.locator("#room").inputValue();
    const token = await alice.locator("#token").inputValue();
    assert.match(room, /^ee[0-9a-f]{30}$/);
    assert.match(token, /^[0-9a-f]{64}$/);

    await bob.locator("#room").fill(room);
    await bob.locator("#token").fill(token);
    await alice.locator("#e2ee-key").fill(demoKey);
    await bob.locator("#e2ee-key").fill(demoKey);
    await alice.locator("#trusted-fingerprints").fill(bobFingerprint);
    await bob.locator("#trusted-fingerprints").fill(aliceFingerprint);
    await alice.locator("#nickname").fill("Äysu");
    await bob.locator("#nickname").fill("Çağrı");

    await alice.getByRole("button", { name: "Verbinden", exact: true }).click();
    await bob.getByRole("button", { name: "Verbinden", exact: true }).click();
    await alice.getByRole("status").getByText("Verbunden", { exact: false }).waitFor();
    await bob.getByRole("status").getByText("Verbunden", { exact: false }).waitFor();

    const firstMessage = "Merhaba! Ä Ö Ü ß – ğ ı İ ş ç 😊";
    await alice.locator("#text").fill(firstMessage);
    // Verify on-screen Turkish key insertion is functional, not just decorative.
    await alice.locator("#keyboard-mode").click();
    await alice.locator('#international-keys button[data-char="ğ"]').click();
    await alice.locator("#keyboard-mode").click();
    assert.match(await alice.locator("#text").inputValue(), /ğ$/);

    const canvas = alice.locator("#drawing");
    const bounds = await canvas.boundingBox();
    assert.ok(bounds, "drawing surface should exist");
    await alice.mouse.move(bounds.x + 20, bounds.y + 30);
    await alice.mouse.down();
    await alice.mouse.move(bounds.x + 140, bounds.y + 80, { steps: 15 });
    await alice.mouse.up();

    await alice.locator("#send").click();
    await bob.locator("#messages .entry").first().waitFor({ timeout: 15_000 });
    const bobText = await bob.locator("#messages").innerText();
    assert.match(bobText, /Merhaba!/);
    assert.match(bobText, /Ä Ö Ü ß/);
    assert.match(bobText, /ğ ı İ ş ç/);
    assert.match(bobText, /Çağrı|Äysu/);
    assert.equal(await bob.locator("#messages .entry img").count(), 1, "sketch must be delivered and rendered");

    // Bob replies; the upper display should show a real two-way chat.
    await bob.locator("#text").fill("Hallo zurück! 🎨 Çizim angekommen.");
    await bob.locator("#send").click();
    await alice.locator("#messages .entry").nth(1).waitFor({ timeout: 15_000 });
    assert.match(await alice.locator("#messages").innerText(), /Hallo zurück!/);

    assert.match(await alice.locator(".bottom-screen").evaluate(el => getComputedStyle(el).backgroundImage), /drawui\.png/);
    await screenshotSafe(alice, "pictochat-desktop");
    assert.equal(await alice.locator("#lobby").isVisible(), false);
    assert.equal(await alice.locator("#security-panel").evaluate(el=>el.open), false);

    // Validate the same print stylesheet used by the user-triggered PDF action.
    await alice.emulateMedia({ media: "print" });
    assert.equal(await alice.locator("#messages .entry").count(), 2);
    assert.equal(await alice.locator(".bottom-screen").isVisible(), false);
    assert.equal(await alice.locator("#messages .entry img").count(), 1);
    await alice.pdf({
      path: `${screenshots}/pictochat-print-demo.pdf`,
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
    });
    await alice.emulateMedia({ media: "screen" });

    const mobileContext = await browser.newContext({ ...devices["iPhone 13"], browserName: undefined });
    mobile = await mobileContext.newPage();
    mobile.on("pageerror", error => errors.push(error.message));
    await mobile.goto(origin, { waitUntil: "networkidle" });
    await mobile.locator("#own-fingerprint").waitFor();
    await waitForIdentity(mobile);
    await mobile.locator("#nickname").fill("Mobil 📱");
    await screenshotSafe(mobile, "pictochat-mobile");

    // Confirm no overflow on mobile and successful server refusal of an unauthorized token.
    const overflow = await mobile.evaluate(() =>
      document.documentElement.scrollWidth > window.innerWidth + 2
    );
    assert.equal(overflow, false, "mobile page must not overflow horizontally");

    const blocked = await mobile.evaluate(async roomId => {
      // WebSocket with a bogus capability must fail the handshake.
      return new Promise(resolve => {
        const ws = new WebSocket("ws://" + location.host + "/ws/" + roomId,
          ["picto.v1", "auth." + "00".repeat(32)]);
        ws.onerror = () => resolve(true);
        ws.onopen = () => { ws.close(); resolve(false); };
        setTimeout(() => resolve(false), 3000);
      });
    }, room);
    assert.equal(blocked, true, "unauthorized room admission must be refused");

    assert.deepEqual(errors, [], "browser must not raise uncaught page errors");

    // Leave erases local chat messages and secrets in the active client.
    await alice.locator("#disconnect").click();
    await alice.waitForFunction(() =>
      document.querySelectorAll("#messages .entry").length === 0 &&
      document.getElementById("token").value === ""
    );
    const rotatedIdentity = await waitForIdentity(alice);
    assert.notEqual(rotatedIdentity, aliceFingerprint, "new session must rotate ephemeral identity");
    assert.equal(await alice.locator("#messages .entry").count(), 0);
    assert.equal(await alice.locator("#token").inputValue(), "");
    console.log("Visual browser acceptance passed: two peers, Unicode, sketches, reply, mobile and local clearing.");
    console.log("Screenshot artifacts: screenshots/pictochat-desktop.png and screenshots/pictochat-mobile.png");
    console.log("PDF print proof: screenshots/pictochat-print-demo.pdf");
  } finally {
    await browser.close();
  }
}

await main();
