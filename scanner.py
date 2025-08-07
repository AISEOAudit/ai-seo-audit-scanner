from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin
import json

app = FastAPI()

# ✅ CORS configuration – allow your front-end to call this
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://aiseoaudit.io"],  # Your live site domain
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ✅ Core visibility checks
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
        if "cf-ray" in headers or "x-protection" in headers or ("server" in headers and "cloudflare" in headers["server"].lower()):
            return "⚠️ Cloudflare or bot protection detected (GPTBot may be blocked)"
        return "✅ No obvious bot protection headers"
    except Exception:
        return "⚠️ Could not check bot protection headers"

# ✅ Schema detection
def extract_schemas(html):
    soup = BeautifulSoup(html, "html.parser")
    schema_data = []

    for script in soup.find_all("script", type="application/ld+json"):
        try:
            json_data = json.loads(script.string)
            if isinstance(json_data, list):
                schema_data.extend(json_data)
            else:
                schema_data.append(json_data)
        except (ValueError, TypeError):
            continue

    detected_types = set()
    for schema in schema_data:
        if "@type" in schema:
            types = schema["@type"]
            if isinstance(types, list):
                detected_types.update(types)
            else:
                detected_types.add(types)

    return list(detected_types)

# ✅ Scanner endpoint
@app.get("/scan")
def run_scan(url: str):
    try:
        html = requests.get(url, timeout=5).text
    except Exception:
        html = ""

    schemas = extract_schemas(html)

    # ✅ Updated expected list — changed "FAQ" to "FAQPage"
    expected = ["Organization", "WebSite", "FAQPage", "HowTo", "Article"]
    missing = [s for s in expected if s not in schemas]

    return {
        "robots_txt": check_robots_txt(url),
        "meta_noindex": check_meta_noindex(url),
        "meta_nofollow": check_meta_nofollow(url),
        "bot_protection": check_bot_blocking_headers(url),
        "schemas": schemas,
        "missing_schemas": missing,
    }
