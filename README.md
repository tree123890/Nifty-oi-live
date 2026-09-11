# NIFTY OI Live URL Analyzer — v2

This version is built around the exact workflow requested:

1. Paste:
   `https://www.nseindia.com/get-quote/optionchain/NIFTY/NIFTY-50`
2. Click **Start Live**
3. The browser sends that URL to the local Node.js backend.
4. The backend visits that exact NSE page to establish NSE cookies/session.
5. It then requests the corresponding NSE option-chain JSON.
6. The dashboard recalculates OI metrics and refreshes every **1 second**.

## Run

```bash
npm install
npm start
```

Then open:

`http://localhost:3000`

## What it calculates

- Current NIFTY underlying value
- Call OI / Put OI
- Change in OI
- OI PCR
- CE / PE build-up classification
- Estimated OI support
- Estimated OI resistance
- Bullish / Bearish / Range-bound one-line summary
- ATM-centered strike view

## Important NSE limitation

NSE actively rate-limits/blocks some automated requests. A 1-second refresh interval is especially aggressive and may cause HTTP 401/403/429 responses or temporary blocking.

This build refreshes every 1 second because that is the requested behavior. For a production deployment, 3–5 seconds or an official/paid market-data feed is more reliable.

Also note that the visible NSE webpage URL is not itself a JSON feed. The server must first open that page to obtain NSE session cookies, then call the option-chain data endpoint behind the page.

## Security

The server accepts only URLs whose hostname is `nseindia.com` or `www.nseindia.com` and whose path contains `optionchain`, to avoid turning the backend into an unrestricted URL proxy.

## Disclaimer

Educational analysis only. OI-derived market direction is probabilistic, not a trading recommendation.
