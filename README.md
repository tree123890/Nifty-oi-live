# NIFTY OI Live — Mobile v3

This version is designed to work as a normal hosted mobile website.

## What changed

- Responsive mobile UI.
- Paste the NSE option-chain page URL:
  `https://www.nseindia.com/get-quote/optionchain/NIFTY/NIFTY-50`
- Server opens the NSE page to establish a session, then fetches option-chain JSON.
- Mobile UI refreshes every **1 second**.
- The server caches data and requests NSE only about every **5 seconds** by default, reducing rate-limit problems.
- When NSE temporarily blocks a request, the last good snapshot stays on screen and the app automatically retries.
- Shows LIVE / RETRYING / NETWORK connection state.
- Includes `render.yaml` for easy Render deployment.
- Includes `Dockerfile` for any Docker-capable host.

## Run on a computer

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Put it online for mobile use

The app must be hosted; do not open `index.html` directly.

### Render
1. Create a GitHub repository and upload the files from this folder.
2. In Render, create a new Blueprint/Web Service from that repository.
3. Render reads `render.yaml`.
4. After deployment it gives you a public HTTPS URL.
5. Open that URL on your phone.

### Other Node hosts
Any host that can run Node 18+ works. Use:
- Build: `npm install`
- Start: `npm start`
- Health check: `/health`

## Refresh behavior

The browser asks the app server for a snapshot every 1 second.
The app server requests NSE no more often than `NSE_MIN_INTERVAL_MS` (default 5000 ms).

You may set:
`NSE_MIN_INTERVAL_MS=3000`

Going to 1000 ms is possible but is much more likely to be rate-limited.

## Important

NSE may change endpoints, anti-bot rules, or rate limits. The public NSE page also states restrictions on aggregation/copying of its website data. For a production/commercial trading tool, use an authorized market-data feed or broker API.

## OI logic

Price up + OI up = Long build-up  
Price down + OI up = Short build-up  
Price up + OI down = Short covering  
Price down + OI down = Long unwinding

Directional scoring gives additional weight to PE short build-up and CE short build-up near ATM, and uses OI PCR as a secondary filter.

Educational use only.
