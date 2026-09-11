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

  instrumentCsv: null,
  instrumentCsvAt: 0,

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
  const parts =
    new Intl.DateTimeFormat("en-CA", {
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
      .map(x => x.trim());

  return lines
    .slice(1)
    .map(line => {
      const values =
        parseCsvLine(line);

      const row = {};

      headers.forEach(
        (header, index) => {
          row[header] =
            values[index]?.trim() || "";
        }
      );

      return row;
    });
}


// --------------------------------------------------
// Download Groww instrument master
// --------------------------------------------------

async function getInstrumentRows() {
  const maxAge =
    30 * 60 * 1000;

  if (
    state.instrumentCsv &&
    Date.now() -
      state.instrumentCsvAt <
      maxAge
  ) {
    return state.instrumentCsv;
  }

  console.log(
    "Downloading Groww instrument master..."
  );

  const response =
    await fetch(
      INSTRUMENT_CSV_URL,
      {
        cache:
          "no-store"
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

  state.instrumentCsv =
    rows;

  state.instrumentCsvAt =
    Date.now();

  console.log(
    "Instrument rows loaded:",
    rows.length
  );

  return rows;
}


// --------------------------------------------------
// Find nearest current expiry
// --------------------------------------------------

async function findNearestExpiry() {
  const rows =
    await getInstrumentRows();

  const today =
    todayIST();

  const expiries =
    rows
      .filter(row => {
        return (
          row.exchange?.toUpperCase() ===
            state.exchange &&

          row.segment?.toUpperCase() ===
            "FNO" &&

          row.underlying_symbol?.toUpperCase() ===
            state
