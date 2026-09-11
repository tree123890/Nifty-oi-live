const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));

app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-cache");
    }
  })
);

const GROWW_API_KEY = process.env.GROWW_API_KEY;
const GROWW_API_SECRET = process.env.GROWW_API_SECRET;

const state = {
  accessToken: null,
  tokenExpiry: 0,

  symbol: "NIFTY",
  exchange: "NSE",
  expiryDate: "",

  latest: null,
  lastSuccessAt: 0,
  lastError: null,
  refreshing: false
};


// --------------------------------------------------
// Helpers
// --------------------------------------------------

function generateChecksum(secret, timestamp) {
  return crypto
    .createHash("sha256")
    .update(secret + timestamp)
    .digest("hex");
}

function normalizeGrowwError(data, fallback) {
  return (
    data?.message ||
    data?.error?.message ||
    data?.error ||
    fallback
  );
}

function todayISTDateString() {
  const now = new Date();

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);

  const year = parts.find(p => p.type === "year")?.value;
  const month = parts.find(p => p.type === "month")?.value;
  const day = parts.find(p => p.type === "day")?.value;

  return `${year}-${month}-${day}`;
}


// --------------------------------------------------
// Groww authentication
// --------------------------------------------------

async function getAccessToken() {
  if (!GROWW_API_KEY || !GROWW_API_SECRET) {
    throw new Error(
      "Groww API credentials are missing in Render environment variables"
    );
  }

  if (
    state.accessToken &&
    Date.now() < state.tokenExpiry
  ) {
    return state.accessToken;
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();

  const checksum = generateChecksum(
    GROWW_API_SECRET,
    timestamp
  );

  const response = await fetch(
    "https://api.groww.in/v1/token/api/access",
    {
      method: "POST",

      headers: {
        Authorization: `Bearer ${GROWW_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },

      body: JSON.stringify({
        key_type: "approval",
        checksum,
        timestamp
      })
    }
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Groww token response was not JSON. HTTP ${response.status}`
    );
  }

  if (!response.ok) {
    throw new Error(
      normalizeGrowwError(
        data,
        `Groww authentication failed. HTTP ${response.status}`
      )
    );
  }

  const token =
    data?.token ||
    data?.payload?.token ||
    data?.access_token;

  if (!token) {
    throw new Error(
      "Groww did not return an access token. Check daily API approval."
    );
  }

  state.accessToken = token;
  state.tokenExpiry = Date.now() + 30 * 60 * 1000;

  return token;
}


// --------------------------------------------------
// Generic Groww GET
// --------------------------------------------------

async function growwGet(url) {
  let token = await getAccessToken();

  async function request() {
    return fetch(url, {
      method: "GET",

      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "X-API-VERSION": "1.0"
      },

      cache: "no-store"
    });
  }

  let response = await request();

  if (
    response.status === 401 ||
    response.status === 403
  ) {
    state.accessToken = null;
    state.tokenExpiry = 0;

    token = await getAccessToken();

    response = await request();
  }

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Groww returned invalid JSON. HTTP ${response.status}`
    );
  }

  if (!response.ok) {
    throw new Error(
      normalizeGrowwError(
        data,
        `Groww API HTTP ${response.status}`
      )
    );
  }

  if (
    data?.status &&
    data.status !== "SUCCESS"
  ) {
    throw new Error(
      normalizeGrowwError(
        data,
        "Groww API returned FAILURE"
      )
    );
  }

  return data;
}


// --------------------------------------------------
// Find nearest expiry automatically
// --------------------------------------------------

async function findNearestExpiry() {
  const today = todayISTDateString();
  const now = new Date();

  const year = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata",
      year: "numeric"
    }).format(now)
  );

  const month = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata",
      month: "numeric"
    }).format(now)
  );

  async function fetchExpiries(y, m) {
    const url =
      "https://api.groww.in/v1/historical/expiries" +
      `?exchange=${encodeURIComponent(state.exchange)}` +
      `&underlying_symbol=${encodeURIComponent(state.symbol)}` +
      `&year=${y}` +
      `&month=${m}`;

    const data = await growwGet(url);

    return (
      data?.payload?.expiries ||
      data?.expiries ||
      []
    );
  }

  let expiries = await fetchExpiries(year, month);

  let futureExpiries = expiries
    .filter(date => date >= today)
    .sort();

  if (futureExpiries.length > 0) {
    return futureExpiries[0];
  }

  let nextYear = year;
  let nextMonth = month + 1;

  if (nextMonth === 13) {
    nextMonth = 1;
    nextYear += 1;
  }

  expiries = await fetchExpiries(
    nextYear,
    nextMonth
  );

  futureExpiries = expiries
    .filter(date => date >= today)
    .sort();

  if (futureExpiries.length === 0) {
    throw new Error(
      "No future Groww expiry found for NIFTY"
    );
  }

  return futureExpiries[0];
}


// --------------------------------------------------
// Fetch option chain
// --------------------------------------------------

async function fetchOptionChain() {
  if (!state.expiryDate) {
    state.expiryDate = await findNearestExpiry();

    console.log(
      "Nearest expiry selected:",
      state.expiryDate
    );
  }

  const url =
    "https://api.groww.in/v1/option-chain/" +
    `exchange/${encodeURIComponent(state.exchange)}/` +
    `underlying/${encodeURIComponent(state.symbol)}` +
    `?expiry_date=${encodeURIComponent(state.expiryDate)}`;

  const data = await growwGet(url);

  const payload =
    data?.payload || data;

  if (!payload?.strikes) {
    throw new Error(
      "Groww returned no option-chain strikes"
    );
  }

  return payload;
}


// --------------------------------------------------
// Convert Groww chain
// --------------------------------------------------

function convertGrowwChain(payload) {
  const rows = [];

  for (
    const [strikeText, contracts]
    of Object.entries(payload.strikes || {})
  ) {
    const strike = Number(strikeText);

    const ce = contracts?.CE || null;
    const pe = contracts?.PE || null;

    rows.push({
      strikePrice: strike,

      CE: ce
        ? {
            strikePrice: strike,
            lastPrice: ce.ltp ?? 0,
            openInterest: ce.open_interest ?? 0,
            totalTradedVolume: ce.volume ?? 0,

            delta: ce.greeks?.delta ?? null,
            gamma: ce.greeks?.gamma ?? null,
            theta: ce.greeks?.theta ?? null,
            vega: ce.greeks?.vega ?? null,
            rho: ce.greeks?.rho ?? null,
            impliedVolatility: ce.greeks?.iv ?? null,

            identifier: ce.trading_symbol ?? ""
          }
        : null,

      PE: pe
        ? {
            strikePrice: strike,
            lastPrice: pe.ltp ?? 0,
            openInterest: pe.open_interest ?? 0,
            totalTradedVolume: pe.volume ?? 0,

            delta: pe.greeks?.delta ?? null,
            gamma: pe.greeks?.gamma ?? null,
            theta: pe.greeks?.theta ?? null,
            vega: pe.greeks?.vega ?? null,
            rho: pe.greeks?.rho ?? null,
            impliedVolatility: pe.greeks?.iv ?? null,

            identifier: pe.trading_symbol ?? ""
          }
        : null
    });
  }

  rows.sort(
    (a, b) =>
      a.strikePrice - b.strikePrice
  );

  const totalCallOI =
    rows.reduce(
      (sum, row) =>
        sum + Number(row.CE?.openInterest || 0),
      0
    );

  const totalPutOI =
    rows.reduce(
      (sum, row) =>
        sum + Number(row.PE?.openInterest || 0),
      0
    );

  const pcr =
    totalCallOI > 0
      ? totalPutOI / totalCallOI
      : null;

  const support =
    [...rows]
      .filter(row => row.PE)
      .sort(
        (a, b) =>
          Number(b.PE?.openInterest || 0) -
          Number(a.PE?.openInterest || 0)
      )[0]?.strikePrice || null;

  const resistance =
    [...rows]
      .filter(row => row.CE)
      .sort(
        (a, b) =>
          Number(b.CE?.openInterest || 0) -
          Number(a.CE?.openInterest || 0)
      )[0]?.strikePrice || null;

  return {
    records: {
      underlyingValue:
        payload.underlying_ltp ?? null,

      data: rows
    },

    filtered: {
      data: rows
    },

    groww: {
      exchange: state.exchange,
      symbol: state.symbol,
      expiryDate: state.expiryDate,

      totalCallOI,
      totalPutOI,
      pcr,
      support,
      resistance
    }
  };
}


// --------------------------------------------------
// Refresh
// --------------------------------------------------

async function refreshNow() {
  if (state.refreshing) {
    return;
  }

  state.refreshing = true;

  try {
    const payload =
      await fetchOptionChain();

    state.latest =
      convertGrowwChain(payload);

    state.lastSuccessAt =
      Date.now();

    state.lastError = null;

  } catch (error) {

    console.error(
      "Groww error:",
      error.message
    );

    state.lastError = {
      message: error.message,
      at: Date.now()
    };

  } finally {

    state.refreshing = false;

  }
}


// --------------------------------------------------
// Configure
// --------------------------------------------------

app.post(
  "/api/configure",
  async (req, res) => {
    try {
      state.symbol =
        String(
          req.body?.symbol || "NIFTY"
        )
          .trim()
          .toUpperCase();

      state.exchange =
        String(
          req.body?.exchange || "NSE"
        )
          .trim()
          .toUpperCase();

      state.expiryDate = "";

      state.latest = null;
      state.lastError = null;

      await refreshNow();

      res
        .status(
          state.latest ? 200 : 502
        )
        .json({
          ok: !!state.latest,

          symbol: state.symbol,
          exchange: state.exchange,

          expiryDate:
            state.expiryDate || null,

          lastSuccessAt:
            state.lastSuccessAt || null,

          error:
            state.lastError
        });

    } catch (error) {

      res.status(400).json({
        ok: false,
        error: {
          message: error.message
        }
      });

    }
  }
);


// --------------------------------------------------
// Snapshot
// --------------------------------------------------

app.get(
  "/api/snapshot",
  async (_req, res) => {

    try {
      await refreshNow();
    } catch {}

    res.set(
      "Cache-Control",
      "no-store"
    );

    res.json({
      ok: !!state.latest,

      symbol: state.symbol,
      exchange: state.exchange,

      expiryDate:
        state.expiryDate || null,

      fetchedAt:
        state.lastSuccessAt || null,

      refreshing:
        state.refreshing,

      error:
        state.lastError,

      data:
        state.latest
    });
  }
);


// --------------------------------------------------
// Test authentication
// --------------------------------------------------

app.get(
  "/api/groww-test",
  async (_req, res) => {
    try {
      const token =
        await getAccessToken();

      res.json({
        ok: true,
        message:
          "Groww authentication successful",
        tokenReceived:
          !!token
      });

    } catch (error) {

      res.status(502).json({
        ok: false,
        error: {
          message:
            error.message
        }
      });

    }
  }
);


// --------------------------------------------------
// Test auto expiry
// --------------------------------------------------

app.get(
  "/api/expiry-test",
  async (_req, res) => {
    try {
      const expiry =
        await findNearestExpiry();

      res.json({
        ok: true,
        symbol: state.symbol,
        exchange: state.exchange,
        nearestExpiry: expiry
      });

    } catch (error) {

      res.status(502).json({
        ok: false,
        error: {
          message:
            error.message
        }
      });

    }
  }
);


// --------------------------------------------------
// Status
// --------------------------------------------------

app.get(
  "/api/status",
  (_req, res) => {

    res.json({
      ok: true,

      provider: "Groww",

      credentialsConfigured:
        !!(
          GROWW_API_KEY &&
          GROWW_API_SECRET
        ),

      symbol:
        state.symbol,

      exchange:
        state.exchange,

      expiryDate:
        state.expiryDate || null,

      hasData:
        !!state.latest,

      lastSuccessAt:
        state.lastSuccessAt || null,

      lastError:
        state.lastError
    });

  }
);


// --------------------------------------------------
// Health
// --------------------------------------------------

app.get(
  "/health",
  (_req, res) => {
    res.status(200).send("ok");
  }
);


// --------------------------------------------------
// Frontend
// --------------------------------------------------

app.get(
  "*",
  (_req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );
  }
);


// --------------------------------------------------
// Start
// --------------------------------------------------

app.listen(
  PORT,
  () => {
    console.log(
      `Groww NIFTY OI server running on port ${PORT}`
    );
  }
);
