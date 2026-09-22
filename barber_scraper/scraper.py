#!/usr/bin/env python3
"""
Barber shop contact-info collector.

Finds independent barber shops via the Google Programmable Search Engine
(Custom Search JSON API) and pulls publicly listed contact details
(name, address, phone, email, social links) straight off each shop's own
public web page. It does not log in to, or scrape data out of, booking
platforms like Booksy/Fresha directly -- only pages that a plain search
result points at, and only after checking that page's robots.txt.

Setup:
    1. Create a Google Custom Search JSON API key + search engine ID:
       https://developers.google.com/custom-search/v1/overview
    2. export GOOGLE_API_KEY=...
       export GOOGLE_CSE_ID=...
    3. pip install -r requirements.txt

Usage:
    python scraper.py --location "Austin, TX" --num-results 30 --output leads.csv
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
from dataclasses import asdict, dataclass, fields
from urllib import robotparser
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup

USER_AGENT = "BarberMarketResearchBot/1.0 (+contact: set-your-contact-email-here)"
GOOGLE_SEARCH_URL = "https://www.googleapis.com/customsearch/v1"

SOCIAL_DOMAINS = {
    "facebook": "facebook.com",
    "instagram": "instagram.com",
    "tiktok": "tiktok.com",
    "twitter": ("twitter.com", "x.com"),
    "linkedin": "linkedin.com",
}

EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
PHONE_RE = re.compile(r"(\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}")

_robots_cache: dict[str, robotparser.RobotFileParser] = {}


@dataclass
class BarberListing:
    source_url: str
    name: str = ""
    address: str = ""
    phone: str = ""
    email: str = ""
    facebook: str = ""
    instagram: str = ""
    tiktok: str = ""
    twitter: str = ""
    linkedin: str = ""


def google_search(query: str, api_key: str, cse_id: str, num_results: int) -> list[str]:
    """Return result URLs from the Google Custom Search JSON API (max 10 per page)."""
    urls: list[str] = []
    start = 1
    session = requests.Session()
    while len(urls) < num_results:
        page_size = min(10, num_results - len(urls))
        params = {
            "key": api_key,
            "cx": cse_id,
            "q": query,
            "num": page_size,
            "start": start,
        }
        resp = session.get(GOOGLE_SEARCH_URL, params=params, timeout=15)
        resp.raise_for_status()
        items = resp.json().get("items", [])
        if not items:
            break
        urls.extend(item["link"] for item in items if "link" in item)
        start += page_size
        if start > 91:  # API only paginates through ~100 results
            break
    return urls[:num_results]


def robots_allows(url: str) -> bool:
    """Check robots.txt for the URL's origin before we fetch it."""
    parsed = urlparse(url)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    rp = _robots_cache.get(origin)
    if rp is None:
        rp = robotparser.RobotFileParser()
        rp.set_url(f"{origin}/robots.txt")
        try:
            rp.read()
        except Exception:
            # If robots.txt can't be fetched/parsed, default to not scraping.
            rp = None
        _robots_cache[origin] = rp
    if rp is None:
        return False
    return rp.can_fetch(USER_AGENT, url)


def fetch(url: str, timeout: float = 15.0) -> str | None:
    try:
        resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=timeout)
        resp.raise_for_status()
        return resp.text
    except requests.RequestException:
        return None


def _from_json_ld(soup: BeautifulSoup) -> dict:
    """Pull structured name/address/phone out of schema.org JSON-LD if present."""
    out = {}
    for tag in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(tag.string or "")
        except (json.JSONDecodeError, TypeError):
            continue
        candidates = data if isinstance(data, list) else [data]
        for entry in candidates:
            if not isinstance(entry, dict):
                continue
            entry_type = entry.get("@type", "")
            if isinstance(entry_type, list):
                is_business = any("Business" in t or "Barber" in t for t in entry_type)
            else:
                is_business = "Business" in str(entry_type) or "Barber" in str(entry_type)
            if not is_business:
                continue
            if entry.get("name"):
                out["name"] = entry["name"]
            if entry.get("telephone"):
                out["phone"] = entry["telephone"]
            if entry.get("email"):
                out["email"] = entry["email"]
            addr = entry.get("address")
            if isinstance(addr, dict):
                parts = [
                    addr.get("streetAddress", ""),
                    addr.get("addressLocality", ""),
                    addr.get("addressRegion", ""),
                    addr.get("postalCode", ""),
                ]
                out["address"] = ", ".join(p for p in parts if p)
            elif isinstance(addr, str):
                out["address"] = addr
    return out


def extract_contact_info(html: str, url: str) -> BarberListing:
    soup = BeautifulSoup(html, "html.parser")
    listing = BarberListing(source_url=url)

    structured = _from_json_ld(soup)
    listing.name = structured.get("name", "")
    listing.address = structured.get("address", "")
    listing.phone = structured.get("phone", "")
    listing.email = structured.get("email", "")

    if not listing.name:
        title = soup.find("meta", property="og:title") or soup.find("title")
        if title:
            listing.name = (title.get("content") or title.get_text() or "").strip()

    page_text = soup.get_text(" ", strip=True)

    if not listing.email:
        mailto = soup.select_one('a[href^="mailto:"]')
        if mailto:
            listing.email = mailto["href"].split("mailto:")[1].split("?")[0]
        else:
            match = EMAIL_RE.search(page_text)
            if match:
                listing.email = match.group(0)

    if not listing.phone:
        tel = soup.select_one('a[href^="tel:"]')
        if tel:
            listing.phone = tel["href"].split("tel:")[1]
        else:
            match = PHONE_RE.search(page_text)
            if match:
                listing.phone = match.group(0)

    for link in soup.find_all("a", href=True):
        href = link["href"]
        for field_name, domain in SOCIAL_DOMAINS.items():
            domains = (domain,) if isinstance(domain, str) else domain
            if any(d in href for d in domains) and not getattr(listing, field_name):
                setattr(listing, field_name, href)

    return listing


def collect(query: str, num_results: int, delay: float) -> list[BarberListing]:
    api_key = os.environ.get("GOOGLE_API_KEY")
    cse_id = os.environ.get("GOOGLE_CSE_ID")
    if not api_key or not cse_id:
        sys.exit("Set GOOGLE_API_KEY and GOOGLE_CSE_ID environment variables first.")

    urls = google_search(query, api_key, cse_id, num_results)
    results: list[BarberListing] = []
    for url in urls:
        if not robots_allows(url):
            print(f"skip (robots.txt disallows): {url}", file=sys.stderr)
            continue
        html = fetch(url)
        if html is None:
            print(f"skip (fetch failed): {url}", file=sys.stderr)
            continue
        results.append(extract_contact_info(html, url))
        time.sleep(delay)
    return results


def write_csv(listings: list[BarberListing], output_path: str) -> None:
    fieldnames = [f.name for f in fields(BarberListing)]
    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for listing in listings:
            writer.writerow(asdict(listing))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--location", required=True, help='e.g. "Austin, TX"')
    parser.add_argument(
        "--query-template",
        default='independent barber shop "{location}"',
        help="Search query, must contain {location}",
    )
    parser.add_argument("--num-results", type=int, default=20)
    parser.add_argument("--delay", type=float, default=2.0, help="Seconds between page fetches")
    parser.add_argument("--output", default="barbers.csv")
    args = parser.parse_args()

    query = args.query_template.format(location=args.location)
    listings = collect(query, args.num_results, args.delay)
    write_csv(listings, args.output)
    print(f"Wrote {len(listings)} listings to {args.output}")


if __name__ == "__main__":
    main()
