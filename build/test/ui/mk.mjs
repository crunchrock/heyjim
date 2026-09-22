// Generates out/_t.html (the real app, pre-unlocked, with test hooks) and out/_w.html (a 390px iframe wrapper = iPhone width).
// Run after every build: node build/test/ui/mk.mjs. out/ is gitignored because _t.html embeds the derived key.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '../../..'), OUT = path.join(HERE, 'out');
const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'build/secret.json'), 'utf8'));
const k = crypto.pbkdf2Sync(s.password, Buffer.from(s.salt, 'base64'), 310000, 32, 'sha256').toString('base64');
let h = fs.readFileSync(path.join(ROOT, 'docs/index.html'), 'utf8');
const show = (pos, bg) => `(t)=>setTimeout(()=>document.body.insertAdjacentHTML("beforeend","<div style='position:fixed;${pos}:0;left:0;right:0;z-index:999;background:${bg};color:white;font:11px monospace;padding:6px'>"+t+"</div>"),50)`;
// Test pages must NEVER reach his real synced data: all GitHub API calls are blocked here.
const pre = `<script>window.fetch=((f)=>(u,o)=>String(u).includes("api.github.com")?Promise.resolve(new Response("{}",{status:503})):f(u,o))(window.fetch.bind(window));
const ERR=${show('bottom', 'purple')};window.onerror=(m,s,l,c)=>ERR(m+" @"+l+":"+c);
localStorage.setItem("hj.key",JSON.stringify("${k}"));const Q=new URLSearchParams(location.search);
if(Q.get("reset"))localStorage.setItem("hj.state",JSON.stringify({loc:{lat:+(Q.get("lat")||29.2847),lng:+(Q.get("lng")||-81.0553),t:Date.now()},settings:{theme:Q.get("theme")||"light"},last:{shower:Date.now()-30*3600e3}}));</script>`;
const post = `<script>const iv=setInterval(()=>{if(typeof D==="undefined"||!D||document.getElementById("app").hidden)return;clearInterval(iv);
try{S.settings.theme=Q.get("theme")||"light";applyTheme();if(Q.get("tpl")&&!getDay(today()))A.useTpl({id:Q.get("tpl")});
const d=Q.get("do"),day=getDay(today());
if(d==="block")A.openBlock({id:day.blocks[Q.get("i")|0].id});if(d==="tab")A.tabTo({t:Q.get("t")});if(d==="list")A.needList({t:Q.get("t")||"sleep"});
if(d==="add")A.addBlockSheet();if(d==="act")A[Q.get("name")](Object.fromEntries(Q));if(d==="dev")A.devPick();if(d==="zone")A.openZone({z:Q.get("z")});if(d==="pid")A.openPlace({id:Q.get("id")});
if(Q.get("scroll"))setTimeout(()=>scrollTo(0,+Q.get("scroll")),100);if(Q.get("ss"))setTimeout(()=>{document.getElementById("sheet").scrollTop=+Q.get("ss")},150);
}catch(e){ERR(e.stack)}},200)</script>`;
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, '_t.html'), h.replace('<script src="core.js"></script>', pre + '<script src="core.js"></script>').replace('</body>', post + '</body>'));
fs.writeFileSync(path.join(OUT, '_w.html'), `<!doctype html><body style="margin:0;background:#000"><iframe id="f" style="width:390px;height:844px;border:0;display:block"></iframe><script>document.getElementById('f').src='/_t.html'+location.search</script></body>`);
console.log('test pages written to', OUT);
