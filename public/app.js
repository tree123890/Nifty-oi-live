const $=id=>document.getElementById(id);
let timer=null,last=null,busy=false;

const num=v=>Number(v??0)||0;
const fmt=v=>Math.round(num(v)).toLocaleString("en-IN");
const px=v=>num(v).toLocaleString("en-IN",{maximumFractionDigits:2});

function classify(x){
  if(!x)return{label:"—",cls:"flat"};
  const oi=num(x.changeinOpenInterest), ch=num(x.change);
  if(oi>0&&ch>0)return{label:"Long build-up",cls:"long"};
  if(oi>0&&ch<0)return{label:"Short build-up",cls:"short"};
  if(oi<0&&ch>0)return{label:"Short covering",cls:"cover"};
  if(oi<0&&ch<0)return{label:"Long unwinding",cls:"unwind"};
  return{label:"Neutral",cls:"flat"};
}

function nearest(rows,spot){
  let k=0,d=Infinity;
  rows.forEach((r,i)=>{const x=Math.abs(num(r.strikePrice)-spot);if(x<d){d=x;k=i}});
  return k;
}

function metrics(rows,spot){
  let co=0,po=0;
  rows.forEach(r=>{co+=num(r.CE?.openInterest);po+=num(r.PE?.openInterest)});
  const pcr=co?po/co:0;
  const near=rows.filter(r=>Math.abs(num(r.strikePrice)-spot)<=500);
  const puts=near.filter(r=>r.PE&&num(r.strikePrice)<=spot+100).sort((a,b)=>num(b.PE.openInterest)-num(a.PE.openInterest));
  const calls=near.filter(r=>r.CE&&num(r.strikePrice)>=spot-100).sort((a,b)=>num(b.CE.openInterest)-num(a.CE.openInterest));
  return{pcr,support:puts[0]?.strikePrice||0,resistance:calls[0]?.strikePrice||0};
}

function bias(rows,spot,m){
  const i=nearest(rows,spot), band=rows.slice(Math.max(0,i-4),i+5);
  let bull=0,bear=0;
  band.forEach(r=>{
    const ce=classify(r.CE),pe=classify(r.PE);
    if(pe.label==="Short build-up")bull+=2;
    if(ce.label==="Long build-up")bull+=1;
    if(pe.label==="Long unwinding")bull+=1;
    if(ce.label==="Short build-up")bear+=2;
    if(pe.label==="Long build-up")bear+=1;
    if(ce.label==="Long unwinding")bear+=1;
  });
  if(m.pcr>1.15)bull+=1;
  if(m.pcr<.85)bear+=1;

  let name="RANGE-BOUND",cls="range";
  if(bull-bear>=3){name="MILDLY BULLISH";cls="bull"}
  if(bull-bear>=6){name="BULLISH";cls="bull"}
  if(bear-bull>=3){name="MILDLY BEARISH";cls="bear"}
  if(bear-bull>=6){name="BEARISH";cls="bear"}

  let s=`NIFTY OI is ${name.toLowerCase()}, with support near ${fmt(m.support)} and resistance near ${fmt(m.resistance)}.`;
  if(m.resistance&&spot>m.resistance)s+=" Price is above the estimated resistance, strengthening the bullish case.";
  else if(m.support&&spot<m.support)s+=" Price is below the estimated support, weakening the setup.";
  return{name,cls,s};
}

function render(wrapper){
  const raw=wrapper.data;
  const rec=raw.records||raw.filtered||raw;
  const rows=(rec.data||[]).slice().sort((a,b)=>num(a.strikePrice)-num(b.strikePrice));
  if(!rows.length)throw new Error("No option-chain rows returned");
  const spot=num(rec.underlyingValue||raw.records?.underlyingValue)||num(rows[Math.floor(rows.length/2)].strikePrice);
  last={wrapper,rows,spot};

  const m=metrics(rows,spot),b=bias(rows,spot,m);
  $("spot").textContent=px(spot);
  $("pcr").textContent=m.pcr?m.pcr.toFixed(2):"—";
  $("support").textContent=m.support?fmt(m.support):"—";
  $("resistance").textContent=m.resistance?fmt(m.resistance):"—";
  $("bias").textContent=b.name;
  $("bias").className=`bigtext ${b.cls}`;
  $("summary").textContent=b.s;

  const range=Number($("rangeSelect").value),i=nearest(rows,spot),vis=rows.slice(Math.max(0,i-range),i+range+1);
  const minD=Math.min(...vis.map(r=>Math.abs(num(r.strikePrice)-spot)));
  $("body").innerHTML="";
  vis.forEach(r=>{
    const ce=classify(r.CE),pe=classify(r.PE),tr=document.createElement("tr");
    if(Math.abs(num(r.strikePrice)-spot)===minD)tr.className="atm";
    tr.innerHTML=`
    <td><span class="sig ${ce.cls}">${ce.label}</span></td>
    <td>${r.CE?fmt(r.CE.openInterest):"—"}</td>
    <td>${r.CE?fmt(r.CE.changeinOpenInterest):"—"}</td>
    <td>${r.CE?px(r.CE.lastPrice):"—"}</td>
    <td>${r.CE?px(r.CE.change):"—"}</td>
    <td>${fmt(r.strikePrice)}</td>
    <td>${r.PE?px(r.PE.change):"—"}</td>
    <td>${r.PE?px(r.PE.lastPrice):"—"}</td>
    <td>${r.PE?fmt(r.PE.changeinOpenInterest):"—"}</td>
    <td>${r.PE?fmt(r.PE.openInterest):"—"}</td>
    <td><span class="sig ${pe.cls}">${pe.label}</span></td>`;
    $("body").appendChild(tr);
  });
}

async function tick(){
  if(busy)return;
  busy=true;
  $("status").textContent="Fetching NSE…";
  try{
    const r=await fetch("/api/analyze-url",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url:$("urlInput").value.trim()}),cache:"no-store"});
    const j=await r.json();
    if(!r.ok)throw new Error(j.detail||j.error||"Fetch failed");
    render(j);
    $("status").textContent="LIVE • updating every 1 second";
    $("lastFetch").textContent=new Date(j.fetchedAt).toLocaleTimeString();
  }catch(e){
    $("status").textContent=`Error: ${e.message}`;
  }finally{busy=false}
}

function start(){
  stop();
  tick();
  timer=setInterval(tick,1000);
}
function stop(){
  if(timer){clearInterval(timer);timer=null}
  $("status").textContent="Stopped";
}
$("startBtn").onclick=start;
$("stopBtn").onclick=stop;
$("rangeSelect").onchange=()=>{if(last)render(last.wrapper)};
