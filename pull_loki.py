import json, os, re, sys, time, urllib.error, urllib.parse, urllib.request, datetime

def _load_dotenv_local():
    here = os.path.dirname(os.path.abspath(__file__))
    for name in (".env.local", ".env"):
        path = os.path.join(here, name)
        if not os.path.isfile(path):
            continue
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                k, v = k.strip(), v.strip()
                if k and k not in os.environ:
                    os.environ[k] = v

_load_dotenv_local()

def _grafana_token():
    for key in (
        "GRAFANA_API",
        "GRAFANA_TOKEN",
        "GRAFANA_SERVICE_ACCOUNT_TOKEN",
        "GRAFANA_API_TOKEN",
    ):
        v = os.environ.get(key, "").strip()
        if v:
            return v
    return ""

_BASE = os.environ.get("GRAFANA_URL", "https://grafana.devflexi.com").strip().rstrip("/")
_UID = os.environ.get("LOKI_DATASOURCE_UID", "P8E80F9AEF21F6940").strip()
LOKI = f"{_BASE}/api/datasources/proxy/uid/{_UID}/loki/api/v1/query_range"
TOKEN = _grafana_token()
QUERY = sys.argv[4] if len(sys.argv) > 4 else '{app="vfs-global-bot"} |= "fromCountry=ago" |= "toCountry=prt" !~ "mdebug\\x1b"'
ANSI = re.compile(r"\x1b\[[0-9;]*m")
TZ = datetime.timezone(datetime.timedelta(hours=4))

def fetch(start_ns, end_ns):
    if not TOKEN:
        raise SystemExit(
            "Set GRAFANA_API (or GRAFANA_TOKEN / GRAFANA_SERVICE_ACCOUNT_TOKEN / GRAFANA_API_TOKEN)"
        )
    params = urllib.parse.urlencode(
        {"query": QUERY, "start": start_ns, "end": end_ns, "limit": 5000, "direction": "forward"}
    )
    for attempt in range(8):
        try:
            request = urllib.request.Request(
                f"{LOKI}?{params}", headers={"Authorization": f"Bearer {TOKEN}"}
            )
            with urllib.request.urlopen(request, timeout=180) as r:
                data = json.load(r)["data"]["result"]
            break
        except (urllib.error.HTTPError, urllib.error.URLError, ConnectionError, OSError) as e:
            if (getattr(e, "code", 429) != 429) or attempt == 7:
                raise
            time.sleep(2**attempt)
    rows = [(int(ts), s["stream"].get("pod", ""), line) for s in data for ts, line in s["values"]]
    if len(rows) >= 5000 and end_ns - start_ns > 1_000_000_000:
        mid = (start_ns + end_ns) // 2
        return fetch(start_ns, mid) + fetch(mid, end_ns)
    return rows

if len(sys.argv) < 4:
    raise SystemExit("usage: pull_loki.py START_ISO END_ISO OUT_FILE [LOGQL]")

start = datetime.datetime.fromisoformat(sys.argv[1]).replace(tzinfo=TZ)
end = datetime.datetime.fromisoformat(sys.argv[2]).replace(tzinfo=TZ)
rows = []
t = start
while t < end:
    n = min(t + datetime.timedelta(minutes=1), end)
    rows += fetch(int(t.timestamp() * 1e9), int(n.timestamp() * 1e9))
    t = n
rows = sorted(set(rows))
with open(sys.argv[3], "w", encoding="utf-8") as f:
    for ts, pod, line in rows:
        local = datetime.datetime.fromtimestamp(ts / 1e9, TZ).strftime("%H:%M:%S.%f")[:-3]
        f.write(f"{local} [{pod[-5:]}] {ANSI.sub('', line).rstrip()}\n")
print(len(rows))
