import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin

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

def run_scan(base_url):
    print("🔍 Scanning:", base_url)
    print(check_robots_txt(base_url))
    print(check_sitemap(base_url))
    print(check_schema(base_url))

if __name__ == "__main__":
    site = input("Enter the full website URL (e.g., https://example.com): ")
    run_scan(site)
