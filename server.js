const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const GROWW_API_KEY = process.env.GROWW_API_KEY;
const GROWW_API_SECRET = process.env.GROWW_API_SECRET;

const INSTRUMENT_CSV_URL =
  "https://growwapi-assets.groww.in/instruments/instrument.csv";

app.use(express.json({ limit: "1mb" }));

app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-cache");
    }
  })
);

const state = {
  accessToken: null,
  tokenExpiry: 0,

  symbol: "NIFTY",
  exchange: "NSE",
  expiryDate: "",

  instrumentRows: null,
  instrumentRowsAt: 0,

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

function todayIST() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const year =
    parts.find(p => p.type === "year")?.value;

  const month =
    parts.find(p => p.type === "month")?.value;

  const day =
    parts.find(p => p.type === "day")?.value;

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

  const timestamp =
    Math.floor(Date.now() / 1000).toString();

  const checksum =
    generateChecksum(
      GROWW_API_SECRET,
      timestamp
    );

  const response = await fetch(
    "https://api.groww.in/v1/token/api/access",
    {
      method: "POST",

      headers: {
        Authorization:
          `Bearer ${GROWW_API_KEY}`,

        "Content-Type":
          "application/json",

        Accept:
          "application/json"
      },

      body: JSON.stringify({
        key_type: "approval",
        checksum,
        timestamp
      })
    }
  );

  const text =
    await response.text();

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

  state.tokenExpiry =
    Date.now() + 30 * 60 * 1000;

  console.log(
    "Groww access token generated"
  );

  return token;
}


// --------------------------------------------------
// Generic Groww GET
// --------------------------------------------------

async function growwGet(url) {
  let token =
    await getAccessToken();

  async function doRequest() {
    return fetch(url, {
      method: "GET",

      headers: {
        Accept:
          "application/json",

        Authorization:
          `Bearer ${token}`,

        "X-API-VERSION":
          "1.0"
      },

      cache:
        "no-store"
    });
  }

  let response =
    await doRequest();

  if (
    response.status === 401 ||
    response.status === 403
  ) {
    state.accessToken = null;
    state.tokenExpiry = 0;

    token =
      await getAccessToken();

    response =
      await doRequest();
  }

  const text =
    await response.text();

  let data;

  try {
    data =
      JSON.parse(text);
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
// CSV parser
// --------------------------------------------------

function parseCsvLine(line) {
  const values = [];

  let current = "";
  let insideQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (
        insideQuotes &&
        line[i + 1] === '"'
      ) {
        current += '"';
        i++;
      } else {
        insideQuotes =
          !insideQuotes;
      }
    } else if (
      char === "," &&
      !insideQuotes
    ) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current);

  return values;
}

function parseInstrumentCsv(csv) {
  const lines =
    csv
      .split(/\r?\n/)
      .filter(line => line.trim());

  if (!lines.length) {
    throw new Error(
      "Groww instrument CSV is empty"
    );
  }

  const headers =
    parseCsvLine(lines[0])
      .map(header => header.trim());

  const rows = [];

  for (const line of lines.slice(1)) {
    const values =
      parseCsvLine(line);

    const row = {};

    headers.forEach(
      (header, index) => {
        row[header] =
          values[index]?.trim() || "";
      }
    );

    rows.push(row);
  }

  return rows;
}


// --------------------------------------------------
// Download Groww instrument master
// --------------------------------------------------

async function getInstrumentRows() {
  const cacheDuration =
    30 * 60 * 1000;

  if (
    state.instrumentRows &&
    Date.now() -
      state.instrumentRowsAt <
      cacheDuration
  ) {
    return state.instrumentRows;
  }

  console.log(
    "Downloading Groww instrument master..."
  );

  const response =
    await fetch(
      INSTRUMENT_CSV_URL,
      {
        method: "GET",
        cache: "no-store"
      }
    );

  if (!response.ok) {
    throw new Error(
      `Groww instrument CSV HTTP ${response.status}`
    );
  }

  const csv =
    await response.text();

  const rows =
    parseInstrumentCsv(csv);

  state.instrumentRows =
    rows;

  state.instrumentRowsAt =
    Date.now();

  console.log(
    "Groww instrument rows loaded:",
    rows.length
  );

  return rows;
}


// --------------------------------------------------
// Find nearest NIFTY expiry automatically
// --------------------------------------------------

async function findNearestExpiry() {
  const rows =
    await getInstrumentRows();

  const today =
    todayIST();

  const matchingRows =
    rows.filter(row => {
      const exchange =
        String(
          row.exchange || ""
        ).toUpperCase();

      const segment =
        String(
          row.segment || ""
        ).toUpperCase();

      const underlying =
        String(
          row.underlying_symbol || ""
        ).toUpperCase();

      const instrumentType =
        String(
          row.instrument_type || ""
        ).toUpperCase();

      const expiry =
        String(
          row.expiry_date || ""
        );

      return (
        exchange === state.exchange &&
        segment === "FNO" &&
        underlying === state.symbol &&
        (
          instrumentType === "CE" ||
          instrumentType === "PE"
        ) &&
        expiry &&
        expiry >= today
      );
    });

  const expiries =
    matchingRows.map(
      row => row.expiry_date
    );

  const uniqueExpiries =
    [...new Set(expiries)]
      .sort();

  if (
    uniqueExpiries.length === 0
  ) {
    throw new Error(
      `No future ${state.symbol} option expiries found in Groww instrument master`
    );
  }

  return uniqueExpiries[0];
}


