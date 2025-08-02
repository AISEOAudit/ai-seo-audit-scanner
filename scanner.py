from fastapi import FastAPI
import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin

app = FastAPI()

def check_robots_txt(base_url):
    try:
        robots_url = urljoin(base_url, "/robots.txt")
        res = requests.get(robots_url, timeout=5)
        if "GPTBot" in res.text:
            return "❌ GPTBot is blocked in robots.txt"
        return "✅ GPTBot is not blocked"
    except Exception:
        return "⚠️ Could not check robots.txt"

def check_meta_noindex(base_url):
    try:
        res = requests.get(base_url, timeout=5)
        soup = BeautifulSoup(res.text, "html.parser")
        tag = soup.find("meta", attrs={"name": "robots"})
        if tag and "noindex" in tag.get("content", "").lower():
            return "❌ 'noindex' tag found (may block GPTBot)"
        return "✅ No 'noindex' tag"
    except Exception:
        return "⚠️ Could not check for 'noindex' tag"

def check_meta_nofollow(base_url):
    try:
        res = requests.get(base_url, timeout=5)
        soup = BeautifulSoup(res.text, "html.parser")
        tag = soup.find("meta", attrs={"name": "robots"})
        if tag and "nofollow" in tag.get("content", "").lower():
            return "❌ 'nofollow' tag found (may block GPTBot crawling)"
        return "✅ No 'nofollow' tag"
    except Exception:
        return "⚠️ Could not check for 'nofollow' tag"

def check_bot_blocking_headers(base_url):
    try:
        res = requests.get(base_url, timeout=5)
        headers = res.headers
        if "cf-ray" in headers or "x-protection" in headers or "server" in headers and "cloudflare" in headers["server"].lower():
            return "⚠️ Cloudflare or bot protection detected (GPTBot may be blocked)"
        return "✅ No obvious bot protection headers"
    except Exception:
        return "⚠️ Could not check bot protection headers"

@app.get("/scan")
def run_scan(url: str):
    return {
        "robots_txt": check_robots_txt(url),
        "meta_noindex": check_meta_noindex(url),
        "meta_nofollow": check_meta_nofollow(url),
        "bot_protection": check_bot_blocking_headers(url),
    }
