# Leads-GenX — Sales Navigator Scout (Chrome extension)

A Manifest V3 Chrome extension that scrapes LinkedIn Sales Navigator
lead-search results and sends them straight into your Leads-GenX server.
No build step, no npm, no external libraries — plain JavaScript.

## 1. Install (load unpacked)

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** and select this `extension/` folder.
4. The extension "Leads-GenX — Sales Navigator Scout" now appears in your
   toolbar (pin it via the puzzle-piece icon for easy access).

## 2. Connect it to your Leads-GenX server

1. Open Leads-GenX in your browser and go to the **LinkedIn** tab.
2. Copy your **extension key** from the key card there (Reveal → Copy).
3. Click the extension's toolbar icon to open the popup.
4. Fill in:
   - **Server URL** — e.g. `https://leadsgenx.top` (prefilled by default)
   - **Extension key** — the token you just copied
5. Click **Save**, then **Test connection**. You should see
   "Connected as \<your username\>" in green.

## 3. Scrape a Sales Navigator search

1. In LinkedIn Sales Navigator, open a **lead search** results page
   (any `https://www.linkedin.com/sales/...` URL).
2. Open the extension popup and click **Start scraping**.
3. A small badge appears at the bottom-right of the page
   ("Leads-GenX · N captured"). The extension walks through the result
   pages automatically (with human-like pauses, a 20 s cooling break every
   10 pages, and a hard cap of 100 pages).
4. Click **Stop** (in the badge or the popup) at any time to end the session
   early. The session also ends by itself when there are no more pages.

## 4. Where the leads show up

- **LinkedIn tab → Extension runs** — one run per scraping session, with
  live lead counts and status.
- **Leads table** — the captured leads themselves (name, title, company,
  location, connection degree, clickable LinkedIn profile link).

## Troubleshooting

- **"Invalid extension token"** — regenerate your key in the LinkedIn tab
  and paste the new one into the popup.
- **Start is greyed out** — you must be on a `linkedin.com/sales` page and
  have a saved server URL + extension key.
- **Nothing gets scraped** — LinkedIn changes its markup from time to time;
  the fallback selectors live at the top of `content.js`.
- Leads are queued in the browser and retried automatically (2 s / 8 s / 20 s
  backoff); if the server is briefly unreachable nothing is lost.
