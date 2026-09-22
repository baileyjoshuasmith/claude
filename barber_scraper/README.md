# Barber Shop Contact Collector

Finds independent barber shops for a given location via Google Programmable
Search, then pulls publicly listed contact info (name, address, phone,
email, social links) directly off each shop's own website. It never logs
into or scrapes booking platforms (Booksy, Fresha, etc.) directly -- only
whatever public pages a normal search result points at, and only after
checking that page's `robots.txt`.

## Setup

1. Create a Google Custom Search JSON API key and search engine ID:
   https://developers.google.com/custom-search/v1/overview
2. `export GOOGLE_API_KEY=...`
   `export GOOGLE_CSE_ID=...`
3. `pip install -r requirements.txt`

## Usage

```
python scraper.py --location "Austin, TX" --num-results 30 --output leads.csv
```

Output CSV columns: `source_url, name, address, phone, email, facebook,
instagram, tiktok, twitter, linkedin`.

## Notes / limits by design

- Respects `robots.txt` on every target site; pages that disallow the
  scraper's user agent are skipped, not bypassed.
- Rate-limited (`--delay`, default 2s between page fetches) and identifies
  itself with a descriptive `User-Agent` -- edit `USER_AGENT` in
  `scraper.py` to include a real contact if you plan to run this at volume.
- Only reads data that's already public on the page; it doesn't create
  accounts, log in, solve CAPTCHAs, or use any platform's private/internal
  API.
- Google search itself goes through the official Custom Search API, not by
  scraping Google's results page (which Google's ToS prohibits).
- If you plan to email or call the businesses this collects, check
  CAN-SPAM/TCPA (or your local equivalent) requirements before doing so --
  this tool only collects data, it doesn't handle consent or opt-outs.
