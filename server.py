from __future__ import annotations

import json
import mimetypes
import threading
import time
import urllib.parse
from email.utils import formatdate
from html import escape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from forecast_engine import CACHE_DIR, build_forecast, nearest_station, normalize_city, resolve_location


ROOT = Path(__file__).parent
STATIC = ROOT / "static"
HOST = "127.0.0.1"
PORT = 8765
LEARNING_CITIES_PATH = CACHE_DIR / "learning_cities.json"
DEFAULT_LEARNING_CITIES = ["Berlin", "Muenchen", "Nuernberg", "Hamburg", "Coburg"]


class WeatherHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/":
            return self.serve_file(STATIC / "index.html")
        if parsed.path.startswith("/static/"):
            return self.serve_file(ROOT / parsed.path.lstrip("/"))
        if parsed.path == "/api/forecast":
            return self.handle_forecast(parsed.query)
        if parsed.path == "/api/forecast/compact":
            return self.handle_compact_forecast(parsed.query)
        if parsed.path == "/api/stations":
            return self.handle_station(parsed.query)
        if parsed.path == "/api/learning":
            return self.handle_learning_list()
        if parsed.path == "/api/learning/dashboard":
            return self.handle_learning_dashboard()
        if parsed.path == "/api/learning/add":
            return self.handle_learning_add(parsed.query)
        if parsed.path == "/api/learning/remove":
            return self.handle_learning_remove(parsed.query)
        if parsed.path == "/feed.xml":
            return self.handle_feed(parsed.query)
        self.send_error(404, "Not found")

    def handle_forecast(self, query: str) -> None:
        city, label, lat, lon = forecast_params(query)
        if invalid_location(city, lat, lon):
            return self.send_json({"error": "Bitte Ort oder Koordinaten angeben."}, status=400)
        try:
            payload = build_forecast(city=city, lat=lat, lon=lon, label=label)
            self.send_json(payload)
        except Exception as exc:
            self.send_json({"error": str(exc)}, status=500)

    def handle_compact_forecast(self, query: str) -> None:
        city, label, lat, lon = forecast_params(query)
        if invalid_location(city, lat, lon):
            return self.send_json({"error": "Bitte Ort oder Koordinaten angeben."}, status=400)
        try:
            payload = build_forecast(city=city, lat=lat, lon=lon, label=label)
            self.send_json(compact_forecast_payload(payload))
        except Exception as exc:
            self.send_json({"error": str(exc)}, status=500)

    def handle_feed(self, query: str) -> None:
        city, label, lat, lon = forecast_params(query)
        if invalid_location(city, lat, lon):
            return self.send_text("Bitte Ort oder Koordinaten angeben.", status=400, content_type="text/plain; charset=utf-8")
        try:
            payload = build_forecast(city=city, lat=lat, lon=lon, label=label)
            self.send_text(rss_feed(payload), content_type="application/rss+xml; charset=utf-8")
        except Exception as exc:
            self.send_text(str(exc), status=500, content_type="text/plain; charset=utf-8")

    def handle_station(self, query: str) -> None:
        params = urllib.parse.parse_qs(query)
        city = first(params, "city")
        label = first(params, "label")
        lat = parse_optional_float(first(params, "lat"))
        lon = parse_optional_float(first(params, "lon"))
        if not city and (lat is None or lon is None):
            self.send_json({"error": "Bitte Ort oder Koordinaten angeben."}, status=400)
            return
        try:
            resolved_lat, resolved_lon, resolved_label = resolve_location(city, lat, lon, label)
            station = nearest_station(resolved_lat, resolved_lon)
            self.send_json({
                "location": {"label": resolved_label, "lat": resolved_lat, "lon": resolved_lon},
                "station": station.__dict__ | {
                    "from_date": station.from_date.isoformat(),
                    "to_date": station.to_date.isoformat(),
                    "distance_km": round(station.distance_km, 1),
                },
            })
        except Exception as exc:
            self.send_json({"error": str(exc)}, status=500)

    def handle_learning_list(self) -> None:
        self.send_json({"cities": load_learning_cities()})

    def handle_learning_dashboard(self) -> None:
        cities = load_learning_cities()
        cards = []
        errors = []
        for city in cities:
            try:
                payload = build_forecast(city=city, lat=None, lon=None, label=None)
                compact = compact_forecast_payload(payload)
                cards.append({
                    "city": city,
                    "location": compact["location"],
                    "station": compact["station"],
                    "generated_at": compact["generated_at"],
                    "current": compact.get("current"),
                    "today": compact["days"][0] if compact["days"] else None,
                    "summary": compact["summary"],
                    "learning": payload["source"].get("learning"),
                })
            except Exception as exc:
                errors.append({"city": city, "error": str(exc)})
        self.send_json({
            "cities": cities,
            "cards": cards,
            "errors": errors,
            "generated_at": formatdate(usegmt=True),
        })

    def handle_learning_add(self, query: str) -> None:
        params = urllib.parse.parse_qs(query)
        city = (first(params, "city") or "").strip()
        if not city:
            return self.send_json({"error": "Bitte Stadt angeben."}, status=400)
        cities = load_learning_cities()
        if normalize_city(city) not in {normalize_city(item) for item in cities}:
            cities.append(city)
            save_learning_cities(cities)
        self.send_json({"cities": load_learning_cities()})

    def handle_learning_remove(self, query: str) -> None:
        params = urllib.parse.parse_qs(query)
        city = (first(params, "city") or "").strip()
        if not city:
            return self.send_json({"error": "Bitte Stadt angeben."}, status=400)
        cities = [
            item for item in load_learning_cities()
            if normalize_city(item) != normalize_city(city)
        ]
        save_learning_cities(cities)
        self.send_json({"cities": cities})

    def serve_file(self, path: Path) -> None:
        if not path.exists() or not path.is_file():
            self.send_error(404, "Not found")
            return
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, payload: dict, status: int = 200) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_text(self, payload: str, status: int = 200, content_type: str = "text/plain; charset=utf-8") -> None:
        data = payload.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args) -> None:
        return


