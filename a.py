import requests
import json

requests.packages.urllib3.disable_warnings(requests.packages.urllib3.exceptions.InsecureRequestWarning)

base = "http://91.98.17.61:31565"
login_url = f"{base}/login"

payload = json.dumps({
  "user": "admin",
  "password": "2rp8QOc1ni0FK4KnAehHizpjxAtanI2wR3WKHWBg"
})
headers = {
  "x-grafana-device-id": "75c0e6d1da48a3f04654d1b26a207161",
  "Referer": login_url,
  "User-Agent": "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36",
  "accept": "application/json, text/plain, */*",
  "content-type": "application/json",
}

def cookie_header(cookies):
  return "; ".join(f"{k}={v}" for k, v in cookies.items())

# Login 1 -> capture old cookies
session = requests.Session()
session.verify = False
r1 = session.post(login_url, headers=headers, data=payload)
old_cookies = dict(session.cookies)
print("Login 1:", r1.text)
print("Old cookies:", old_cookies)

# Login 2 -> session now has new cookies
r2_login = session.post(login_url, headers=headers, data=payload)
new_cookies = dict(session.cookies)
print("Login 2:", r2_login.text)
print("New cookies:", new_cookies)

query_url = f"{base}/api/ds/query?ds_type=loki&requestId=loki-data-samples_1"
query_headers_base = {
  **headers,
  "Accept-Language": "en-US,en;q=0.9",
  "Origin": base,
  "Referer": f"{base}/explore",
  "x-datasource-uid": "P8E80F9AEF21F6940",
  "x-grafana-org-id": "1",
  "x-plugin-id": "loki",
  "x-query-group-id": "f3f26b75-173a-44a6-aa20-2b62435c0544",
}
query_body = {
  "queries": [{
    "expr": '{app="liveness-bot"} |= `to pub`',
    "queryType": "range",
    "refId": "loki-data-samples",
    "maxLines": 10,
    "supportingQueryType": "dataSample",
    "legendFormat": "",
    "datasource": {"type": "loki", "uid": "P8E80F9AEF21F6940"},
    "datasourceId": 1,
    "intervalMs": 21600000,
  }],
  "from": "1773506472144",
  "to": "1773528072144",
}

# Query with OLD cookies
print("\n--- Query with OLD cookies ---")
r_old = requests.post(
  query_url,
  headers={**query_headers_base, "Cookie": cookie_header(old_cookies)},
  json=query_body,
  verify=False,
)
print("Status:", r_old.status_code)
text = r_old.text
print("Response:", text[:800] if len(text) > 800 else text)

# Query with NEW cookies (for comparison)
print("\n--- Query with NEW cookies ---")
r_new = requests.post(
  query_url,
  headers={**query_headers_base, "Cookie": cookie_header(new_cookies)},
  json=query_body,
  verify=False,
)
print("Status:", r_new.status_code)
text_new = r_new.text
print("Response:", text_new[:800] if len(text_new) > 800 else text_new)
