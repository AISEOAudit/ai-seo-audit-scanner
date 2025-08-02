from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
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

def check_sitemap(base_url):
    try:
        sitemap_url = urljoin(base_url, "/sitemap.xml")
        res = requests.get(sitemap_url, timeout=5)
        if res.status_code == 200:
            return "✅ sitemap.xml found"
        return "❌ sitemap.xml not found"
    except Exception:
        return "⚠️ Could not check sitemap.xml"

def check_schema(base_url):
    try:
        res = requests.get(base_url, timeout=5)
        soup = BeautifulSoup(res.text, "html.parser")
        scripts = soup.find_all("script", type="application/ld+json")
        if scripts:
            return "✅ Structured data (schema) detected"
        return "❌ No structured data (schema) found"
    except Exception:
        return "⚠️ Could not check schema markup"

@app.get("/scan")
def run_scan(url: str):
    return {
        "robots": check_robots_txt(url),
        "sitemap": check_sitemap(url),
        "schema": check_schema(url)
    }