// --------------------------------------------------
// Fetch option chain
// --------------------------------------------------

async function fetchOptionChain() {
  if (!state.expiryDate) {
    state.expiryDate =
      await findNearestExpiry();

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

  const data =
    await growwGet(url);

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
// Convert Groww option chain
// --------------------------------------------------

function convertGrowwChain(payload) {
  const rows = [];

  for (
    const [strikeText, contracts]
    of Object.entries(
      payload.strikes || {}
    )
  ) {
    const strike =
      Number(strikeText);

    const ce =
      contracts?.CE || null;

    const pe =
      contracts?.PE || null;

    rows.push({
      strikePrice:
        strike,

      CE: ce
        ? {
            strikePrice:
              strike,

            lastPrice:
              ce.ltp ?? 0,

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
            strikePrice:
              strike,

            lastPrice:
              pe.ltp ?? 0,

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
      a.strikePrice -
      b.strikePrice
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
      ? totalPutOI /
        totalCallOI
      : null;

  const putRows =
    [...rows]
      .filter(row => row.PE);

  const callRows =
    [...rows]
      .filter(row => row.CE);

  putRows.sort(
    (a, b) =>
      Number(
        b.PE?.openInterest || 0
      ) -
      Number(
        a.PE?.openInterest || 0
      )
  );

  callRows.sort(
    (a, b) =>
      Number(
        b.CE?.openInterest || 0
      ) -
      Number(
        a.CE?.openInterest || 0
      )
  );

  const support =
    putRows[0]?.strikePrice ||
    null;

  const resistance =
    callRows[0]?.strikePrice ||
    null;

  return {
    records: {
      underlyingValue:
        payload.underlying_ltp ??
        payload.underlyingLtp ??
        null,

      data:
        rows
    },

    filtered: {
      data:
        rows
    },

    groww: {
      provider:
        "Groww",

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
// Refresh live data
// --------------------------------------------------

async function refreshNow() {
  if (state.refreshing) {
    return;
  }

  state.refreshing =
    true;

  try {
    const payload =
      await fetchOptionChain();

    state.latest =
      convertGrowwChain(
        payload
      );

    state.lastSuccessAt =
      Date.now();

    state.lastError =
      null;

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

    state.refreshing =
      false;

  }
}


// --------------------------------------------------
// Configure symbol
// --------------------------------------------------

app.post(
  "/api/configure",
  async (req, res) => {

    try {

      const requestedSymbol =
        String(
          req.body?.symbol ||
          "NIFTY"
        )
          .trim()
          .toUpperCase();

      const requestedExchange =
        String(
          req.body?.exchange ||
          "NSE"
        )
          .trim()
          .toUpperCase();

      state.symbol =
        requestedSymbol;

      state.exchange =
        requestedExchange;

      state.expiryDate =
        "";

      state.latest =
        null;

      state.lastError =
        null;

      await refreshNow();

      res
        .status(
          state.latest
            ? 200
            : 502
        )
        .json({
          ok:
            !!state.latest,

          provider:
            "Groww",

          symbol:
            state.symbol,

          exchange:
            state.exchange,

          expiryDate:
            state.expiryDate ||
            null,

          lastSuccessAt:
            state.lastSuccessAt ||
            null,

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

    try {
      await refreshNow();
    } catch {}

    res.set(
      "Cache-Control",
      "no-store"
    );

    res.json({
      ok:
        !!state.latest,

      provider:
        "Groww",

      symbol:
        state.symbol,

      exchange:
        state.exchange,

      expiryDate:
        state.expiryDate ||
        null,

      fetchedAt:
        state.lastSuccessAt ||
        null,

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
// Groww authentication test
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
// Automatic expiry test
// --------------------------------------------------

app.get(
  "/api/expiry-test",
  async (_req, res) => {

    try {

      const expiry =
        await findNearestExpiry();

      res.json({
        ok: true,

        provider:
          "Groww instrument master",

        symbol:
          state.symbol,

        exchange:
          state.exchange,

        nearestExpiry:
          expiry
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
// Full option-chain test
// --------------------------------------------------

app.get(
  "/api/chain-test",
  async (_req, res) => {

    try {

      state.expiryDate =
        await findNearestExpiry();

      const payload =
        await fetchOptionChain();

      const converted =
        convertGrowwChain(
          payload
        );

      res.json({
        ok: true,

        provider:
          "Groww",

        symbol:
          state.symbol,

        exchange:
          state.exchange,

        expiryDate:
          state.expiryDate,

        underlyingValue:
          converted.records
            .underlyingValue,

        numberOfStrikes:
          converted.records
            .data.length,

        totalCallOI:
          converted.groww
            .totalCallOI,

        totalPutOI:
          converted.groww
            .totalPutOI,

        pcr:
          converted.groww
            .pcr,

        support:
          converted.groww
            .support,

        resistance:
          converted.groww
            .resistance
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
        state.expiryDate ||
        null,

      instrumentMasterLoaded:
        !!state.instrumentRows,

      hasData:
        !!state.latest,

      lastSuccessAt:
        state.lastSuccessAt ||
        null,

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
// Frontend fallback
//
// Important:
// We use app.use instead of app.get("*")
// because some newer Express/path-to-regexp
// versions reject the "*" route.
// --------------------------------------------------

app.use(
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
// Start server
// --------------------------------------------------

app.listen(
  PORT,
  () => {

    console.log(
      `Groww NIFTY OI server running on port ${PORT}`
    );

  }
);
