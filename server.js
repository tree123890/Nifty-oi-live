const express = require("express");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;
const NSE_MIN_INTERVAL_MS = Number(
  process.env.NSE_MIN_INTERVAL_MS || 5000
);

app.use(express.json({ limit: "1mb" }));

app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-cache");
    }
  })
);


// --------------------------------------------------
// Browser headers
// --------------------------------------------------

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/128.0 Safari/537.36";

const commonHeaders = {
  "User-Agent": UA,
  "Accept-Language": "en-US,en;q=0.9",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  Connection: "keep-alive"
};


// --------------------------------------------------
// App state
// --------------------------------------------------

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


// --------------------------------------------------
// Validate NSE URL
// --------------------------------------------------

function validateSourceUrl(input) {
  let u;

  try {
    u = new URL(input);
  } catch {
    throw new Error("Invalid URL");
  }

  if (
    !["nseindia.com", "www.nseindia.com"].includes(u.hostname)
  ) {
    throw new Error("Only NSE India URLs are supported");
  }

  if (
    !u.pathname.toLowerCase().includes("optionchain") &&
    !u.pathname.toLowerCase().includes("option-chain")
  ) {
    throw new Error(
      "Please paste an NSE option-chain page URL"
    );
  }

  return u;
}


// --------------------------------------------------
// Detect symbol
// --------------------------------------------------

function inferSymbol(u) {
  const querySymbol = u.searchParams.get("symbol");

  if (querySymbol) {
    return querySymbol.toUpperCase();
  }

  const parts = u.pathname
    .split("/")
    .filter(Boolean);

  const optionIndex = parts.findIndex((x) => {
    const lower = x.toLowerCase();

    return (
      lower === "optionchain" ||
      lower === "option-chain"
    );
  });

  if (
    optionIndex >= 0 &&
    parts[optionIndex + 1]
  ) {
    return decodeURIComponent(
      parts[optionIndex + 1]
    ).toUpperCase();
  }

  return "NIFTY";
}


// --------------------------------------------------
// Cookie parser
// --------------------------------------------------

function parseCookies(headers) {
  try {
    if (headers.getSetCookie) {
      const values = headers.getSetCookie();

      if (values && values.length) {
        return values
          .map((v) => v.split(";")[0])
          .join("; ");
      }
    }
  } catch {}

  const raw = headers.get("set-cookie");

  if (!raw) {
    return "";
  }

  return raw
    .split(/,(?=[^;,]+=)/)
    .map((v) => v.split(";")[0])
    .join("; ");
}


// --------------------------------------------------
// Create NSE session
// --------------------------------------------------

async function seedSession(sourceUrl) {
  console.log("Creating NSE session...");

  /*
   * Step 1:
   * Visit NSE homepage first.
   */

  const home = await fetch(
    "https://www.nseindia.com/",
    {
      headers: commonHeaders,
      redirect: "follow",
      cache: "no-store"
    }
  );

  if (!home.ok) {
    throw new Error(
      `NSE home HTTP ${home.status}`
    );
  }

  const homeCookies =
    parseCookies(home.headers);

  await home.text();

  let cookies = homeCookies;


  /*
   * Step 2:
   * Visit the NSE page supplied by user.
   */

  const pageHeaders = {
    ...commonHeaders,
    Referer: "https://www.nseindia.com/"
  };

  if (cookies) {
    pageHeaders.Cookie = cookies;
  }

  const page = await fetch(sourceUrl, {
    headers: pageHeaders,
    redirect: "follow",
    cache: "no-store"
  });

  if (!page.ok) {
    throw new Error(
      `NSE option page HTTP ${page.status}`
    );
  }

  const pageCookies =
    parseCookies(page.headers);

  await page.text();

  if (pageCookies) {
    cookies = cookies
      ? `${cookies}; ${pageCookies}`
      : pageCookies;
  }

  state.cookie = cookies;
  state.cookieAt = Date.now();

  console.log(
    "NSE session created:",
    !!state.cookie
  );
}


// --------------------------------------------------
// Request NSE option chain
// --------------------------------------------------

