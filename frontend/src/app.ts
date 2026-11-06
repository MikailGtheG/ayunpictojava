import { importRoomKey, encryptPacket, decryptPacket, ReplayGuard } from "./crypto.mjs";
import { createSessionIdentity, signMessage, verifyMessage, parseTrustedFingerprints } from "./identity.mjs";
import { randomRoomId, sanitizeNickname, validateDraft } from "./session.mjs";
"use strict";
const $: any = (id: string) => document.getElementById(id);
const room=$("room"),token=$("token"),status=$("status"),messages=$("messages");
const canvas=$("drawing"),ctx=canvas.getContext("2d"),encoder=new TextEncoder(),decoder=new TextDecoder("utf-8",{fatal:true});
let socket=null,strokes=[],current=null,roomKey=null,replayGuard=null,sessionIdentity=null,trustedPeers=null;
const MAX_BYTES=16384,MAX_POINTS=1200;
let totalPoints=0;
const setStatus=t=>status.textContent=t;
const stage=document.getElementById("picto");
const lobby=document.getElementById("lobby");
const securityPanel=document.getElementById("security-panel");
const board=document.getElementById("writing-board");
let lastReceivedData=null;
let selectedRoomLetter="A";
for(const button of document.querySelectorAll("[data-room-letter]")){
 button.addEventListener("click",()=>{
  selectedRoomLetter=button.getAttribute("data-room-letter")||"A";
  document.getElementById("room-letter").textContent="Chat Room "+selectedRoomLetter;
  for(const item of document.querySelectorAll("[data-room-letter]"))item.setAttribute("aria-pressed",String(item===button));
 });
}
function setTool(which){
 board.classList.toggle("mode-text",which==="text");
 board.classList.toggle("mode-pen",which==="pen");
 document.getElementById("pen-tool").setAttribute("aria-pressed",String(which==="pen"));
 document.getElementById("text-tool").setAttribute("aria-pressed",String(which==="text"));
 if(which==="text")document.getElementById("text").focus();
}
document.getElementById("pen-tool").addEventListener("click",()=>setTool("pen"));
document.getElementById("text-tool").addEventListener("click",()=>setTool("text"));
document.getElementById("eraser-tool").addEventListener("click",()=>{
 const removed=strokes.pop();if(removed)totalPoints-=removed.length;
 current=null;redraw();
});
document.getElementById("scroll-up").addEventListener("click",()=>messages.scrollBy({top:-96,behavior:"smooth"}));
document.getElementById("scroll-down").addEventListener("click",()=>messages.scrollBy({top:96,behavior:"smooth"}));
document.getElementById("copy-last").addEventListener("click",()=>{
 if(!lastReceivedData)return;
 document.getElementById("text").value=lastReceivedData.text||"";
 strokes=lastReceivedData.strokes.map(x=>x.map(p=>[...p]));
 totalPoints=strokes.reduce((n,x)=>n+x.length,0);
 current=null;redraw();
});
document.getElementById("clear-chat").addEventListener("click",()=>messages.replaceChildren());
document.getElementById("leave-room").addEventListener("click",()=>socket?.close());

