async function requestNse(sourceUrl, symbol) {
  if (!state.cookie || Date.now() - state.cookieAt > 8 * 60 * 1000) {
    await seedSession(sourceUrl);
  }

  const api =
    `https://www.nseindia.com/api/option-chain-indices?symbol=${encodeURIComponent(symbol)}`;

  async function doReq() {
    return fetch(api, {
      headers: {
        "User-Agent": UA,
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": `https://www.nseindia.com/get-quotes/derivatives?symbol=${encodeURIComponent(symbol)}`,
        "Cookie": state.cookie,
        "Connection": "keep-alive"
      },
      redirect: "follow",
      cache: "no-store"
    });
  }

  let r = await doReq();

  if ([401, 403].includes(r.status)) {
    console.log("NSE rejected session. Creating new session...");

    state.cookie = "";
    state.cookieAt = 0;

    await seedSession(sourceUrl);
    r = await doReq();
  }

  const contentType = r.headers.get("content-type") || "";
  const body = await r.text();

  console.log(
    "NSE response:",
    r.status,
    contentType,
    body.substring(0, 100)
  );

  if (!r.ok) {
    const e = new Error(`NSE API HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }

  if (
    !contentType.toLowerCase().includes("json") ||
    body.trim().startsWith("<")
  ) {
    throw new Error(
      "NSE returned HTML instead of option-chain JSON. NSE may be blocking the Render server."
    );
  }

  let data;

  try {
    data = JSON.parse(body);
  } catch {
    throw new Error("Unable to parse NSE option-chain response");
  }

  if (!data?.records?.data?.length) {
    throw new Error("NSE returned no option-chain rows");
  }

  return data;
}
