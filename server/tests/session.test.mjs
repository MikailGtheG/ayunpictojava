import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { randomRoomId, sanitizeNickname, validateDraft, ensureEphemeralSession } from "../public/session.mjs";
if (!globalThis.crypto) globalThis.crypto = webcrypto;
test("temporary room IDs come from WebCrypto randomness and validate",()=>{
 const a=randomRoomId(),b=randomRoomId();
 assert.match(a,/^[0-9a-f]{32}$/);
 assert.notEqual(a,b);
 assert.equal(ensureEphemeralSession(a).persistent,false);
 assert.throws(()=>ensureEphemeralSession("../../etc"));
});
test("nickname handles German and Turkish Unicode without persistent account",()=>{
 assert.equal(sanitizeNickname("  Äyşu İğış  "),"Äyşu İğış");
 assert.equal(sanitizeNickname("\u0000\u200bGast"),"Gast");
 assert.equal(sanitizeNickname(""),"Gast");
 assert.equal(Array.from(sanitizeNickname("😊".repeat(50))).length,20);
});
test("drawing validator bounds all points; text stays Unicode",()=>{
 assert.equal(validateDraft({v:1,text:"ÄÖÜ ß ğışç 😊",strokes:[[[0,0],[512,170]]]}),true);
 assert.equal(validateDraft({v:1,text:"ok",strokes:[[[513,170]]]}),false);
 assert.equal(validateDraft({v:1,text:"ok",strokes:[Array(1201).fill([1,2])]}),false);
 assert.equal(validateDraft({v:1,text:"ok",strokes:[],extra:"ignored"}),true);
});
test("TypeScript session module exactly matches shipped browser implementation",()=>{
 const ts=readFileSync(new URL("../../frontend/src/session.ts",import.meta.url),"utf8");
 const shipped=readFileSync(new URL("../public/session.mjs",import.meta.url),"utf8");
 assert.equal(shipped,ts);
});
test("DS-style UI provides temporary room controls, undo and clearing on leave",()=>{
 const html=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
 const app=readFileSync(new URL("../public/app.mjs",import.meta.url),"utf8");
 assert.match(html,/class="device"/);
 assert.match(html,/class="hinge"/);
 assert.match(html,/id="new-room"/);
 assert.match(html,/id="nickname"/);
 assert.match(html,/id="undo"/);
 assert.match(app,/room\.value=randomRoomId\(\)/);
 assert.match(app,/messages\.replaceChildren\(\)/);
 assert.doesNotMatch(html,/localStorage|sessionStorage|indexedDB/);
});
