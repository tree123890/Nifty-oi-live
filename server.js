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


// --------------------------------------------------
// Groww authentication
// --------------------------------------------------

async function getAccessToken() {
  if (!GROWW_API_KEY || !GROWW_API_SECRET) {
    throw new Error(
      "Groww API credentials are missing in Render environment variables"
    );
  }

  // Reuse token if still cached
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

  // Cache for 30 minutes.
  // If Groww rejects it later, it will be regenerated.
  state.tokenExpiry =
    Date.now() + 30 * 60 * 1000;

  console.log("Groww access token generated");

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

  // Token may be stale
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
// Fetch Groww option chain
// --------------------------------------------------

async function fetchOptionChain() {
  if (!state.expiryDate) {
    throw new Error(
      "Expiry date is not configured"
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
// Convert Groww format to dashboard-friendly format
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
            openInterest:
              ce.open_interest ?? 0,
            totalTradedVolume:
              ce.volume ?? 0,

            delta:
              ce.greeks?.delta ?? null,
            gamma:
              ce.greeks?.gamma ?? null,
            theta:
              ce.greeks?.theta ?? null,
            vega:
              ce.greeks?.vega ?? null,
            rho:
              ce.greeks?.rho ?? null,
            impliedVolatility:
              ce.greeks?.iv ?? null,

            identifier:
              ce.trading_symbol ?? ""
          }
        : null,

      PE: pe
        ? {
            strikePrice: strike,
            lastPrice: pe.ltp ?? 0,
            openInterest:
              pe.open_interest ?? 0,
            totalTradedVolume:
              pe.volume ?? 0,

            delta:
              pe.greeks?.delta ?? null,
            gamma:
              pe.greeks?.gamma ?? null,
            theta:
              pe.greeks?.theta ?? null,
            vega:
              pe.greeks?.vega ?? null,
            rho:
              pe.greeks?.rho ?? null,
            impliedVolatility:
              pe.greeks?.iv ?? null,

            identifier:
              pe.trading_symbol ?? ""
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
        sum +
        Number(
          row.CE?.openInterest || 0
        ),
      0
    );

  const totalPutOI =
    rows.reduce(
      (sum, row) =>
        sum +
        Number(
          row.PE?.openInterest || 0
        ),
      0
    );

  const pcr =
    totalCallOI > 0
      ? totalPutOI / totalCallOI
      : null;

  const support =
    rows
      .filter((row) => row.PE)
      .sort(
        (a, b) =>
          Number(
            b.PE?.openInterest || 0
          ) -
          Number(
            a.PE?.openInterest || 0
          )
      )[0]?.strikePrice || null;

  const resistance =
    rows
      .filter((row) => row.CE)
      .sort(
        (a, b) =>
          Number(
            b.CE?.openInterest || 0
          ) -
          Number(
            a.CE?.openInterest || 0
          )
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
      exchange:
        state.exchange,

      symbol:
        state.symbol,

      expiryDate:
        state.expiryDate,

      totalCallOI,
      totalPutOI,
      pcr,
      support,
      resistance
    }
  };
}


// --------------------------------------------------
// Refresh cache
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

    console.log(
      "Groww option chain updated:",
      state.symbol,
      state.expiryDate
    );
  } catch (error) {
    console.error(
      "Groww error:",
      error.message
    );

    state.lastError = {
      message:
        error.message,

      at:
        Date.now()
    };
  } finally {
    state.refreshing = false;
  }
}


// --------------------------------------------------
// Configure
//
// Frontend can send:
// {
//   symbol: "NIFTY",
//   exchange: "NSE",
//   expiryDate: "2026-09-15"
// }
//
// --------------------------------------------------

app.post(
  "/api/configure",
  async (req, res) => {
    try {
      const symbol =
        String(
          req.body?.symbol || "NIFTY"
        )
          .trim()
          .toUpperCase();

      const exchange =
        String(
          req.body?.exchange || "NSE"
        )
          .trim()
          .toUpperCase();

      const expiryDate =
        String(
          req.body?.expiryDate || ""
        ).trim();

      if (!expiryDate) {
        return res.status(400).json({
          ok: false,

          error: {
            message:
              "expiryDate is required in YYYY-MM-DD format"
          }
        });
      }

      state.symbol = symbol;
      state.exchange = exchange;
      state.expiryDate = expiryDate;

      state.latest = null;
      state.lastError = null;

      await refreshNow();

      res
        .status(
          state.latest ? 200 : 502
        )
        .json({
          ok:
            !!state.latest,

          symbol:
            state.symbol,

          exchange:
            state.exchange,

          expiryDate:
            state.expiryDate,

          lastSuccessAt:
            state.lastSuccessAt || null,

          error:
            state.lastError
        });
    } catch (error) {
      res.status(400).json({
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
// Snapshot
// --------------------------------------------------

app.get(
  "/api/snapshot",
  async (_req, res) => {
    if (state.expiryDate) {
      try {
        await refreshNow();
      } catch {}
    }

    res.set(
      "Cache-Control",
      "no-store"
    );

    res.json({
      ok:
        !!state.latest,

      symbol:
        state.symbol,

      exchange:
        state.exchange,

      expiryDate:
        state.expiryDate,

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
// Groww connection test
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
// Status
// --------------------------------------------------

app.get(
  "/api/status",
  (_req, res) => {
    res.json({
      ok: true,

      provider:
        "Groww",

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
        state.expiryDate,

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
    res
      .status(200)
      .send("ok");
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