def first(params: dict[str, list[str]], key: str) -> str | None:
    values = params.get(key)
    return values[0] if values else None


def forecast_params(query: str) -> tuple[str | None, str | None, float | None, float | None]:
    params = urllib.parse.parse_qs(query)
    city = first(params, "city")
    label = first(params, "label")
    lat = parse_optional_float(first(params, "lat"))
    lon = parse_optional_float(first(params, "lon"))
    return city, label, lat, lon


def invalid_location(city: str | None, lat: float | None, lon: float | None) -> bool:
    return not city and (lat is None or lon is None)


def load_learning_cities() -> list[str]:
    if not LEARNING_CITIES_PATH.exists():
        save_learning_cities(DEFAULT_LEARNING_CITIES)
    try:
        data = json.loads(LEARNING_CITIES_PATH.read_text(encoding="utf-8"))
        cities = data.get("cities", data if isinstance(data, list) else [])
    except json.JSONDecodeError:
        cities = DEFAULT_LEARNING_CITIES
    cleaned = []
    seen = set()
    for city in cities:
        if not isinstance(city, str) or not city.strip():
            continue
        key = normalize_city(city)
        if key in seen:
            continue
        cleaned.append(city.strip())
        seen.add(key)
    if not cleaned:
        cleaned = DEFAULT_LEARNING_CITIES.copy()
    return cleaned


def save_learning_cities(cities: list[str]) -> None:
    LEARNING_CITIES_PATH.write_text(
        json.dumps({"cities": cities}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def parse_optional_float(value: str | None) -> float | None:
    if value in (None, ""):
        return None
    return float(value)


def compact_forecast_payload(payload: dict) -> dict:
    return {
        "location": payload["location"],
        "station": payload["station"],
        "generated_at": payload["source"]["generated_at"],
        "current": payload.get("current"),
        "summary": payload["overview"],
        "feed": f"/feed.xml?city={urllib.parse.quote(payload['location']['label'])}",
        "days": [
            {
                "date": day["date"],
                "condition": day["likely"]["condition"],
                "temperature_c": day["likely"]["t_mean"],
                "temperature_min_c": day["likely"].get("t_min"),
                "temperature_max_c": day["likely"].get("t_max"),
                "rain_probability": day["likely"]["rain_probability"],
                "rain_index": day["rain_signal"]["score"],
                "rain_level": day["rain_signal"]["level"],
                "rain_window": day["rain_signal"].get("timing", {}).get("wet_window"),
                "confidence": day["likely"]["confidence"],
                "confidence_label": day["likely"]["label"],
                "verdict": day["likely"]["verdict"],
            }
            for day in payload.get("days", [])
        ],
    }


def rss_feed(payload: dict) -> str:
    location = payload["location"]["label"]
    title = f"a better weather: {location}"
    link_city = urllib.parse.quote(location)
    items = []
    for day in payload.get("days", []):
        likely = day["likely"]
        rain = day["rain_signal"]
        item_title = f"{day['date']}: {likely['condition']}, {likely['t_mean']:.1f}°"
        description = (
            f"{likely['verdict']}. Regen: {round(likely['rain_probability'] * 100)}%, "
            f"Index {rain['score']}/100 ({rain['level']}). "
            f"Confidence {likely['confidence']} ({likely['label']})."
        )
        items.append(
            "    <item>\n"
            f"      <title>{escape(item_title)}</title>\n"
            f"      <link>http://{HOST}:{PORT}/?city={link_city}</link>\n"
            f"      <guid>{escape(location)}-{escape(day['date'])}</guid>\n"
            f"      <description>{escape(description)}</description>\n"
            f"      <pubDate>{formatdate(usegmt=True)}</pubDate>\n"
            "    </item>"
        )
    return (
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
        "<rss version=\"2.0\">\n"
        "  <channel>\n"
        f"    <title>{escape(title)}</title>\n"
        f"    <link>http://{HOST}:{PORT}/?city={link_city}</link>\n"
        f"    <description>{escape(payload['overview']['headline'])}</description>\n"
        f"    <lastBuildDate>{formatdate(usegmt=True)}</lastBuildDate>\n"
        + "\n".join(items)
        + "\n  </channel>\n"
        "</rss>\n"
    )


def run_learning_cycle_once() -> None:
    for city in load_learning_cities():
        try:
            build_forecast(city=city, lat=None, lon=None, label=None)
        except Exception:
            continue


def run_learning_scheduler() -> None:
    while True:
        run_learning_cycle_once()
        time.sleep(24 * 60 * 60)


if __name__ == "__main__":
    threading.Thread(target=run_learning_scheduler, daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), WeatherHandler)
    print(f"a better weather läuft auf http://{HOST}:{PORT}")
    server.serve_forever()
