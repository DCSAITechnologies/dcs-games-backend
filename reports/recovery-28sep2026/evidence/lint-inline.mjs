import fs from "node:fs"; import path from "node:path"; import vm from "node:vm";
const root = process.argv[2]; let files = 0, scripts = 0, bad = [];
function walk(d){ for (const e of fs.readdirSync(d,{withFileTypes:true})) { if (e.name.startsWith(".")||e.name==="node_modules") continue; const p=path.join(d,e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".html")) check(p); else if (p.endsWith(".js")) { try { new vm.Script(fs.readFileSync(p,"utf8"),{filename:p}); } catch(err){ bad.push(p+": "+err.message); } } } }
function check(p){ files++; const s=fs.readFileSync(p,"utf8"); for (const m of s.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi)) { if (/type=["']?(module|application\/ld\+json|text\/template)/i.test(m[1])) continue; scripts++; try { new vm.Script(m[2],{filename:p}); } catch(err){ bad.push(p.replace(root,"")+": "+err.message); } } }
walk(root); console.log(JSON.stringify({htmlFiles:files, inlineScripts:scripts, errors:bad},null,1));
