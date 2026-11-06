// Visual and behavior acceptance against the REAL local Rust relay.
// All screenshots show synthetic demo content; no real user keys or chat data.
// Chromium is installed by the matching screenshot workflow.
import { chromium, devices } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

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

    // Pixel-accurate geometry contract from the main-fork PIXI renderer.
    // Coordinates below are logical 256x384 DS pixels, not CSS approximations.
    await alice.waitForFunction(() => document.querySelectorAll("#touch-keys button[data-original-hitbox]").length === 50);
    const geometry = await alice.evaluate(() => {
      const stage = document.getElementById("picto").getBoundingClientRect();
      const sx = stage.width / 256, sy = stage.height / 384;
      const get = id => {
        const r = document.getElementById(id).getBoundingClientRect();
        return [(r.x-stage.x)/sx, (r.y-stage.y)/sy, r.width/sx, r.height/sy];
      };
      const keys = Array.from(document.querySelectorAll("#touch-keys button[data-original-hitbox]"));
      return {
        stageAspect: stage.width / stage.height,
        board: get("writing-board"), send: get("send"), copy: get("copy-last"),
        clear: get("erase"), scrollUp: get("scroll-up"), scrollDown: get("scroll-down"),
        pen: get("pen-tool"), eraser: get("eraser-tool"),
        exit: get("exit-internal"), signal: get("connection-icon"), badge: get("room-letter"),
        keyBoxes: keys.map(el => {
          const r = el.getBoundingClientRect();
          return [(r.x-stage.x)/sx,(r.y-stage.y)/sy,r.width/sx,r.height/sy];
        }),
        source: keys.map(el => el.dataset.originalHitbox.split(",").map(Number)),
      };
    });
    assert.ok(Math.abs(geometry.stageAspect - 256/384) < 0.002, "DS aspect ratio must be exact");
    for (const [name, expected] of Object.entries({
      board:[21,207,234,85], send:[225,296,31,30],
      copy:[225,327,31,23], clear:[225,351,31,24],
      scrollUp:[2,194,14,14], scrollDown:[2,209,14,14],
      pen:[2,230,14,13], eraser:[2,244,14,13],
      exit:[245,193,10,10], signal:[1,1,16,16], badge:[1,175,16,16],
    })) {
      geometry[name].forEach((value, i) =>
        assert.ok(Math.abs(value-expected[i]) < 0.8,
          `${name} axis ${i}: actual ${value}, expected ${expected[i]} DS pixels`)
      );
    }
    for(let k=0;k<50;k++) {
      geometry.keyBoxes[k].forEach((value,i)=>
        assert.ok(Math.abs(value-geometry.source[k][i])<0.8,
          `original key ${k} axis ${i}: ${value} != ${geometry.source[k][i]}`)
      );
    }
    console.log("Pixel geometry passed: all 50 original keyboard hitboxes and 8 control rectangles.");

    await alice.locator("#picto").screenshot({
      path: `${screenshots}/pictochat-original-lobby.png`,
      animations:"disabled",
    });
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
    await alice.mouse.move(bounds.x + 25, bounds.y + 90);
    await alice.mouse.down();
    await alice.mouse.move(bounds.x + 155, bounds.y + 135, { steps: 15 });
    await alice.mouse.up();
    await alice.locator("#writing-board").screenshot({
      path: `${screenshots}/pictochat-original-draft-box.png`,
      animations: "disabled",
    });
    const draftSprites = await alice.evaluate(() => {
      const el = document.getElementById("writing-board");
      const stage = document.getElementById("picto").getBoundingClientRect();
      const r = el.getBoundingClientRect(), scale = stage.width / 256;
      const after = getComputedStyle(el, "::after");
      const before = getComputedStyle(el, "::before");
      return {
        rect: [(r.x-stage.x)/scale,(r.y-stage.y)/scale,r.width/scale,r.height/scale],
        outline: after.webkitMaskImage || after.maskImage,
        lines: before.webkitMaskImage || before.maskImage,
        background: getComputedStyle(el).backgroundImage,
        draftName: document.getElementById("draft-name").textContent,
      };
    });
    for (const [i, expected] of [21,207,234,85].entries())
      assert.ok(Math.abs(draftSprites.rect[i]-expected)<0.8,
        `writing box geometry axis ${i} must match original: ${draftSprites.rect[i]} vs ${expected}`);
    assert.match(draftSprites.background,/box_bg5\.png/);
    assert.match(draftSprites.outline,/box_outline5\.png/);
    assert.match(draftSprites.lines,/box_lines5\.png/);
    assert.equal(draftSprites.draftName,"Äysu");
    const ruling = await alice.locator("#writing-board .rule-lines").evaluate(el=>getComputedStyle(el).backgroundImage);
    assert.match(ruling,/repeating-linear-gradient/);

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
    const messageGeometry = await alice.evaluate(() => {
      const stage = document.getElementById("picto").getBoundingClientRect();
      const messages = document.getElementById("messages");
      const last = messages.querySelector(".entry:last-child").getBoundingClientRect();
      const first = messages.querySelector(".entry:first-child");
      const background = getComputedStyle(first).backgroundImage;
      return {
        bottomOriginalPixels: (last.bottom-stage.top)/(stage.height/384),
        firstClass:first.className,
        background,
        secondClass:messages.querySelector(".entry:last-child").className,
      };
    });
    assert.ok(Math.abs(messageGeometry.bottomOriginalPixels-189)<2,
      `messages must stack against original y=189 PIXI boundary, got ${messageGeometry.bottomOriginalPixels}`);
    assert.match(messageGeometry.firstClass,/lines-5/);
    assert.match(messageGeometry.background,/box_bg5\.png/);
    assert.match(messageGeometry.secondClass,/lines-2/);
    const spriteComposition = await alice.locator("#messages .entry").first().evaluate(el => ({
      background: getComputedStyle(el).backgroundImage,
      lines: getComputedStyle(el,"::before").webkitMaskImage,
      outline: getComputedStyle(el,"::after").webkitMaskImage,
      sender: el.querySelector(".who").textContent,
    }));
    assert.match(spriteComposition.background,/box_bg5\.png/);
    assert.match(spriteComposition.lines,/box_lines5\.png/);
    assert.match(spriteComposition.outline,/box_outline5\.png/);
    assert.equal(spriteComposition.sender,"Äysu");
    const tabsAndRules = await alice.locator("#messages .entry").evaluateAll(entries =>
      entries.map(el => ({
        sender:el.querySelector(".who").getBoundingClientRect().height,
        senderBottom:el.querySelector(".who").getBoundingClientRect().bottom,
        bodyTop:el.querySelector(".body").getBoundingClientRect().top,
        lines:getComputedStyle(el.querySelector(".rule-lines")).backgroundImage,
      }))
    );
    assert.equal(tabsAndRules.length,2);
    for (const entry of tabsAndRules) {
      assert.ok(entry.sender >= 25, "short message must not clip 15px DS sender tab");
      assert.ok(entry.bodyTop >= entry.senderBottom-1, "message text must not overlap sender tab");
      assert.match(entry.lines,/repeating-linear-gradient/);
    }
    await alice.locator(".top-screen").screenshot({
      path: `${screenshots}/pictochat-original-top-messages.png`,
      animations: "disabled",
    });

    assert.match(await alice.locator(".bottom-screen").evaluate(el => getComputedStyle(el).backgroundImage), /drawui\.png/);
    await screenshotSafe(alice, "pictochat-desktop");
    await alice.locator("#picto").screenshot({
      path: `${screenshots}/pictochat-original-stage.png`,
      animations:"disabled",
    });
    assert.equal(await alice.locator("#lobby").isVisible(), false);
    assert.equal(await alice.locator("#security-panel").evaluate(el=>el.open), false);

    // Real pixel-export button: not browser A4 cards or shifted HTML boxes.
    await alice.evaluate(() => { window.print=() => { window.__pixelPrintInvoked=true; }; });
    await alice.locator("#security-panel summary").click();
    await alice.locator("#pdf").click();
    await alice.waitForFunction(() =>
      document.querySelectorAll("#pixel-print .pixel-page").length > 0 &&
      window.__pixelPrintInvoked === true, null, { timeout: 15000 });
    const pixelPages = await alice.locator("#pixel-print .pixel-page").count();
    assert.equal(pixelPages, 1, "two demo messages must share one original DS top-screen");
    const pngData = await alice.locator("#pixel-print .pixel-page").first().evaluate(img => ({
      url:img.src, naturalWidth:img.naturalWidth, naturalHeight:img.naturalHeight, complete:img.complete
    }));
    assert.equal(pngData.naturalWidth,256);
    assert.equal(pngData.naturalHeight,192);
    assert.ok(pngData.complete && pngData.url.startsWith("data:image/png;base64,"));
    await writeFile(`${screenshots}/pictorust-export-page-1.png`,
      Buffer.from(pngData.url.split(",")[1],"base64"));

    await alice.emulateMedia({media:"print"});
    assert.equal(await alice.locator("#page").isVisible(),false);
    assert.equal(await alice.locator("#print-document").isVisible(),false);
    assert.equal(await alice.locator("#pixel-print").isVisible(),true);
    const printSize = await alice.locator("#pixel-print .pixel-page").evaluate(img => {
      const r=img.getBoundingClientRect();
      return {width:r.width,height:r.height};
    });
    assert.equal(printSize.width,256);
    assert.equal(printSize.height,192);
    await alice.pdf({
      path:`${screenshots}/pictochat-print-demo.pdf`,
      printBackground:true,
      preferCSSPageSize:true,
      displayHeaderFooter:false,
      scale:1
    });
    await alice.emulateMedia({media:"screen"});
    assert.equal(await alice.locator("#pixel-print").isVisible(),false);
    // Long histories must paginate without text-only A4 cards or losing messages.
    const pagesInMemory = await alice.evaluate(async () => {
      const {renderPictoRustPages} = await import("./pictorust-export.mjs");
      const many = Array.from({length:13},(_,i)=>({
        nickname:"User"+i,text:"Message "+i+" – ÄÖÜ ğışç 😊",strokes:[]
      }));
      const pages = await renderPictoRustPages(many,"A");
      return {
        count:pages.length,
        unique:new Set(pages).size,
        validPng:pages.every(p=>p.startsWith("data:image/png;base64,"))
      };
    });
    assert.equal(pagesInMemory.count,4,"13 short messages must split into four original-screen pages");
    assert.equal(pagesInMemory.unique,4,"separate pages must not duplicate the same image");
    assert.equal(pagesInMemory.validPng,true);

    await alice.locator("#security-panel summary").click();

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
    await alice.locator("#exit-internal").click();
    await alice.waitForFunction(() =>
      document.querySelectorAll("#messages .entry").length === 0 &&
      document.getElementById("token").value === ""
    );
    const rotatedIdentity = await waitForIdentity(alice);
    assert.notEqual(rotatedIdentity, aliceFingerprint, "new session must rotate ephemeral identity");
    assert.equal(await alice.locator("#messages .entry").count(), 0);
    assert.equal(await alice.locator("#pixel-print .pixel-page").count(), 0, "Pixel export memory must clear on leaving");
    assert.equal(await alice.locator("#token").inputValue(), "");
    console.log("Visual browser acceptance passed: two peers, Unicode, sketches, reply, mobile and local clearing.");
    console.log("Screenshot artifacts: desktop, mobile, original 256x384 stage and original lobby PNGs.");
    console.log("PDF print proof: screenshots/pictochat-print-demo.pdf");
  } finally {
    await browser.close();
  }
}

await main();
