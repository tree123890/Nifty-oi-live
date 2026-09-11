const express = require("express");
const path = require("path");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({limit:"2mb"}));
app.use(express.static(path.join(__dirname,"public")));

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const baseHeaders = {
  "User-Agent": UA,
  "Accept-Language": "en-US,en;q=0.9",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Connection": "keep-alive"
};

let cookie = "";
let cookieAt = 0;

function validateNseUrl(input){
  let u;
  try { u = new URL(input); } catch { throw new Error("Invalid URL"); }
  if (u.hostname !== "www.nseindia.com" && u.hostname !== "nseindia.com") {
    throw new Error("Only nseindia.com URLs are allowed");
  }
  if (!u.pathname.toLowerCase().includes("optionchain")) {
    throw new Error("Please paste an NSE option-chain URL");
  }
  return u;
}

async function seedSession(pageUrl){
  const r = await fetch(pageUrl, {
    headers: {...baseHeaders, "Referer":"https://www.nseindia.com/"},
    redirect:"follow",
    cache:"no-store"
  });
  if (!r.ok) throw new Error(`NSE page returned ${r.status}`);

  let cookies = [];
  if (r.headers.getSetCookie) cookies = r.headers.getSetCookie();
  if (cookies.length) {
    cookie = cookies.map(v=>v.split(";")[0]).join("; ");
  } else {
    const raw = r.headers.get("set-cookie");
    if (raw) cookie = raw.split(/,(?=[^;,]+=)/).map(v=>v.split(";")[0]).join("; ");
  }
  cookieAt = Date.now();

  const html = await r.text();
  return html;
}

function inferSymbolFromUrl(urlObj){
  const parts = urlObj.pathname.split("/").filter(Boolean);
  const idx = parts.findIndex(p=>p.toLowerCase()==="optionchain");
  if (idx >= 0 && parts[idx+1]) {
    const sym = decodeURIComponent(parts[idx+1]).toUpperCase();
    return sym === "NIFTY" ? "NIFTY" : sym;
  }
  return "NIFTY";
}

async function fetchOptionChainFromNSE(pageUrl){
  const u = validateNseUrl(pageUrl);
  const symbol = inferSymbolFromUrl(u);

  // Seed cookies from the exact page URL the user pasted.
  if (!cookie || Date.now()-cookieAt > 5*60*1000) {
    await seedSession(u.toString());
  }

  const apiUrl = `https://www.nseindia.com/api/option-chain-indices?symbol=${encodeURIComponent(symbol)}`;
  let r = await fetch(apiUrl, {
    headers: {
      "User-Agent": UA,
      "Accept": "application/json,text/plain,*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": u.toString(),
      "Cookie": cookie,
      "Connection":"keep-alive"
    },
    cache:"no-store"
  });

  if (r.status === 401 || r.status === 403) {
    await seedSession(u.toString());
    r = await fetch(apiUrl, {
      headers: {
        "User-Agent": UA,
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": u.toString(),
        "Cookie": cookie,
        "Connection":"keep-alive"
      },
      cache:"no-store"
    });
  }

  if (!r.ok) throw new Error(`NSE API returned ${r.status}`);
  const data = await r.json();
  return {data, symbol, apiUrl};
}

app.post("/api/analyze-url", async (req,res)=>{
  const url = req.body?.url;
  if (!url) return res.status(400).json({error:"URL is required"});
  try {
    const out = await fetchOptionChainFromNSE(url);
    res.set("Cache-Control","no-store, no-cache, must-revalidate");
    res.json({
      sourceUrl:url,
      symbol:out.symbol,
      fetchedAt:new Date().toISOString(),
      data:out.data
    });
  } catch(e) {
    res.status(502).json({
      error:"Could not fetch data from NSE",
      detail:e.message,
      note:"NSE may throttle automated requests. One-second polling is aggressive and can trigger blocking."
    });
  }
});

app.get("/health",(_req,res)=>res.json({ok:true}));

app.listen(PORT,()=>console.log(`Running on http://localhost:${PORT}`));