async function requestNse(
  sourceUrl,
  symbol
) {
  /*
   * Refresh cookies after 8 minutes.
   */

  if (
    !state.cookie ||
    Date.now() - state.cookieAt >
      8 * 60 * 1000
  ) {
    await seedSession(sourceUrl);
  }


  const api =
    "https://www.nseindia.com/api/" +
    "option-chain-indices?symbol=" +
    encodeURIComponent(symbol);


  async function doRequest() {
    const headers = {
      "User-Agent": UA,

      Accept:
        "application/json,text/plain,*/*",

      "Accept-Language":
        "en-US,en;q=0.9",

      Referer:
        "https://www.nseindia.com/",

      Connection:
        "keep-alive"
    };

    if (state.cookie) {
      headers.Cookie = state.cookie;
    }

    return fetch(api, {
      headers,
      redirect: "follow",
      cache: "no-store"
    });
  }


  let response =
    await doRequest();


  /*
   * NSE sometimes invalidates
   * a session.
   */

  if (
    response.status === 401 ||
    response.status === 403
  ) {
    console.log(
      "NSE rejected session. Retrying..."
    );

    state.cookie = "";
    state.cookieAt = 0;

    await seedSession(sourceUrl);

    response =
      await doRequest();
  }


  /*
   * Read body as text first.
   * This prevents:
   *
   * Unexpected token '<'
   *
   * when NSE returns HTML instead
   * of JSON.
   */

  const contentType =
    response.headers.get(
      "content-type"
    ) || "";

  const body =
    await response.text();


  console.log(
    "NSE response:",
    response.status,
    contentType
  );


  /*
   * HTTP failure
   */

  if (!response.ok) {
    const error = new Error(
      `NSE API HTTP ${response.status}`
    );

    error.status =
      response.status;

    throw error;
  }


  /*
   * HTML returned instead of JSON
   */

  const trimmed =
    body.trim();

  if (
    trimmed.startsWith("<") ||
    contentType
      .toLowerCase()
      .includes("text/html")
  ) {
    throw new Error(
      "NSE returned HTML instead of JSON. " +
      "The NSE website may be blocking requests " +
      "from the Render server."
    );
  }


  /*
   * Parse JSON safely
   */

  let data;

  try {
    data =
      JSON.parse(body);
  } catch {
    throw new Error(
      "Could not parse NSE option-chain JSON"
    );
  }


  /*
   * Validate expected data
   */

  if (
    !data ||
    !data.records ||
    !Array.isArray(
      data.records.data
    ) ||
    data.records.data.length === 0
  ) {
    throw new Error(
      "NSE returned no option-chain rows"
    );
  }


  return data;
}


// --------------------------------------------------
// Refresh option-chain cache
// --------------------------------------------------

async function refreshNow(
  force = false
) {
  if (!state.sourceUrl) {
    throw new Error(
      "No NSE URL configured"
    );
  }


  if (state.refreshing) {
    return;
  }


  if (
    !force &&
    Date.now() -
      state.lastAttemptAt <
      NSE_MIN_INTERVAL_MS
  ) {
    return;
  }


  state.refreshing = true;
  state.lastAttemptAt =
    Date.now();


  try {
    const data =
      await requestNse(
        state.sourceUrl,
        state.symbol
      );


    state.latest = data;

    state.lastSuccessAt =
      Date.now();

    state.lastError = null;


    console.log(
      "NSE data updated:",
      state.symbol,
      new Date().toISOString()
    );

  } catch (error) {

    console.error(
      "NSE fetch error:",
      error.message
    );


    state.lastError = {
      message:
        error.message,

      at:
        Date.now(),

      status:
        error.status || null
    };

  } finally {

    state.refreshing = false;

  }
}


// --------------------------------------------------
// Configure NSE source
// --------------------------------------------------

app.post(
  "/api/configure",
  async (req, res) => {

    try {

      const u =
        validateSourceUrl(
          req.body?.url || ""
        );


      state.sourceUrl =
        u.toString();


      state.symbol =
        inferSymbol(u);


      state.cookie = "";
      state.cookieAt = 0;

      state.latest = null;
      state.lastError = null;


      console.log(
        "Configured:",
        state.symbol,
        state.sourceUrl
      );


      await refreshNow(true);


      res
        .status(
          state.latest
            ? 200
            : 502
        )
        .json({

          ok:
            !!state.latest,

          symbol:
            state.symbol,

          sourceUrl:
            state.sourceUrl,

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
// Snapshot endpoint
// --------------------------------------------------

app.get(
  "/api/snapshot",
  async (_req, res) => {

    try {
      await refreshNow(false);
    } catch {}


    res.set(
      "Cache-Control",
      "no-store"
    );


    res.json({

      ok:
        !!state.latest,

      symbol:
        state.symbol,

      sourceUrl:
        state.sourceUrl,

      fetchedAt:
        state.lastSuccessAt ||
        null,

      ageMs:
        state.lastSuccessAt
          ? Date.now() -
            state.lastSuccessAt
          : null,

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
// Status endpoint
// --------------------------------------------------

app.get(
  "/api/status",
  (_req, res) => {

    res.json({

      ok: true,

      configured:
        !!state.sourceUrl,

      hasData:
        !!state.latest,

      symbol:
        state.symbol,

      nseMinIntervalMs:
        NSE_MIN_INTERVAL_MS,

      lastSuccessAt:
        state.lastSuccessAt ||
        null,

      lastError:
        state.lastError

    });

  }
);


// --------------------------------------------------
// Health endpoint
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
// Start server
// --------------------------------------------------

app.listen(PORT, () => {

  console.log(
    `NIFTY OI Mobile running on port ${PORT}`
  );

});
