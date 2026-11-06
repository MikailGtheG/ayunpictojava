// PictoRust: client-only, deterministic original-PictoChat pixel export.
// Produces a continuous pixel-accurate 256px-wide chat strip per A4 page, with no external PDF library,
// captions, metadata text, credentials or network persistence.
export const WIDTH = 256;
export const HEIGHT = 520;
const CONTENT_TOP = 14;
const CONTENT_BOTTOM = 510;
const FRAMES = [0, 22, 38, 54, 70, 85];
const SPRITE_DIR = "/original/images/";
const ALLOWED = /^[a-z0-9_]+\.png$/;

function image(name) {
  if (!ALLOWED.test(name)) return Promise.reject(new Error("Invalid sprite"));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Missing original sprite: " + name));
    img.src = SPRITE_DIR + name;
  });
}

function wrapLines(font, text, maxWidth) {
  const lines = [];
  for (const paragraph of String(text || "").split("\n")) {
    if (!paragraph) { lines.push(""); continue; }
    let line = "";
    for (const point of Array.from(paragraph)) {
      const candidate = line + point;
      if (line && font.width(candidate) > maxWidth) {
        lines.push(line);
        line = point;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines.length ? lines : [""];
}

// The source font is the original nds.ttf. Rasterize each glyph on a fixed
// integer grid and remove grayscale antialiasing before composing the message.
// This avoids Chromium/PDF subpixel shifts and blurry doubled pixels.
const GLYPH_SIZE = 20;
const GLYPH_BASELINE = 13;
function createPixelFont(ctx) {
  const cache = new Map();
  const widthOf = character => Math.max(1, Math.ceil(ctx.measureText(character).width));
  function glyph(character) {
    if (cache.has(character)) return cache.get(character);
    const advance = widthOf(character);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(advance + 5, 24);
    canvas.height = GLYPH_SIZE;
    const g = canvas.getContext("2d", { willReadFrequently: true });
    g.font = '10px "nds"';
    g.textBaseline = "alphabetic";
    g.fillStyle = "#fff";
    g.fillText(character, 1, GLYPH_BASELINE);
    const imageData = g.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < imageData.data.length; i += 4) {
      const on = imageData.data[i + 3] >= 112 ? 255 : 0;
      imageData.data[i] = 255;
      imageData.data[i + 1] = 255;
      imageData.data[i + 2] = 255;
      imageData.data[i + 3] = on;
    }
    g.putImageData(imageData, 0, 0);
    const item = { canvas, advance };
    cache.set(character, item);
    return item;
  }
  function width(text) {
    return Array.from(text).reduce((total, char) => total + glyph(char).advance, 0);
  }
  function draw(target, text, x, top, color) {
    const penX = Math.round(x), penY = Math.round(top);
    const palette = document.createElement("canvas");
    palette.width = Math.max(1, width(text) + 6);
    palette.height = GLYPH_SIZE;
    const p = palette.getContext("2d");
    p.imageSmoothingEnabled = false;
    let pos = 0;
    for (const char of Array.from(text)) {
      const bitmap = glyph(char);
      p.drawImage(bitmap.canvas, pos, 0);
      pos += bitmap.advance;
    }
    p.globalCompositeOperation = "source-in";
    p.fillStyle = color;
    p.fillRect(0, 0, palette.width, palette.height);
    target.drawImage(palette, penX, penY);
  }
  return { width, draw };
}

function splitMessages(font, messages) {
  const parts = [];
  for (const msg of messages) {
    if (!msg || typeof msg.nickname !== "string" || typeof msg.text !== "string" || !Array.isArray(msg.strokes))
      throw new Error("Invalid temporary chat message");
    // One maximum-height original frame contains four ruled text lines.
    // Nothing is silently truncated: overflow creates another frame.
    const lines = wrapLines(font, msg.text, 214);
    if (!msg.text && msg.strokes.length) {
      parts.push({ ...msg, lines: [], size: 5 });
      continue;
    }
    for (let i = 0; i < lines.length; i += 4) {
      const chunk = lines.slice(i, i + 4);
      const hasDrawing = i === 0 && msg.strokes.length > 0;
      const size = hasDrawing ? 5 : Math.min(5, Math.max(2, chunk.length + 1));
      parts.push({ ...msg, lines: chunk, size, strokes: hasDrawing ? msg.strokes : [] });
    }
  }
  return parts;
}

function groupPages(parts) {
  const pages = [];
  let current = [], height = 0;
  for (const part of parts) {
    const h = FRAMES[part.size];
    if (current.length && height + h > CONTENT_BOTTOM - CONTENT_TOP) {
      pages.push(current);
      current = [];
      height = 0;
    }
    current.push(part);
    height += h;
  }
  if (current.length) pages.push(current);
  return pages;
}

function drawTinted(ctx, sprite, x, y, w, h, color) {
  const layer = document.createElement("canvas");
  layer.width = w; layer.height = h;
  const lctx = layer.getContext("2d", { willReadFrequently: false });
  lctx.imageSmoothingEnabled = false;
  lctx.drawImage(sprite, 0, 0, w, h);
  lctx.globalCompositeOperation = "source-in";
  lctx.fillStyle = color;
  lctx.fillRect(0, 0, w, h);
  ctx.drawImage(layer, x, y);
}

function drawBox(ctx, part, x, y, sprites, font) {
  const height = FRAMES[part.size];
  const key = part.size;
  ctx.drawImage(sprites["box_bg" + key + ".png"], x, y, 234, height);
  drawTinted(ctx, sprites["box_lines" + key + ".png"], x, y, 234, height, "#b7b7dc");
  // Chromium/Pixi multiply-lined backgrounds use 1 logical-pixel rules at
  // 16px intervals. Sprite alpha alone does not retain these faint lines.
  ctx.fillStyle = "#b7b7dc";
  for (let dy = 19; dy < height - 1; dy += 16) {
    ctx.fillRect(x + 4, y + dy, 226, 1);
  }
  // Real original outlines are alpha-mask sprites, NOT four CSS border lines.
  drawTinted(ctx, sprites["box_outline" + key + ".png"], x, y, 234, height, "#07068b");

  if (part.strokes.length) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 2, y + 19, 230, height - 21);
    ctx.clip();
    ctx.strokeStyle = "#101010";
    ctx.lineWidth = 1.4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const stroke of part.strokes) {
      if (!stroke.length) continue;
      ctx.beginPath();
      stroke.forEach(([px, py], i) => {
        const sx = x + (px / 512) * 234;
        const sy = y + (py / 170) * height;
        if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
      });
      if (stroke.length === 1) ctx.lineTo(x + stroke[0][0] / 512 * 234 + .1, y + stroke[0][1] / 170 * height);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Match original PIXI BitmapText coordinates: x+6/y+4 sender,
  // x+5/y+19 content. No floating CSS em boxes or browser line-height.
  ctx.save();
  ctx.beginPath(); ctx.rect(x + 6, y + 4, 80, 12); ctx.clip();
  font.draw(ctx, part.nickname, x + 6, y + 1, "#07068b");
  ctx.restore();

  ctx.save();
  ctx.beginPath(); ctx.rect(x + 4, y + 19, 226, height - 20); ctx.clip();
  part.lines.forEach((line, i) => font.draw(ctx, line, x + 5, y + 16 + i * 16, "#111111"));
  ctx.restore();
}

export async function renderPictoRustPages(messages, roomLetter = "A") {
  if (!Array.isArray(messages)) throw new Error("Messages must be a volatile array");
  if (!messages.length) return [];
  if (messages.length > 2000) throw new Error("Too many messages for a single export");
  const letter = /^[A-E]$/.test(roomLetter) ? roomLetter.toLowerCase() : "a";
  await document.fonts.load('10px "nds"');
  if (!document.fonts.check('10px "nds"')) throw new Error("Original Nintendo DS font unavailable");
  const measure = document.createElement("canvas").getContext("2d");
  measure.font = "10px nds, monospace";
  const pixelFont = createPixelFont(measure);
  const parts = splitMessages(pixelFont, messages);
  const pages = groupPages(parts);
  if (pages.length > 200) throw new Error("Too many export pages");

  const names = new Set(["letter_room_" + letter + ".png"]);
  parts.forEach(part => {
    for (const prefix of ["box_bg", "box_outline", "box_lines"])
      names.add(prefix + part.size + ".png");
  });
  const sprites = {};
  await Promise.all([...names].map(async name => { sprites[name] = await image(name); }));
  return pages.map(group => {
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH; canvas.height = HEIGHT;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    // Paper-only neutral backing: an otherwise empty DS screen repeats gray
    // raster lines across the whole A4 page, obscuring short chat exports.
    // Preserve authentic per-message bg, ruled lines and outline sprites.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.drawImage(sprites["letter_room_" + letter + ".png"], 2, 0, 12, 12);
    let y = CONTENT_TOP;
    for (const part of group) {
      drawBox(ctx, part, 21, y, sprites, pixelFont);
      y += FRAMES[part.size];
    }
    // PDF output has four identical physical pixels per logical DS pixel.
    // Pre-upscale in the raster itself; Chromium cannot interpolate it in print.
    const highResolution = document.createElement("canvas");
    highResolution.width = WIDTH * 4;
    highResolution.height = HEIGHT * 4;
    const highCtx = highResolution.getContext("2d");
    highCtx.imageSmoothingEnabled = false;
    highCtx.drawImage(canvas, 0, 0, highResolution.width, highResolution.height);
    return highResolution.toDataURL("image/png");
  });
}

export async function preparePictoRustPrint(messages, roomLetter, target) {
  const pages = await renderPictoRustPages(messages, roomLetter);
  target.replaceChildren();
  for (const [index, url] of pages.entries()) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = ""; // raster-only, no explanations in PDF
    img.className = "pixel-page";
    img.dataset.page = String(index + 1);
    img.width = WIDTH;
    img.height = HEIGHT;
    target.append(img);
    await img.decode();
  }
  return pages;
}
