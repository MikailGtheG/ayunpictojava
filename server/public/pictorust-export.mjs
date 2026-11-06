// PictoRust: client-only, deterministic original-PictoChat pixel export.
// Produces ONE 256x192 top-screen PNG per page, with no external PDF library,
// captions, metadata text, credentials or network persistence.
export const WIDTH = 256;
export const HEIGHT = 192;
const BOTTOM = 189;
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

function wrapLines(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of String(text || "").split("\n")) {
    if (!paragraph) { lines.push(""); continue; }
    let line = "";
    for (const point of Array.from(paragraph)) {
      const candidate = line + point;
      if (line && ctx.measureText(candidate).width > maxWidth) {
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

function splitMessages(ctx, messages) {
  const parts = [];
  for (const msg of messages) {
    if (!msg || typeof msg.nickname !== "string" || typeof msg.text !== "string" || !Array.isArray(msg.strokes))
      throw new Error("Invalid temporary chat message");
    // One maximum-height original frame contains four ruled text lines.
    // Nothing is silently truncated: overflow creates another frame.
    const lines = wrapLines(ctx, msg.text, 214);
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
    if (current.length && height + h > BOTTOM) {
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

function drawBox(ctx, part, x, y, sprites) {
  const height = FRAMES[part.size];
  const key = part.size;
  ctx.drawImage(sprites["box_bg" + key + ".png"], x, y, 234, height);
  drawTinted(ctx, sprites["box_lines" + key + ".png"], x, y, 234, height, "#b7b7dc");
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

  ctx.fillStyle = "#07068b";
  ctx.font = "10px nds, monospace";
  ctx.textBaseline = "top";
  // The sender is inside the original inset tab at x+6,y+4.
  ctx.save();
  ctx.beginPath(); ctx.rect(x + 6, y + 4, 80, 12); ctx.clip();
  ctx.fillText(part.nickname, x + 6, y + 4);
  ctx.restore();

  ctx.fillStyle = "#111";
  ctx.font = "10px nds, monospace";
  ctx.save();
  ctx.beginPath(); ctx.rect(x + 4, y + 19, 226, height - 20); ctx.clip();
  part.lines.forEach((line, i) => ctx.fillText(line, x + 5, y + 19 + i * 16));
  ctx.restore();
}

export async function renderPictoRustPages(messages, roomLetter = "A") {
  if (!Array.isArray(messages)) throw new Error("Messages must be a volatile array");
  if (!messages.length) return [];
  if (messages.length > 2000) throw new Error("Too many messages for a single export");
  const letter = /^[A-E]$/.test(roomLetter) ? roomLetter.toLowerCase() : "a";
  await document.fonts.load("10px nds");
  const measure = document.createElement("canvas").getContext("2d");
  measure.font = "10px nds, monospace";
  const parts = splitMessages(measure, messages);
  const pages = groupPages(parts);
  if (pages.length > 200) throw new Error("Too many export pages");

  const names = new Set(["background.png", "connection.png", "letter_room_" + letter + ".png"]);
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
    // Top 192 pixels of the ORIGINAL full-screen background.
    ctx.drawImage(sprites["background.png"], 0, 0, 256, 192, 0, 0, 256, 192);
    ctx.drawImage(sprites["connection.png"], 1, 1, 16, 16);
    ctx.drawImage(sprites["letter_room_" + letter + ".png"], 1, 175, 16, 16);
    let y = BOTTOM - group.reduce((total, part) => total + FRAMES[part.size], 0);
    for (const part of group) {
      drawBox(ctx, part, 21, y, sprites);
      y += FRAMES[part.size];
    }
    return canvas.toDataURL("image/png");
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