room.value=randomRoomId();
$("new-room").addEventListener("click",async()=>{
 if(socket)return;
 $("new-room").disabled=true;
 try{
  const response=await fetch("/new-room",{method:"POST",cache:"no-store"});
  if(!response.ok)throw new Error("room issue failed");
  const invitation=await response.json();
  if(!/^[0-9a-f]{32}$/.test(invitation.roomId)||!/^[0-9a-f]{64}$/.test(invitation.token))throw new Error("invalid invitation");
  room.value=invitation.roomId;token.value=invitation.token;
  messages.replaceChildren();
  setStatus("Temporärer Raum erstellt (6 Stunden gültig). Einladung nur über einen sicheren Kanal teilen.");
 }catch{setStatus("Raumerstellung fehlgeschlagen. Läuft der lokale Rust-Server?");}
 finally{$("new-room").disabled=false;}
});
$("copy-invite").addEventListener("click",async()=>{
 if(!/^[0-9a-f]{32}$/.test(room.value)||!/^[0-9a-f]{64}$/.test(token.value)){
  setStatus("Zuerst Raum und Zugangstoken erstellen");return;
 }
 try{
  await navigator.clipboard.writeText(room.value+" "+token.value);
  setStatus("Einladung kopiert: Raum-ID und Zugangstoken sicher teilen, niemals öffentlich posten.");
 }catch{setStatus("Einladung konnte nicht kopiert werden");}
});
$("nickname").value="Gast";
$("copy-room").addEventListener("click",async()=>{
 try{
  await navigator.clipboard.writeText(room.value.trim());
  setStatus("Temporäre Raum-ID kopiert. Für Zugang weiterhin separates Token erforderlich.");
 }catch{setStatus("Zwischenablage nicht verfügbar; Raum-ID bitte manuell kopieren.");}
});
document.querySelectorAll("#touch-keys [data-char]").forEach(button=>{
 button.addEventListener("click",()=>{
  const field=$("text");
  const ch=button.getAttribute("data-char");
  if(!ch)return;
  const start=field.selectionStart,end=field.selectionEnd;
  if(ch==="BACKSPACE"){
   if(start===end && start>0){
    const prev=Array.from(field.value.slice(0,start)).pop()||"";
    field.value=field.value.slice(0,start-prev.length)+field.value.slice(end);
    field.focus();field.setSelectionRange(start-prev.length,start-prev.length);
   }else{field.value=field.value.slice(0,start)+field.value.slice(end);field.focus();field.setSelectionRange(start,start);}
   return;
  }
  const insert=ch==="ENTER"?"\\n":ch;
  const next=field.value.slice(0,start)+insert+field.value.slice(end);
  if(Array.from(next).length>2000)return;
  field.value=next;field.focus();field.setSelectionRange(start+insert.length,start+insert.length);
 });
});
async function renewIdentity(){
 if(socket)return;
 $("connect").disabled=true;
 $("own-fingerprint").textContent="Wird erzeugt …";
 try{
  sessionIdentity=await createSessionIdentity();
  $("own-fingerprint").textContent=sessionIdentity.fingerprint;
  setStatus("Eigene Sitzungsidentität erzeugt – Fingerprints außerhalb des Chats austauschen");
 }catch{setStatus("Sitzungsidentität konnte nicht erzeugt werden");}
 finally{$("connect").disabled=!!socket||!sessionIdentity;}
}
$("new-identity").addEventListener("click",renewIdentity);
renewIdentity();
$("generate-key").addEventListener("click",()=>{
 const bytes=globalThis.crypto.getRandomValues(new Uint8Array(32));
 $("e2ee-key").value=Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
 setStatus("Neuen Chat-Schlüssel erzeugt; vor dem Verbinden sicher separat an andere Teilnehmer weitergeben");
});
$("show-key").addEventListener("click",()=>{
 const field=$("e2ee-key");field.type=field.type==="password"?"text":"password";
});
const enabled=on=>{$("send").disabled=!on;$("disconnect").disabled=!on;$("connect").disabled=on||!sessionIdentity;room.disabled=on;token.disabled=on;$("new-identity").disabled=on;$("new-room").disabled=on;$("trusted-fingerprints").disabled=on;lobby.hidden=on;if(on)securityPanel.open=false;else securityPanel.open=true;};
function xy(e){
 const b=canvas.getBoundingClientRect();
 return [Math.max(0,Math.min(512,Math.round((e.clientX-b.left)*512/b.width))),
         Math.max(0,Math.min(170,Math.round((e.clientY-b.top)*170/b.height)))];
}
function line(points,context){
 if(!points.length)return;
 context.beginPath();context.moveTo(points[0][0],points[0][1]);
 for(const p of points.slice(1))context.lineTo(p[0],p[1]);
 if(points.length===1){context.lineTo(points[0][0]+.1,points[0][1]+.1);}
 context.stroke();
}
function redraw(){
 ctx.clearRect(0,0,512,170);ctx.lineWidth=2.5;ctx.strokeStyle="#111";ctx.lineJoin="round";ctx.lineCap="round";
 for(const stroke of strokes)line(stroke,ctx);
}
canvas.addEventListener("pointerdown",e=>{if(totalPoints>=MAX_POINTS)return;current=[xy(e)];strokes.push(current);totalPoints++;canvas.setPointerCapture(e.pointerId);redraw();});
canvas.addEventListener("pointermove",e=>{
 if(!current||totalPoints>=MAX_POINTS)return;
 const p=xy(e),last=current[current.length-1];
 if(p[0]!==last[0]||p[1]!==last[1]){current.push(p);totalPoints++;redraw();}
});
for(const event of ["pointerup","pointercancel","lostpointercapture"])canvas.addEventListener(event,()=>{current=null;});
$("clear").addEventListener("click",()=>{strokes=[];current=null;totalPoints=0;redraw();});
$("undo").addEventListener("click",()=>{
 const deleted=strokes.pop();if(deleted)totalPoints-=deleted.length;
 current=null;redraw();
});
function render(data,who){
 lastReceivedData={text:data.text||"",strokes:data.strokes.map(x=>x.map(p=>[...p]))};
 const div=document.createElement("article");div.className="entry";
 const name=document.createElement("div");name.className="who";name.textContent=who;
 div.append(name);
 if(data.text){const p=document.createElement("div");p.className="body";p.textContent=data.text;div.append(p);}
 if(Array.isArray(data.strokes)&&data.strokes.length){
   const painting=document.createElement("canvas");painting.width=512;painting.height=170;
   const context=painting.getContext("2d");context.strokeStyle="#111";context.lineWidth=2.5;context.lineJoin="round";context.lineCap="round";
   for(const stroke of data.strokes)line(stroke,context);
   const image=document.createElement("img");image.alt="Gezeichnete Nachricht";image.src=painting.toDataURL("image/png");div.append(image);
 }
 messages.append(div);messages.scrollTop=messages.scrollHeight;
}
function valid(data){
 return validateDraft(data) && typeof data.nickname==="string" &&
  sanitizeNickname(data.nickname)===data.nickname;
}
$("connect").addEventListener("click",async()=>{
 const id=room.value.trim(),cap=token.value.trim(),secret=$("e2ee-key").value.trim();
 if(!/^[0-9a-f]{32}$/.test(id)||!/^[0-9a-f]{64}$/.test(cap)){setStatus("Ungültige Raum-ID oder Zugangstoken");return;}
 if(socket||!sessionIdentity)return;
 try{
  trustedPeers=parseTrustedFingerprints($("trusted-fingerprints").value);
  trustedPeers.add(sessionIdentity.fingerprint);
  roomKey=await importRoomKey(secret);
 }catch{setStatus("Chat-Schlüssel oder geprüfte Fingerprints fehlen/ungültig");return;}
 $("e2ee-key").value="";
 $("e2ee-key").type="password";
 replayGuard=new ReplayGuard();
 const ws=new WebSocket("ws://"+location.host+"/ws/"+id,["picto.v1","auth."+cap]);
 ws.binaryType="arraybuffer";socket=ws;setStatus("Verbinde …");$("connect").disabled=true;
 ws.onopen=()=>{if(socket===ws){enabled(true);setStatus("Verbunden (experimentell verschlüsselt)");}};
 ws.onmessage=async e=>{
  if(!(e.data instanceof ArrayBuffer)||e.data.byteLength>MAX_BYTES||!roomKey)return;
  try{
    const plain=await decryptPacket(roomKey,id,e.data,replayGuard);
    if(socket!==ws)return;
    const signed=JSON.parse(decoder.decode(plain));
    const verified=await verifyMessage(signed,id,trustedPeers);
    if(socket!==ws)return;
    if(valid(verified.body))render(verified.body,verified.body.nickname+" · "+verified.fingerprint.slice(0,10));
  }catch{setStatus("Ungültige, manipulierte oder wiederholte Nachricht verworfen");}
 };
 ws.onerror=()=>setStatus("Verbindungsfehler oder Raumzugang abgelehnt");
 ws.onclose=()=>{if(socket===ws){socket=null;roomKey=null;replayGuard=null;trustedPeers=null;sessionIdentity=null;lastReceivedData=null;
  messages.replaceChildren();strokes=[];current=null;totalPoints=0;redraw();
  token.value="";$("e2ee-key").value="";$("trusted-fingerprints").value="";
  enabled(false);setStatus("Sitzung beendet – lokale Nachrichten und Schlüssel verworfen");renewIdentity();}};
});
$("disconnect").addEventListener("click",()=>socket?.close());
$("send").addEventListener("click",async()=>{
 if(!socket||socket.readyState!==WebSocket.OPEN||!roomKey)return;
 const active=socket,key=roomKey,identity=sessionIdentity;
 const data={v:1,text:$("text").value,nickname:sanitizeNickname($("nickname").value),strokes:strokes.map(s=>s.map(p=>[...p]))};
 if(!data.text.trim()&&!data.strokes.length)return;
 try {
  const signed=await signMessage(identity,room.value.trim(),data);
  const encrypted=await encryptPacket(key,room.value.trim(),encoder.encode(JSON.stringify(signed)));
  if(socket!==active||socket.readyState!==WebSocket.OPEN)return;
  socket.send(encrypted);$("text").value="";strokes=[];current=null;totalPoints=0;redraw();
 }catch{setStatus("Nachricht zu groß oder Verschlüsselung fehlgeschlagen");}
});
$("pdf").addEventListener("click",()=>window.print());
$("erase").addEventListener("click",()=>messages.replaceChildren());
window.addEventListener("beforeunload",()=>socket?.close());
