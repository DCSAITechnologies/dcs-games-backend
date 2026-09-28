// node shot.mjs <base> <outdir> <mode anon|tester|signedin> <vp WxH> <route>...
import { chromium } from "playwright"; import fs from "node:fs";
const [base,out,mode,vp,...routes]=process.argv.slice(2); const [w,h]=vp.split("x").map(Number);
const STAGE="https://dcs-games-backend-staging.up.railway.app"; fs.mkdirSync(out,{recursive:true});
const b=await chromium.launch();
for (const r of routes){
  const ctx=await b.newContext({viewport:{width:w,height:h},isMobile:w<800,hasTouch:w<800});
  await ctx.addInitScript(({mode,STAGE})=>{ window.DCS_API_BASE=STAGE;
    if(mode!=="anon"){ try{ localStorage.setItem("dcsgames.token","h.eyJleHAiOjQxMDI0NDQ4MDB9.s"); localStorage.setItem("dcsgames.user",JSON.stringify({username:"founder",display_name:"Founder"})); sessionStorage.setItem("dcs_beta_ok","1"); }catch(e){} } },{mode,STAGE});
  await ctx.route(STAGE+"/**", async route=>{ const cors={"access-control-allow-origin":"*","access-control-allow-headers":"authorization,content-type"}; const rq=route.request(); if(rq.method()==="OPTIONS") return route.fulfill({status:204,headers:cors});
    const p=new URL(rq.url()).pathname; const J=(b)=>route.fulfill({status:200,headers:{...cors,"content-type":"application/json"},body:JSON.stringify(b)});
    if(mode==="signedin"||mode==="tester"){ // a signed-in founder with an empty account: stubbed identity routes, everything public proxied
      if(p==="/v3/subscriptions/grants") return J({ok:true,grants:[]});
      if(p==="/me/profile") return J({ok:true,principal_id:"p_1",username:"founder",display_name:"Founder",level:"explorer"});
      if(p==="/me/home") return J({ok:true,profile:{level:"explorer",xp:0},worlds:{counted:0,published:0,complete:true},recent:[]});
      if(p==="/me/streak") return J({ok:true,current:0,played_today:false});
      if(p==="/me/achievements") return J({ok:true,unlocked:0,total:12,achievements:[]});
      if(p==="/social/friends") return J({ok:true,friends:[],incoming:[]});
      if(/^\/(me|social|v3\/jobs|safety|verify|v3\/marketplace\/(owned|ledger|storefronts))/.test(p)) return J({ok:true,items:[]});
    }
    const hdr={...rq.headers()}; delete hdr.authorization;
    try{ const resp=await route.fetch({headers:hdr,timeout:30000}); return route.fulfill({response:resp,headers:{...resp.headers(),...cors}});}catch(e){return route.abort();} });
  const p=await ctx.newPage(); await p.goto(base+r,{waitUntil:"load"}); await p.waitForTimeout(3500);
  const name=(r.replace(/[\/?=&]+/g,"_").replace(/^_|_$/g,"")||"home")+`_${vp}.png`;
  await p.screenshot({path:`${out}/${name}`,fullPage:false}); console.log(`${out}/${name}`);
  await ctx.close();
}
await b.close();
