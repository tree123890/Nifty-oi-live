const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const NSE_MIN_INTERVAL_MS = Number(process.env.NSE_MIN_INTERVAL_MS || 5000);

app.use(express.json({limit:"1mb"}));
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res) { res.setHeader("Cache-Control", "no-cache"); }
}));

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const commonHeaders = {
  "User-Agent": UA,
  "Accept-Language": "en-US,en;q=0.9",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Connection": "keep-alive"
};

const state = {
  sourceUrl: "",
  symbol: "NIFTY",
  cookie: "",
  cookieAt: 0,
  lastAttemptAt: 0,
  lastSuccessAt: 0,
  latest: null,
  lastError: null,
  refreshing: false
};

function validateSourceUrl(input) {
  let u;
  try { u = new URL(input); } catch { throw new Error("Invalid URL"); }
  if (!["nseindia.com","www.nseindia.com"].includes(u.hostname)) {
    throw new Error("Only NSE India URLs are supported");
  }
  if (!u.pathname.toLowerCase().includes("optionchain")) {
    throw new Error("Please paste an NSE option-chain page URL");
  }
  return u;
}

function inferSymbol(u) {
  const parts = u.pathname.split("/").filter(Boolean);
  const idx = parts.findIndex(x => x.toLowerCase() === "optionchain");
  if (idx >= 0 && parts[idx+1]) {
    const v = decodeURIComponent(parts[idx+1]).toUpperCase();
    if (v) return v;
  }
  const q = u.searchParams.get("symbol");
  return (q || "NIFTY").toUpperCase();
}

function parseCookies(headers) {
  try {
    if (headers.getSetCookie) {
      const vals = headers.getSetCookie();
      if (vals?.length) return vals.map(v => v.split(";")[0]).join("; ");
    }
  } catch {}
  const raw = headers.get("set-cookie");
  if (!raw) return "";
  return raw.split(/,(?=[^;,]+=)/).map(v=>v.split(";")[0]).join("; ");
}

async function seedSession(sourceUrl) {
  const r = await fetch(sourceUrl, {
    headers: {...commonHeaders, "Referer":"https://www.nseindia.com/"},
    redirect:"follow",
    cache:"no-store"
  });
  if (!r.ok) throw new Error(`NSE page HTTP ${r.status}`);
  const ck = parseCookies(r.headers);
  if (ck) state.cookie = ck;
  state.cookieAt = Date.now();
  await r.text();
}

async function requestNse(sourceUrl, symbol) {
  if (!state.cookie || Date.now() - state.cookieAt > 8*60*1000) {
    await seedSession(sourceUrl);
  }

  const api = `https://www.nseindia.com/api/option-chain-indices?symbol=${encodeURIComponent(symbol)}`;
  const doReq = () => fetch(api, {
    headers: {
      "User-Agent": UA,
      "Accept":"application/json,text/plain,*/*",
      "Accept-Language":"en-US,en;q=0.9",
      "Referer": sourceUrl,
      "Cookie": state.cookie,
      "Connection":"keep-alive"
    },
    cache:"no-store"
  });

  let r = await doReq();
  if ([401,403].includes(r.status)) {
    state.cookie = "";
    await seedSession(sourceUrl);
    r = await doReq();
  }
  if (!r.ok) {
    const e = new Error(`NSE API HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  const data = await r.json();
  if (!data?.records?.data?.length) throw new Error("NSE returned no option-chain rows");
  return data;
}

async function refreshNow(force=false) {
  if (!state.sourceUrl) throw new Error("No NSE URL configured");
  if (state.refreshing) return;
  if (!force && Date.now() - state.lastAttemptAt < NSE_MIN_INTERVAL_MS) return;

  state.refreshing = true;
  state.lastAttemptAt = Date.now();

  try {
    const data = await requestNse(state.sourceUrl, state.symbol);
    state.latest = data;
    state.lastSuccessAt = Date.now();
    state.lastError = null;
  } catch (e) {
    state.lastError = {
      message: e.message,
      at: Date.now(),
      status: e.status || null
    };
  } finally {
    state.refreshing = false;
  }
}

// This endpoint is called when the user pastes/changes the NSE page URL.
app.post("/api/configure", async (req,res) => {
  try {
    const u = validateSourceUrl(req.body?.url || "");
    state.sourceUrl = u.toString();
    state.symbol = inferSymbol(u);
    state.cookie = "";
    state.latest = null;
    state.lastError = null;
    await refreshNow(true);

    res.status(state.latest ? 200 : 502).json({
      ok: !!state.latest,
      symbol: state.symbol,
      sourceUrl: state.sourceUrl,
      lastSuccessAt: state.lastSuccessAt,
      error: state.lastError
    });
  } catch(e) {
    res.status(400).json({ok:false,error:{message:e.message}});
  }
});

// Mobile UI can call this every second. The backend does NOT hit NSE every second;
// it serves cached data and refreshes NSE only at the configured minimum interval.
app.get("/api/snapshot", async (_req,res) => {
  try {
    await refreshNow(false);
  } catch {}
  res.set("Cache-Control","no-store");
  res.json({
    ok: !!state.latest,
    symbol: state.symbol,
    sourceUrl: state.sourceUrl,
    fetchedAt: state.lastSuccessAt || null,
    ageMs: state.lastSuccessAt ? Date.now()-state.lastSuccessAt : null,
    refreshing: state.refreshing,
    error: state.lastError,
    data: state.latest
  });
});

app.get("/api/status", (_req,res) => {
  res.json({
    ok:true,
    configured:!!state.sourceUrl,
    hasData:!!state.latest,
    symbol:state.symbol,
    nseMinIntervalMs:NSE_MIN_INTERVAL_MS,
    lastSuccessAt:state.lastSuccessAt || null,
    lastError:state.lastError
  });
});

app.get("/health",(_req,res)=>res.status(200).send("ok"));

app.get("*",(_req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

app.listen(PORT,()=>console.log(`NIFTY OI Mobile v3 on :${PORT}`));
