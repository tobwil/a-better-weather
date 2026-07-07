from __future__ import annotations

import csv
import io
import json
import math
import os
import re
import ssl
import statistics
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


DWD_DAILY_BASE = "https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/daily/kl"
OPENWEATHER_FORECAST_URL = "https://api.openweathermap.org/data/2.5/forecast"
OPENWEATHER_CURRENT_URL = "https://api.openweathermap.org/data/2.5/weather"
OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
CACHE_DIR = Path(".weather_cache")
CACHE_DIR.mkdir(exist_ok=True)
ARCHIVE_PATH = CACHE_DIR / "forecast_archive.jsonl"
LOCAL_TZ = ZoneInfo("Europe/Berlin")
WEIGHTING_STATUS = "learning_enabled"
WEIGHTING_NOTE = (
    "Die App lernt Blend-Gewichte aus archivierten Forecasts gegen DWD-Istwerte. "
    "Der aktive Gewichtssatz wird pro DWD-Station aus verifizierten Fällen gewählt; bei zu wenigen Fällen greift der Start-Gewichtssatz."
)
DEFAULT_BLEND_WEIGHTS = {
    "temp_model": 0.76,
    "rain_probability_model": 0.70,
    "rain_amount_model": 0.72,
}
MIN_TRAINING_CASES = 18

GERMAN_CITIES = {
    "berlin": (52.5200, 13.4050, "Berlin"),
    "hamburg": (53.5511, 9.9937, "Hamburg"),
    "muenchen": (48.1372, 11.5755, "Muenchen"),
    "munich": (48.1372, 11.5755, "Muenchen"),
    "münchen": (48.1372, 11.5755, "Muenchen"),
    "koeln": (50.9375, 6.9603, "Koeln"),
    "köln": (50.9375, 6.9603, "Koeln"),
    "cologne": (50.9375, 6.9603, "Koeln"),
    "frankfurt": (50.1109, 8.6821, "Frankfurt am Main"),
    "stuttgart": (48.7758, 9.1829, "Stuttgart"),
    "duesseldorf": (51.2277, 6.7735, "Duesseldorf"),
    "düsseldorf": (51.2277, 6.7735, "Duesseldorf"),
    "dortmund": (51.5136, 7.4653, "Dortmund"),
    "essen": (51.4556, 7.0116, "Essen"),
    "leipzig": (51.3397, 12.3731, "Leipzig"),
    "bremen": (53.0793, 8.8017, "Bremen"),
    "dresden": (51.0504, 13.7373, "Dresden"),
    "hannover": (52.3759, 9.7320, "Hannover"),
    "nuernberg": (49.4521, 11.0767, "Nuernberg"),
    "nürnberg": (49.4521, 11.0767, "Nuernberg"),
    "bonn": (50.7374, 7.0982, "Bonn"),
    "karlsruhe": (49.0069, 8.4037, "Karlsruhe"),
    "muenster": (51.9607, 7.6261, "Muenster"),
    "münster": (51.9607, 7.6261, "Muenster"),
    "freiburg": (47.9990, 7.8421, "Freiburg im Breisgau"),
    "kiel": (54.3233, 10.1228, "Kiel"),
    "rostock": (54.0924, 12.0991, "Rostock"),
    "saarbruecken": (49.2402, 6.9969, "Saarbruecken"),
    "saarbrücken": (49.2402, 6.9969, "Saarbruecken"),
    "coburg": (50.2593, 10.9638, "Coburg"),
}


@dataclass(frozen=True)
class Station:
    station_id: str
    name: str
    state: str
    lat: float
    lon: float
    height_m: int
    from_date: date
    to_date: date
    distance_km: float = 0.0


def build_forecast(city: str | None, lat: float | None, lon: float | None, label: str | None = None) -> dict[str, Any]:
    resolved_lat, resolved_lon, resolved_label = resolve_location(city, lat, lon, label)
    station = nearest_station(resolved_lat, resolved_lon)
    observations = load_station_observations(station.station_id)
    learning = learned_blend_weights(station, observations)
    openweather = fetch_openweather_forecast(resolved_lat, resolved_lon, resolved_label)
    openweather_current = fetch_openweather_current(resolved_lat, resolved_lon)
    open_meteo = fetch_open_meteo_forecast(resolved_lat, resolved_lon)
    current = build_current_conditions(openweather_current, aggregate_open_meteo_current(open_meteo))
    daily = aggregate_openweather_daily(openweather, resolved_lat, resolved_lon)
    open_meteo_daily = aggregate_open_meteo_daily(open_meteo)
    openweather_hourly = aggregate_openweather_hourly(openweather)
    open_meteo_hourly = aggregate_open_meteo_hourly(open_meteo)
    for day in daily:
        day["open_meteo"] = open_meteo_daily.get(day["date"])
    analyzed_days = [
        challenge_day(day, observations, index, station, learning["weights"])
        for index, day in enumerate(daily)
    ]
    hourly = build_hourly_forecast(openweather_hourly, open_meteo_hourly, analyzed_days)
    enrich_days_with_rain_timing(analyzed_days, hourly)

    payload = {
        "location": {
            "label": resolved_label,
            "lat": resolved_lat,
            "lon": resolved_lon,
        },
        "station": {
            "id": station.station_id,
            "name": station.name,
            "state": station.state,
            "lat": station.lat,
            "lon": station.lon,
            "height_m": station.height_m,
            "distance_km": round(station.distance_km, 1),
            "data_until": station.to_date.isoformat(),
        },
        "source": {
            "openweather": openweather.get("_source", "openweather"),
            "open_meteo": open_meteo.get("_source", "open-meteo"),
            "dwd": DWD_DAILY_BASE,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "observations": len(observations),
            "method": "OpenWeather and Open-Meteo model consensus adjusted with nearest-station DWD climatology and recent station anomaly",
            "weighting_status": WEIGHTING_STATUS,
            "weighting_note": WEIGHTING_NOTE,
            "learning": learning,
        },
        "current": current,
        "overview": build_overview(resolved_label, station, analyzed_days, current),
        "calibration": archive_calibration(station, observations),
        "hourly": hourly,
        "days": analyzed_days,
    }
    record_forecast_snapshot(payload)
    payload["calibration"] = archive_calibration(station, observations)
    return payload


def resolve_location(city: str | None, lat: float | None, lon: float | None, label: str | None) -> tuple[float, float, str]:
    if lat is not None and lon is not None:
        return float(lat), float(lon), label or f"{lat:.3f}, {lon:.3f}"

    key = normalize_city(city or "Berlin")
    if key in GERMAN_CITIES:
        city_lat, city_lon, city_label = GERMAN_CITIES[key]
        return city_lat, city_lon, city_label

    api_key = os.environ.get("OPENWEATHER_API_KEY")
    if api_key:
        query = urllib.parse.urlencode({
            "q": f"{city},DE",
            "limit": "1",
            "appid": api_key,
        })
        data = fetch_json(f"https://api.openweathermap.org/geo/1.0/direct?{query}", cache_key=f"geo_{key}.json", ttl_seconds=86400)
        if data:
            first = data[0]
            return float(first["lat"]), float(first["lon"]), first.get("local_names", {}).get("de") or first.get("name") or city or "Ort"

    return GERMAN_CITIES["berlin"]


def normalize_city(value: str) -> str:
    return value.strip().lower().replace("ü", "ue").replace("ö", "oe").replace("ä", "ae").replace("ß", "ss")


def nearest_station(lat: float, lon: float) -> Station:
    stations = [
        station for station in load_stations()
        if station.to_date >= date.today() - timedelta(days=90)
    ]
    if not stations:
        stations = load_stations()

    nearest = min(stations, key=lambda station: haversine_km(lat, lon, station.lat, station.lon))
    distance = haversine_km(lat, lon, nearest.lat, nearest.lon)
    return Station(
        station_id=nearest.station_id,
        name=nearest.name,
        state=nearest.state,
        lat=nearest.lat,
        lon=nearest.lon,
        height_m=nearest.height_m,
        from_date=nearest.from_date,
        to_date=nearest.to_date,
        distance_km=distance,
    )


def load_stations() -> list[Station]:
    cache_path = CACHE_DIR / "dwd_stations.json"
    if is_fresh(cache_path, ttl_seconds=86400):
        return [station_from_json(item) for item in json.loads(cache_path.read_text(encoding="utf-8"))]

    text = fetch_text(f"{DWD_DAILY_BASE}/recent/KL_Tageswerte_Beschreibung_Stationen.txt", cache_key="KL_Tageswerte_Beschreibung_Stationen.txt", ttl_seconds=86400)
    stations: list[Station] = []
    for line in text.splitlines()[2:]:
        if not line.strip() or not line[:5].strip().isdigit():
            continue
        try:
            station_id = line[0:5].strip().zfill(5)
            from_date = parse_yyyymmdd(line[6:14].strip())
            to_date = parse_yyyymmdd(line[15:23].strip())
            height_m = int(float(line[24:38].strip()))
            lat = float(line[39:49].strip())
            lon = float(line[50:60].strip())
            name = line[61:102].strip()
            state = line[102:142].strip()
            stations.append(Station(station_id, name, state, lat, lon, height_m, from_date, to_date))
        except (ValueError, IndexError):
            continue

    cache_path.write_text(json.dumps([station_to_json(station) for station in stations], ensure_ascii=False), encoding="utf-8")
    return stations


def station_to_json(station: Station) -> dict[str, Any]:
    return {
        "station_id": station.station_id,
        "name": station.name,
        "state": station.state,
        "lat": station.lat,
        "lon": station.lon,
        "height_m": station.height_m,
        "from_date": station.from_date.isoformat(),
        "to_date": station.to_date.isoformat(),
    }


def station_from_json(item: dict[str, Any]) -> Station:
    return Station(
        station_id=item["station_id"],
        name=item["name"],
        state=item["state"],
        lat=float(item["lat"]),
        lon=float(item["lon"]),
        height_m=int(item["height_m"]),
        from_date=date.fromisoformat(item["from_date"]),
        to_date=date.fromisoformat(item["to_date"]),
    )


def load_station_observations(station_id: str) -> list[dict[str, Any]]:
    cache_path = CACHE_DIR / f"observations_{station_id}.json"
    if is_fresh(cache_path, ttl_seconds=43200):
        return json.loads(cache_path.read_text(encoding="utf-8"))

    observations: dict[str, dict[str, Any]] = {}
    for dataset in ("historical", "recent"):
        try:
            for row in read_station_zip(station_id, dataset):
                observations[row["date"]] = row
        except Exception:
            continue

    ordered = [observations[key] for key in sorted(observations)]
    if not ordered:
        raise RuntimeError(f"Keine DWD-Tageswerte für Station {station_id} gefunden.")
    cache_path.write_text(json.dumps(ordered, ensure_ascii=False), encoding="utf-8")
    return ordered


def read_station_zip(station_id: str, dataset: str) -> list[dict[str, Any]]:
    zip_url = station_zip_url(station_id, dataset)
    zip_bytes = fetch_bytes(zip_url, cache_key=Path(zip_url).name, ttl_seconds=43200)
    rows: list[dict[str, Any]] = []
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
        product_name = next(name for name in archive.namelist() if name.startswith("produkt_klima_tag_") and name.endswith(".txt"))
        raw = archive.read(product_name).decode("latin-1")
    reader = csv.DictReader(io.StringIO(raw), delimiter=";")
    for record in reader:
        cleaned = {key.strip(): (value or "").strip() for key, value in record.items() if key}
        try:
            measured = parse_yyyymmdd(cleaned["MESS_DATUM"])
        except (KeyError, ValueError):
            continue
        rows.append({
            "date": measured.isoformat(),
            "t_mean": parse_float(cleaned.get("TMK")),
            "t_max": parse_float(cleaned.get("TXK")),
            "t_min": parse_float(cleaned.get("TNK")),
            "rain_mm": max(0.0, parse_float(cleaned.get("RSK")) or 0.0),
            "sun_hours": parse_float(cleaned.get("SDK")),
            "wind_mean": parse_float(cleaned.get("FM")),
        })
    return rows


def station_zip_url(station_id: str, dataset: str) -> str:
    if dataset == "recent":
        return f"{DWD_DAILY_BASE}/recent/tageswerte_KL_{station_id}_akt.zip"

    index = fetch_text(f"{DWD_DAILY_BASE}/historical/", cache_key="dwd_historical_index.html", ttl_seconds=86400)
    match = re.search(rf'href="(tageswerte_KL_{station_id}_[^"]+?_hist\.zip)"', index)
    if not match:
        raise FileNotFoundError(f"No historical DWD zip for station {station_id}")
    return f"{DWD_DAILY_BASE}/historical/{match.group(1)}"


def fetch_openweather_forecast(lat: float, lon: float, label: str) -> dict[str, Any]:
    api_key = os.environ.get("OPENWEATHER_API_KEY")
    if not api_key:
        raise RuntimeError("OPENWEATHER_API_KEY fehlt. Für Produktivdaten bitte den OpenWeather API Key als Umgebungsvariable setzen.")

    query = urllib.parse.urlencode({
        "lat": f"{lat:.5f}",
        "lon": f"{lon:.5f}",
        "appid": api_key,
        "units": "metric",
        "lang": "de",
    })
    return fetch_json(f"{OPENWEATHER_FORECAST_URL}?{query}", cache_key=f"owm_{lat:.3f}_{lon:.3f}.json", ttl_seconds=900)


def fetch_openweather_current(lat: float, lon: float) -> dict[str, Any]:
    api_key = os.environ.get("OPENWEATHER_API_KEY")
    if not api_key:
        raise RuntimeError("OPENWEATHER_API_KEY fehlt. Für Produktivdaten bitte den OpenWeather API Key als Umgebungsvariable setzen.")

    query = urllib.parse.urlencode({
        "lat": f"{lat:.5f}",
        "lon": f"{lon:.5f}",
        "appid": api_key,
        "units": "metric",
        "lang": "de",
    })
    payload = fetch_json(f"{OPENWEATHER_CURRENT_URL}?{query}", cache_key=f"owm_current_{lat:.3f}_{lon:.3f}.json", ttl_seconds=300)
    payload["_source"] = "openweather-current"
    return payload


def fetch_open_meteo_forecast(lat: float, lon: float) -> dict[str, Any]:
    query = urllib.parse.urlencode({
        "latitude": f"{lat:.5f}",
        "longitude": f"{lon:.5f}",
        "current": ",".join([
            "temperature_2m",
            "relative_humidity_2m",
            "precipitation",
            "rain",
            "weather_code",
            "wind_speed_10m",
        ]),
        "daily": ",".join([
            "weather_code",
            "temperature_2m_mean",
            "temperature_2m_min",
            "temperature_2m_max",
            "precipitation_probability_max",
            "precipitation_sum",
            "wind_speed_10m_max",
        ]),
        "hourly": ",".join([
            "temperature_2m",
            "precipitation_probability",
            "precipitation",
            "wind_speed_10m",
            "weather_code",
        ]),
        "timezone": "Europe/Berlin",
        "forecast_days": "5",
        "wind_speed_unit": "ms",
        "precipitation_unit": "mm",
    })
    payload = fetch_json(f"{OPEN_METEO_FORECAST_URL}?{query}", cache_key=f"om_v2_{lat:.3f}_{lon:.3f}.json", ttl_seconds=900)
    payload["_source"] = "open-meteo"
    return payload


def build_current_conditions(openweather_payload: dict[str, Any], open_meteo_current: dict[str, Any] | None) -> dict[str, Any]:
    main = openweather_payload.get("main") or {}
    wind = openweather_payload.get("wind") or {}
    descriptions = openweather_payload.get("weather") or []
    owm_time = timestamp_to_local(openweather_payload.get("dt"))
    openweather = {
        "source": "OpenWeather Current Weather",
        "temperature_c": round_optional(main.get("temp"), 1),
        "feels_like_c": round_optional(main.get("feels_like"), 1),
        "humidity": round_optional(main.get("humidity"), 0),
        "wind_mps": round_optional(wind.get("speed"), 1),
        "description": descriptions[0].get("description", "wechselhaft") if descriptions else "wechselhaft",
        "observed_at": owm_time,
        "kind": "nowcast",
    }
    open_meteo = open_meteo_current or None
    gap = None
    if openweather["temperature_c"] is not None and open_meteo and open_meteo.get("temperature_c") is not None:
        gap = round(abs(openweather["temperature_c"] - open_meteo["temperature_c"]), 1)

    best_source = "OpenWeather Current Weather" if openweather["temperature_c"] is not None else "Open-Meteo Current"
    best_temp = openweather["temperature_c"] if openweather["temperature_c"] is not None else (open_meteo or {}).get("temperature_c")
    best_description = openweather["description"] if openweather["temperature_c"] is not None else (open_meteo or {}).get("description")
    confidence = "hoch" if gap is not None and gap <= 1.5 else "mittel" if gap is not None and gap <= 3.0 else "niedrig" if gap is not None else "unbekannt"
    if gap is None:
        explanation = "Jetzt-Wert aus einer Quelle. Tageskarten bleiben Tagesmittel-Forecasts."
    elif gap <= 1.5:
        explanation = "OpenWeather Current und Open-Meteo Current liegen nah beieinander. Der Jetzt-Wert ist plausibel."
    elif gap <= 3.0:
        explanation = "OpenWeather Current und Open-Meteo Current unterscheiden sich merklich. Jetzt-Wert und Stundenforecast getrennt lesen."
    else:
        explanation = "Starker Nowcast-Dissens: OpenWeather Current und Open-Meteo Current sehen die aktuelle Temperatur deutlich anders. Die Tageskarten zeigen trotzdem nur Tagesmittel-Forecasts."

    return {
        "best": {
            "temperature_c": best_temp,
            "description": best_description,
            "source": best_source,
            "confidence": confidence,
        },
        "openweather": openweather,
        "open_meteo": open_meteo,
        "temperature_gap_c": gap,
        "explanation": explanation,
        "note": "Jetzt = aktueller Nowcast/Beobachtungswert. Tageskarten = Tagesmittel und Tages-Spanne. Stundenliste = Forecast-Slots ab jetzt.",
    }


def aggregate_open_meteo_current(payload: dict[str, Any]) -> dict[str, Any] | None:
    current = payload.get("current") or {}
    if not current:
        return None
    return {
        "source": "Open-Meteo Current",
        "temperature_c": round_optional(current.get("temperature_2m"), 1),
        "humidity": round_optional(current.get("relative_humidity_2m"), 0),
        "precipitation_mm": round_optional(current.get("precipitation"), 1) or 0.0,
        "rain_mm": round_optional(current.get("rain"), 1) or 0.0,
        "wind_mps": round_optional(current.get("wind_speed_10m"), 1),
        "description": weather_code_label(current.get("weather_code")),
        "observed_at": normalize_open_meteo_time(current.get("time")),
        "kind": "model_current",
    }


def aggregate_openweather_daily(payload: dict[str, Any], lat: float, lon: float) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for item in payload.get("list", []):
        timestamp = item.get("dt")
        if not timestamp:
            continue
        day_key = datetime.fromtimestamp(timestamp, timezone.utc).astimezone(LOCAL_TZ).date().isoformat()
        grouped.setdefault(day_key, []).append(item)

    days: list[dict[str, Any]] = []
    for day_key, items in sorted(grouped.items())[:5]:
        temps = [item["main"]["temp"] for item in items if "main" in item and "temp" in item["main"]]
        pops = [float(item.get("pop", 0.0)) for item in items]
        rain = sum(float(item.get("rain", {}).get("3h", 0.0)) for item in items)
        wind = [float(item.get("wind", {}).get("speed", 0.0)) for item in items]
        descriptions = [item.get("weather", [{}])[0].get("description", "") for item in items]
        days.append({
            "date": day_key,
            "openweather": {
                "t_mean": round(statistics.fmean(temps), 1) if temps else None,
                "t_min": round(min(temps), 1) if temps else None,
                "t_max": round(max(temps), 1) if temps else None,
                "rain_mm": round(rain, 1),
                "rain_probability": round(max(pops) if pops else 0.0, 2),
                "wind_mean": round(statistics.fmean(wind), 1) if wind else None,
                "description": most_common(descriptions) or "wechselhaft",
            },
            "lat": lat,
            "lon": lon,
        })
    return days


def aggregate_openweather_hourly(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    slots: dict[str, dict[str, Any]] = {}
    for item in payload.get("list", []):
        timestamp = item.get("dt")
        if not timestamp:
            continue
        local_time = datetime.fromtimestamp(timestamp, timezone.utc).astimezone(LOCAL_TZ).replace(minute=0, second=0, microsecond=0)
        descriptions = item.get("weather", [{}])
        slots[local_time.isoformat()] = {
            "time": local_time.isoformat(),
            "t": round_optional(item.get("main", {}).get("temp"), 1),
            "rain_probability": round_optional(item.get("pop", 0.0), 2) or 0.0,
            "rain_mm": round_optional(item.get("rain", {}).get("3h", 0.0), 1) or 0.0,
            "wind": round_optional(item.get("wind", {}).get("speed"), 1),
            "description": descriptions[0].get("description", "wechselhaft") if descriptions else "wechselhaft",
        }
    return slots


def aggregate_open_meteo_daily(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    daily = payload.get("daily") or {}
    dates = daily.get("time") or []
    result: dict[str, dict[str, Any]] = {}
    for index, day_key in enumerate(dates):
        result[day_key] = {
            "t_mean": round_optional(list_value(daily, "temperature_2m_mean", index), 1),
            "t_min": round_optional(list_value(daily, "temperature_2m_min", index), 1),
            "t_max": round_optional(list_value(daily, "temperature_2m_max", index), 1),
            "rain_probability": probability_from_percent(list_value(daily, "precipitation_probability_max", index)),
            "rain_mm": round_optional(list_value(daily, "precipitation_sum", index), 1) or 0.0,
            "wind_mean": round_optional(list_value(daily, "wind_speed_10m_max", index), 1),
            "description": weather_code_label(list_value(daily, "weather_code", index)),
            "weather_code": list_value(daily, "weather_code", index),
        }
    return result


def aggregate_open_meteo_hourly(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    hourly = payload.get("hourly") or {}
    times = hourly.get("time") or []
    slots: dict[str, dict[str, Any]] = {}
    for index, raw_time in enumerate(times):
        try:
            local_time = datetime.fromisoformat(raw_time).replace(tzinfo=LOCAL_TZ, minute=0, second=0, microsecond=0)
        except ValueError:
            continue
        slots[local_time.isoformat()] = {
            "time": local_time.isoformat(),
            "t": round_optional(list_value(hourly, "temperature_2m", index), 1),
            "rain_probability": probability_from_percent(list_value(hourly, "precipitation_probability", index)) or 0.0,
            "rain_mm": round_optional(list_value(hourly, "precipitation", index), 1) or 0.0,
            "wind": round_optional(list_value(hourly, "wind_speed_10m", index), 1),
            "description": weather_code_label(list_value(hourly, "weather_code", index)),
        }
    return slots


def build_hourly_forecast(
    openweather_slots: dict[str, dict[str, Any]],
    open_meteo_slots: dict[str, dict[str, Any]],
    days: list[dict[str, Any]],
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    day_adjustments = {
        day["date"]: {
            "temp": day["likely"].get("temperature_adjustment_c", 0.0),
            "rain": day["likely"].get("rain_adjustment_points", 0.0),
            "confidence": day["likely"].get("confidence"),
        }
        for day in days
    }
    start_time = (now or datetime.now(LOCAL_TZ)).replace(minute=0, second=0, microsecond=0)
    times = [
        slot_time for slot_time in sorted(set(openweather_slots) | set(open_meteo_slots))
        if safe_datetime(slot_time) >= start_time
    ][:48]
    slots = []
    for slot_time in times:
        try:
            slot_date = datetime.fromisoformat(slot_time).date().isoformat()
        except ValueError:
            slot_date = slot_time[:10]
        owm = openweather_slots.get(slot_time)
        om = open_meteo_slots.get(slot_time)
        adjustment = day_adjustments.get(slot_date, {"temp": 0.0, "rain": 0.0, "confidence": None})
        consensus_temp = model_consensus_value(owm.get("t") if owm else None, om.get("t") if om else None)
        consensus_rain_probability = model_consensus_value(
            owm.get("rain_probability") if owm else None,
            om.get("rain_probability") if om else None,
        )
        consensus_rain = model_consensus_value(owm.get("rain_mm") if owm else None, om.get("rain_mm") if om else None)
        consensus_wind = model_consensus_value(owm.get("wind") if owm else None, om.get("wind") if om else None)
        likely_rain_probability = clamp(consensus_rain_probability + adjustment["rain"], 0.0, 0.98)
        slots.append({
            "time": slot_time,
            "openweather": owm,
            "open_meteo": om,
            "consensus": {
                "t": round(consensus_temp, 1),
                "rain_probability": round(consensus_rain_probability, 2),
                "rain_mm": round(consensus_rain, 1),
                "wind": round(consensus_wind, 1),
            },
            "likely": {
                "t": round(consensus_temp + adjustment["temp"], 1),
                "rain_probability": round(likely_rain_probability, 2),
                "rain_mm": round(max(0.0, consensus_rain), 1),
                "wind": round(consensus_wind, 1),
                "confidence": adjustment["confidence"],
                "rain_level": rain_level(likely_rain_probability, consensus_rain),
            },
        })
    return slots


def enrich_days_with_rain_timing(days: list[dict[str, Any]], hourly: list[dict[str, Any]]) -> None:
    by_day: dict[str, list[dict[str, Any]]] = {}
    for slot in hourly:
        by_day.setdefault(slot["time"][:10], []).append(slot)

    for day in days:
        slots = by_day.get(day["date"], [])
        wet_slots = [
            slot for slot in slots
            if slot["likely"]["rain_probability"] >= 0.35 or slot["likely"]["rain_mm"] >= 0.2
        ]
        peak = max(slots, key=lambda slot: slot["likely"]["rain_probability"], default=None)
        timing = {
            "wet_window": rain_window_label(wet_slots),
            "peak_probability": round(peak["likely"]["rain_probability"], 2) if peak else day["likely"]["rain_probability"],
            "peak_hour": datetime.fromisoformat(peak["time"]).strftime("%H:%M") if peak else None,
            "wet_slots": len(wet_slots),
        }
        day["rain_signal"]["timing"] = timing
        day["likely"]["rain_timing"] = timing


def challenge_day(
    day: dict[str, Any],
    observations: list[dict[str, Any]],
    horizon_index: int,
    station: Station,
    weights: dict[str, float] | None = None,
) -> dict[str, Any]:
    weights = weights or DEFAULT_BLEND_WEIGHTS
    target_date = date.fromisoformat(day["date"])
    pattern = historical_pattern(observations, target_date)
    recent = recent_signal(observations, target_date)
    owm = day["openweather"]
    open_meteo = day.get("open_meteo")

    owm_temp = owm.get("t_mean")
    model_temp = model_consensus_value(owm_temp, open_meteo.get("t_mean") if open_meteo else None)
    pattern_temp = pattern["t_mean"] + recent["temp_anomaly"] * max(0.15, 0.75 - horizon_index * 0.12)
    temp_model_weight = weights.get("temp_model", DEFAULT_BLEND_WEIGHTS["temp_model"])
    rain_probability_model_weight = weights.get("rain_probability_model", DEFAULT_BLEND_WEIGHTS["rain_probability_model"])
    rain_amount_model_weight = weights.get("rain_amount_model", DEFAULT_BLEND_WEIGHTS["rain_amount_model"])
    likely_temp = blend(model_temp, pattern_temp, model_weight=temp_model_weight)

    owm_rain_probability = owm.get("rain_probability") or 0.0
    open_meteo_rain_probability = open_meteo.get("rain_probability") if open_meteo else None
    model_rain_probability = model_consensus_value(owm_rain_probability, open_meteo_rain_probability)
    pattern_rain_probability = clamp(pattern["rain_probability"] + recent["rain_anomaly"] * 0.25, 0.02, 0.95)
    likely_rain_probability = round(
        rain_probability_model_weight * model_rain_probability
        + (1 - rain_probability_model_weight) * pattern_rain_probability,
        2,
    )
    model_rain = model_consensus_value(owm.get("rain_mm") or 0.0, open_meteo.get("rain_mm") if open_meteo else None)
    pattern_expected_rain = pattern_rain_probability * pattern["rain_mm"]
    likely_rain = round(
        rain_amount_model_weight * model_rain
        + (1 - rain_amount_model_weight) * pattern_expected_rain,
        1,
    )
    likely_wind = model_consensus_value(owm.get("wind_mean"), open_meteo.get("wind_mean") if open_meteo else None)
    likely_t_min = model_consensus_value(owm.get("t_min"), open_meteo.get("t_min") if open_meteo else None)
    likely_t_max = model_consensus_value(owm.get("t_max"), open_meteo.get("t_max") if open_meteo else None)
    if likely_t_min is not None:
        likely_t_min = likely_t_min + (likely_temp - model_temp)
    if likely_t_max is not None:
        likely_t_max = likely_t_max + (likely_temp - model_temp)

    temp_gap = abs((owm_temp or pattern_temp) - pattern_temp)
    precip_gap = abs(owm_rain_probability - pattern_rain_probability)
    model_temp_gap = abs(owm_temp - open_meteo["t_mean"]) if open_meteo and owm_temp is not None and open_meteo.get("t_mean") is not None else 0.0
    model_precip_gap = abs(owm_rain_probability - open_meteo_rain_probability) if open_meteo_rain_probability is not None else 0.0
    spread = max(pattern["t_std"], 1.8)
    confidence_components = confidence_breakdown(
        temp_gap=temp_gap,
        precip_gap=precip_gap,
        model_temp_gap=model_temp_gap,
        model_precip_gap=model_precip_gap,
        spread=spread,
        sample_size=pattern["sample_size"],
        horizon_index=horizon_index,
    )
    confidence = round(clamp(
        confidence_components["overall"],
        28,
        96,
    ))
    confidence_details = {
        "value": confidence,
        "label": confidence_label(confidence),
        "components": confidence_components,
        "temperature_gap_c": round(temp_gap, 1),
        "precipitation_gap_points": round(precip_gap, 2),
        "model_temperature_gap_c": round(model_temp_gap, 1),
        "model_precipitation_gap_points": round(model_precip_gap, 2),
        "historical_spread_c": round(spread, 1),
        "historical_sample_size": pattern["sample_size"],
        "forecast_horizon_days": horizon_index,
        "meaning": "Vertrauen in den wahrscheinlich angepassten Forecast; sinkt bei OpenWeather/Open-Meteo-Dissens, DWD-Musterbruch und langem Horizont.",
    }
    explanation = build_explanation(
        owm=owm,
        open_meteo=open_meteo,
        pattern=pattern,
        recent=recent,
        likely_temp=likely_temp,
        likely_rain_probability=likely_rain_probability,
        likely_rain=likely_rain,
        confidence_details=confidence_details,
        station=station,
    )
    likely = {
        "t_mean": round(likely_temp, 1),
        "t_min": round(likely_t_min, 1) if likely_t_min is not None else None,
        "t_max": round(likely_t_max, 1) if likely_t_max is not None else None,
        "rain_probability": likely_rain_probability,
        "rain_mm": likely_rain,
        "wind_mean": round(likely_wind, 1) if likely_wind is not None else None,
            "condition": condition_label(
                owm.get("description", ""),
                likely_rain_probability,
                likely_wind,
                open_meteo.get("description") if open_meteo else None,
            ),
            "risk": risk_labels(likely_temp, likely_rain_probability, likely_rain, likely_wind),
            "advice": advice_labels(likely_temp, likely_rain_probability, likely_rain, likely_wind),
            "confidence": confidence,
            "label": confidence_label(confidence),
            "method": "OpenWeather/Open-Meteo-Modellkonsens, korrigiert durch DWD-Klimakorridor und aktuelle Stationsanomalie.",
            "temperature_adjustment_c": round(likely_temp - model_temp, 1),
            "rain_adjustment_points": round(likely_rain_probability - model_rain_probability, 2),
            "verdict": explanation["verdict"],
        }
    rain_signal = build_rain_signal(
        likely_rain_probability=likely_rain_probability,
        likely_rain=likely_rain,
        model_rain_probability=model_rain_probability,
        model_rain=model_rain,
        pattern_rain_probability=pattern_rain_probability,
        pattern_rain=pattern_expected_rain,
        owm=owm,
        open_meteo=open_meteo,
    )

    return {
        "date": day["date"],
        "weekday": target_date.strftime("%a"),
        "openweather": owm,
        "open_meteo": open_meteo,
        "model_consensus": {
            "t_mean": round(model_temp, 1),
            "rain_probability": round(model_rain_probability, 2),
            "rain_mm": round(model_rain, 1),
            "wind_mean": round(likely_wind, 1) if likely_wind is not None else None,
        },
        "pattern": {
            "t_mean": round(pattern["t_mean"], 1),
            "t_low": round(pattern["t_low"], 1),
            "t_high": round(pattern["t_high"], 1),
            "rain_probability": round(pattern_rain_probability, 2),
            "rain_mm": round(pattern_expected_rain, 1),
            "rain_if_wet_mm": round(pattern["rain_mm"], 1),
            "rain_p75": round(pattern["rain_p75"], 1),
            "heavy_rain_probability": round(pattern["heavy_rain_probability"], 2),
            "sample_size": pattern["sample_size"],
            "recent_temp_anomaly": round(recent["temp_anomaly"], 1),
            "corridor": "10. bis 90. Perzentil der historischen DWD-Tagesmitteltemperatur im Datumsfenster.",
        },
        "rain_signal": rain_signal,
        "math": {
            "temperature": {
                "weight_source": WEIGHTING_STATUS,
                "weight_note": WEIGHTING_NOTE,
                "openweather_c": round_optional(owm_temp, 1),
                "open_meteo_c": round_optional(open_meteo.get("t_mean") if open_meteo else None, 1),
                "model_mean_c": round(model_temp, 1),
                "dwd_historical_mean_c": round(pattern["t_mean"], 1),
                "recent_anomaly_c": round(recent["temp_anomaly"], 1),
                "recent_weight": round(max(0.15, 0.75 - horizon_index * 0.12), 2),
                "dwd_adjusted_pattern_c": round(pattern_temp, 1),
                "model_weight": round(temp_model_weight, 2),
                "dwd_weight": round(1 - temp_model_weight, 2),
                "likely_c": round(likely_temp, 1),
                "formula": "likely_temp = temp_model_weight * model_mean + (1 - temp_model_weight) * (dwd_mean + recent_anomaly * recent_weight)",
            },
            "rain": {
                "weight_source": WEIGHTING_STATUS,
                "weight_note": WEIGHTING_NOTE,
                "openweather_probability": round(owm_rain_probability, 2),
                "open_meteo_probability": round_optional(open_meteo_rain_probability, 2),
                "model_probability": round(model_rain_probability, 2),
                "dwd_probability": round(pattern_rain_probability, 2),
                "likely_probability": likely_rain_probability,
                "probability_model_weight": round(rain_probability_model_weight, 2),
                "openweather_mm": round(owm.get("rain_mm") or 0.0, 1),
                "open_meteo_mm": round_optional(open_meteo.get("rain_mm") if open_meteo else None, 1),
                "model_mm": round(model_rain, 1),
                "dwd_if_wet_mm": round(pattern["rain_mm"], 1),
                "dwd_expected_mm": round(pattern_expected_rain, 1),
                "likely_mm": likely_rain,
                "amount_model_weight": round(rain_amount_model_weight, 2),
                "score": rain_signal["score"],
                "formula": "likely_rain_probability = rain_probability_model_weight * model_probability + (1 - rain_probability_model_weight) * dwd_probability; likely_rain_mm = rain_amount_model_weight * model_mm + (1 - rain_amount_model_weight) * dwd_expected_mm",
            },
            "confidence": {
                "weight_source": WEIGHTING_STATUS,
                "weight_note": WEIGHTING_NOTE,
                "overall": confidence,
                "components": confidence_components,
                "temperature_gap_c": round(temp_gap, 1),
                "dwd_rain_gap_points": round(precip_gap, 2),
                "model_temperature_gap_c": round(model_temp_gap, 1),
                "model_rain_gap_points": round(model_precip_gap, 2),
                "historical_spread_c": round(spread, 1),
                "sample_size": pattern["sample_size"],
                "horizon_index": horizon_index,
                "formula": "overall = 0.30*model_agreement + 0.24*dwd_fit + 0.18*rain_fit + 0.16*data_depth + 0.12*horizon",
            },
        },
        "likely": likely,
        "challenged": likely,
        "confidence": confidence_details,
        "explanation": explanation,
        "signal": explanation["summary"],
    }


def historical_pattern(observations: list[dict[str, Any]], target_date: date, window: int = 12) -> dict[str, Any]:
    values = []
    for row in observations:
        measured = date.fromisoformat(row["date"])
        if row.get("t_mean") is None:
            continue
        day_distance = circular_day_distance(measured.timetuple().tm_yday, target_date.timetuple().tm_yday)
        if day_distance <= window and measured.year < target_date.year:
            values.append(row)

    if len(values) < 20:
        values = [row for row in observations if row.get("t_mean") is not None][-365:]

    temps = [row["t_mean"] for row in values if row.get("t_mean") is not None]
    rains = [row.get("rain_mm", 0.0) or 0.0 for row in values]
    rain_days = [rain for rain in rains if rain >= 0.2]
    heavy_rain_days = [rain for rain in rains if rain >= 5.0]
    return {
        "t_mean": statistics.fmean(temps) if temps else 15.0,
        "t_low": percentile(temps, 10) if temps else 8.0,
        "t_high": percentile(temps, 90) if temps else 22.0,
        "t_std": statistics.pstdev(temps) if len(temps) > 1 else 3.0,
        "rain_probability": len(rain_days) / len(rains) if rains else 0.35,
        "rain_mm": statistics.fmean(rain_days) if rain_days else 0.0,
        "rain_p75": percentile(rain_days, 75) if rain_days else 0.0,
        "heavy_rain_probability": len(heavy_rain_days) / len(rains) if rains else 0.0,
        "sample_size": len(values),
    }


def recent_signal(observations: list[dict[str, Any]], target_date: date) -> dict[str, float]:
    recent_rows = [row for row in observations if row.get("t_mean") is not None][-14:]
    if not recent_rows:
        return {"temp_anomaly": 0.0, "rain_anomaly": 0.0}

    anomalies = []
    wet_days = 0
    for row in recent_rows:
        measured = date.fromisoformat(row["date"])
        pattern = historical_pattern(observations, measured, window=10)
        anomalies.append(row["t_mean"] - pattern["t_mean"])
        if (row.get("rain_mm") or 0.0) >= 0.2:
            wet_days += 1

    current_pattern = historical_pattern(observations, target_date, window=10)
    rain_anomaly = wet_days / len(recent_rows) - current_pattern["rain_probability"]
    return {
        "temp_anomaly": statistics.fmean(anomalies),
        "rain_anomaly": rain_anomaly,
    }


def build_explanation(
    owm: dict[str, Any],
    open_meteo: dict[str, Any] | None,
    pattern: dict[str, Any],
    recent: dict[str, float],
    likely_temp: float,
    likely_rain_probability: float,
    likely_rain: float,
    confidence_details: dict[str, Any],
    station: Station,
) -> dict[str, Any]:
    owm_temp = owm.get("t_mean")
    owm_rain_probability = owm.get("rain_probability") or 0.0
    owm_rain = owm.get("rain_mm") or 0.0
    open_meteo_temp = open_meteo.get("t_mean") if open_meteo else None
    open_meteo_rain_probability = open_meteo.get("rain_probability") if open_meteo else None
    open_meteo_rain = open_meteo.get("rain_mm") if open_meteo else None
    wind = model_consensus_value(owm.get("wind_mean"), open_meteo.get("wind_mean") if open_meteo else None)
    model_temp = model_consensus_value(owm_temp, open_meteo_temp)
    model_rain_probability = model_consensus_value(owm_rain_probability, open_meteo_rain_probability)
    model_rain = model_consensus_value(owm_rain, open_meteo_rain)
    temp_adjustment = likely_temp - model_temp if model_temp is not None else 0.0
    rain_adjustment = likely_rain_probability - model_rain_probability if model_rain_probability is not None else 0.0

    verdict_parts = []
    if temp_adjustment >= 0.4:
        verdict_parts.append(f"wärmer (+{temp_adjustment:.1f}°C)")
    elif temp_adjustment <= -0.4:
        verdict_parts.append(f"kälter ({temp_adjustment:.1f}°C)")
    else:
        verdict_parts.append("temperaturseitig nahe am Modellkonsens")

    if rain_adjustment >= 0.08:
        verdict_parts.append(f"mehr Regen (+{round(rain_adjustment * 100)} Prozentpunkte)")
    elif rain_adjustment <= -0.08:
        verdict_parts.append(f"weniger Regen ({round(rain_adjustment * 100)} Prozentpunkte)")
    elif likely_rain_probability <= 0.25:
        verdict_parts.append("eher trocken")
    elif likely_rain_probability >= 0.65:
        verdict_parts.append("hohes Regenrisiko")

    if wind is not None:
        if wind >= 17.2:
            verdict_parts.append("Sturmrisiko")
        elif wind >= 10.8:
            verdict_parts.append("windig")
        else:
            verdict_parts.append("kein Sturmsignal")

    reasons = []
    if open_meteo:
        if abs((owm_temp or 0.0) - (open_meteo_temp or 0.0)) <= 1.2:
            reasons.append("OpenWeather und Open-Meteo sind temperaturseitig nah beieinander")
        elif owm_temp is not None and open_meteo_temp is not None:
            warmer_model = "OpenWeather" if owm_temp > open_meteo_temp else "Open-Meteo"
            reasons.append(f"Modell-Dissens: {warmer_model} ist {abs(owm_temp - open_meteo_temp):.1f}°C wärmer")
        if open_meteo_rain_probability is not None and abs(owm_rain_probability - open_meteo_rain_probability) >= 0.25:
            reasons.append(f"Modelle widersprechen sich beim Regen um {round(abs(owm_rain_probability - open_meteo_rain_probability) * 100)} Prozentpunkte")

    if owm_temp is not None:
        if model_temp is not None and model_temp > pattern["t_high"]:
            reasons.append("der Modellkonsens liegt am warmen Rand des historischen DWD-Korridors")
        elif model_temp is not None and model_temp < pattern["t_low"]:
            reasons.append("der Modellkonsens liegt am kalten Rand des historischen DWD-Korridors")
        elif abs(temp_adjustment) >= 0.4:
            if temp_adjustment > 0:
                reasons.append("DWD-Muster und aktuelle Stationslage heben den Modellkonsens nach oben")
            else:
                reasons.append("DWD-Muster und lokaler Korridor bremsen den Modellkonsens nach unten")
        else:
            reasons.append("der Modellkonsens passt temperaturseitig gut zum lokalen DWD-Korridor")

    if abs(recent["temp_anomaly"]) >= 2.0:
        direction = "wärmer" if recent["temp_anomaly"] > 0 else "kälter"
        reasons.append(f"die letzten 14 Stationstage waren {abs(recent['temp_anomaly']):.1f}°C {direction} als üblich")

    if abs(rain_adjustment) >= 0.08:
        rain_direction = "höher" if rain_adjustment > 0 else "niedriger"
        reasons.append(f"DWD-Historie bewertet das Regenrisiko {rain_direction} als der Modellkonsens")
    elif likely_rain_probability >= 0.65:
        reasons.append("OpenWeather und DWD stützen ein regnerisches Szenario")
    elif likely_rain_probability <= 0.25:
        reasons.append("OpenWeather bleibt trocken, DWD hebt nur das lokale Basisrisiko leicht an")

    if wind is not None:
        if wind >= 17.2:
            reasons.append(f"OpenWeather meldet {wind:.1f} m/s Wind, das ist stürmisch")
        elif wind >= 10.8:
            reasons.append(f"OpenWeather meldet {wind:.1f} m/s Wind, daher windiger Tag")

    confidence_reasons = []
    if confidence_details["historical_sample_size"] >= 80:
        confidence_reasons.append(f"{confidence_details['historical_sample_size']} historische Vergleichstage stützen den DWD-Vergleich")
    if confidence_details["temperature_gap_c"] >= 3.0:
        confidence_reasons.append(f"{confidence_details['temperature_gap_c']}°C Abstand zum lokalen DWD-Muster senken den Wert")
    elif confidence_details["temperature_gap_c"] <= 1.2:
        confidence_reasons.append("Temperaturmodell und DWD-Muster liegen nah beieinander")
    if confidence_details["precipitation_gap_points"] >= 0.3:
        confidence_reasons.append(f"{round(confidence_details['precipitation_gap_points'] * 100)} Prozentpunkte Unterschied zum DWD-Regenrisiko senken den Wert")
    if confidence_details.get("model_temperature_gap_c", 0) >= 2.0:
        confidence_reasons.append(f"{confidence_details['model_temperature_gap_c']}°C Unterschied zwischen OpenWeather und Open-Meteo senken den Wert")
    if confidence_details.get("model_precipitation_gap_points", 0) >= 0.25:
        confidence_reasons.append(f"{round(confidence_details['model_precipitation_gap_points'] * 100)} Prozentpunkte Regen-Unterschied zwischen den Modellen senken den Wert")
    if confidence_details["forecast_horizon_days"] >= 3:
        confidence_reasons.append("weiter Vorhersagehorizont senkt den Wert")

    summary = f"Wahrscheinlicher Forecast: {', '.join(verdict_parts)}. Warum: {', '.join(reasons)}. Station: {station.name}."
    confidence_summary = (
        f"Confidence {confidence_details['value']} ({confidence_details['label']}): "
        f"Verlässlichkeit des angepassten Forecasts, keine Wetterwahrscheinlichkeit. "
        f"{', '.join(confidence_reasons)}."
    )
    return {
        "verdict": ", ".join(verdict_parts),
        "summary": summary,
        "confidence": confidence_summary,
        "temperature_adjustment_c": round(temp_adjustment, 1),
        "rain_adjustment_points": round(rain_adjustment, 2),
        "rain_amount_adjustment_mm": round(likely_rain - owm_rain, 1),
        "wind_risk": wind_risk_label(wind),
        "reasons": reasons,
        "confidence_reasons": confidence_reasons,
    }


def confidence_breakdown(
    temp_gap: float,
    precip_gap: float,
    model_temp_gap: float,
    model_precip_gap: float,
    spread: float,
    sample_size: int,
    horizon_index: int,
) -> dict[str, Any]:
    model_agreement = clamp(100 - model_temp_gap * 10 - model_precip_gap * 85, 25, 100)
    climate_fit = clamp(100 - (temp_gap / max(spread, 1.0)) * 24 - precip_gap * 52, 20, 100)
    rain_fit = clamp(100 - precip_gap * 90 - model_precip_gap * 45, 20, 100)
    data_depth = clamp(sample_size / 80 * 100, 35, 100)
    horizon = clamp(100 - horizon_index * 9, 55, 100)
    overall = (
        model_agreement * 0.30
        + climate_fit * 0.24
        + rain_fit * 0.18
        + data_depth * 0.16
        + horizon * 0.12
    )
    return {
        "overall": round(overall),
        "model_agreement": round(model_agreement),
        "climate_fit": round(climate_fit),
        "rain_fit": round(rain_fit),
        "data_depth": round(data_depth),
        "horizon": round(horizon),
        "explain": {
            "model_agreement": "OpenWeather und Open-Meteo nah beieinander",
            "climate_fit": "Modellkonsens passt zum lokalen DWD-Korridor",
            "rain_fit": "Regenmodelle und historisches Regenrisiko passen zusammen",
            "data_depth": "genug historische DWD-Vergleichstage vorhanden",
            "horizon": "kurzer Vorhersagehorizont",
        },
    }


def build_rain_signal(
    likely_rain_probability: float,
    likely_rain: float,
    model_rain_probability: float,
    model_rain: float,
    pattern_rain_probability: float,
    pattern_rain: float,
    owm: dict[str, Any],
    open_meteo: dict[str, Any] | None,
) -> dict[str, Any]:
    score = rain_score(likely_rain_probability, likely_rain)
    secondary_probability = (
        open_meteo.get("rain_probability")
        if open_meteo and open_meteo.get("rain_probability") is not None
        else model_rain_probability
    )
    disagreement = abs((owm.get("rain_probability") or 0.0) - secondary_probability)
    return {
        "score": score,
        "level": rain_level(likely_rain_probability, likely_rain),
        "probability": round(likely_rain_probability, 2),
        "amount_mm": round(likely_rain, 1),
        "model_probability": round(model_rain_probability, 2),
        "model_amount_mm": round(model_rain, 1),
        "dwd_probability": round(pattern_rain_probability, 2),
        "dwd_amount_mm": round(pattern_rain, 1),
        "model_disagreement_points": round(disagreement, 2),
        "interpretation": rain_interpretation(likely_rain_probability, likely_rain, disagreement),
    }


def rain_level(probability: float, amount_mm: float) -> str:
    score = rain_score(probability, amount_mm)
    if score < 18:
        return "geringes Regenrisiko"
    if score < 35:
        return "leichtes Schauerrisiko"
    if probability >= 0.75 or amount_mm >= 8:
        return "Regen wahrscheinlich"
    if probability >= 0.5 or amount_mm >= 3:
        return "wechselhaft mit Regen"
    if probability >= 0.3 or amount_mm >= 0.5:
        return "einzelne Schauer"
    return "eher trocken"


def rain_interpretation(probability: float, amount_mm: float, disagreement: float) -> str:
    score = rain_score(probability, amount_mm)
    if score < 18:
        return "Niedriger Regen-Index: höchstens lokale oder kurze Schauer, das trockenere Szenario überwiegt."
    if disagreement >= 0.25:
        return "Regen unsicher, weil OpenWeather und Open-Meteo deutlich auseinanderliegen."
    if probability >= 0.65 and amount_mm >= 3:
        return "Regen ist wahrscheinlicher und auch mengenmäßig relevant."
    if probability >= 0.45:
        return "Schauer sind plausibel, die genaue Menge bleibt wichtiger als die reine Prozentzahl."
    if amount_mm >= 2:
        return "Unsicher, aber einzelne Regenphasen können reichen."
    return "Das eher trockene Szenario hat aktuell die besseren Argumente."


def rain_score(probability: float, amount_mm: float) -> int:
    amount_score = clamp(amount_mm / 12, 0.0, 1.0)
    return round(probability * 72 + amount_score * 28)


def rain_window_label(slots: list[dict[str, Any]]) -> str:
    if not slots:
        return "kein klares Regenfenster"
    hours = [datetime.fromisoformat(slot["time"]).hour for slot in slots]
    start = min(hours)
    end = max(hours)
    if start < 12 and end < 12:
        return "vormittags"
    if start >= 12 and end < 18:
        return "nachmittags"
    if start >= 18:
        return "abends/nachts"
    if start < 12 and end >= 18:
        return "über den Tag verteilt"
    return "mittags bis abends"


def build_overview(label: str, station: Station, days: list[dict[str, Any]], current: dict[str, Any] | None = None) -> dict[str, Any]:
    if not days:
        return {
            "headline": "Noch keine Vorhersagetage verfügbar.",
            "detail": "",
            "actions": [],
            "watch": [],
        }

    first = days[0]
    likely_first = first["likely"]
    wettest = max(days, key=lambda day: day["likely"]["rain_probability"])
    warmest = max(days, key=lambda day: day["likely"]["t_max"] if day["likely"].get("t_max") is not None else day["likely"]["t_mean"])
    windiest = max(days, key=lambda day: day["likely"].get("wind_mean") or 0)
    weakest = min(days, key=lambda day: day["likely"]["confidence"])
    avg_confidence = round(statistics.fmean(day["likely"]["confidence"] for day in days))

    current_temp = (current or {}).get("best", {}).get("temperature_c")
    if current_temp is not None:
        headline = (
            f"{label}: jetzt {current_temp:.1f}°, heute {likely_first['condition'].lower()}, "
            f"{likely_first['t_mean']:.1f}° im Tagesmittel, {round(likely_first['rain_probability'] * 100)}% Regenrisiko."
        )
    else:
        headline = (
            f"{label}: {likely_first['condition']} heute, "
            f"{likely_first['t_mean']:.1f}° im Tagesmittel, {round(likely_first['rain_probability'] * 100)}% Regenrisiko."
        )
    detail = (
        f"Jetzt-Wert und Tagesmittel sind unterschiedliche Größen. "
        f"Wärmster Tag: {format_day_label(warmest['date'])} mit bis zu {warmest['likely'].get('t_max', warmest['likely']['t_mean']):.1f}°. "
        f"Höchstes Regenrisiko: {format_day_label(wettest['date'])} mit {round(wettest['likely']['rain_probability'] * 100)}%. "
        f"Confidence im Mittel: {avg_confidence}%; unsicherster Tag: {format_day_label(weakest['date'])} ({weakest['likely']['confidence']}%)."
    )

    actions = []
    for day in days[:3]:
        for advice in day["likely"].get("advice", []):
            item = f"{format_day_label(day['date'])}: {advice}"
            if item not in actions:
                actions.append(item)
    if not actions:
        actions.append("Keine auffälligen Wettermaßnahmen in den nächsten drei Tagen.")

    watch = []
    for candidate in (wettest, warmest, windiest, weakest):
        label_text = format_day_label(candidate["date"])
        risks = candidate["likely"].get("risk", [])
        if risks:
            watch.append(f"{label_text}: {', '.join(risks)}")
    if not watch:
        watch.append(f"Keine markanten Warnsignale an der DWD-Station {station.name}.")

    return {
        "headline": headline,
        "detail": detail,
        "actions": actions[:4],
        "watch": list(dict.fromkeys(watch))[:4],
        "avg_confidence": avg_confidence,
        "station_note": f"DWD-Referenz: {station.name}, {round(station.distance_km, 1)} km entfernt.",
    }


def learned_blend_weights(station: Station, observations: list[dict[str, Any]]) -> dict[str, Any]:
    cases = training_cases(station, observations)
    if len(cases) < MIN_TRAINING_CASES:
        return {
            "status": "warming_up",
            "weights": DEFAULT_BLEND_WEIGHTS.copy(),
            "cases": len(cases),
            "minimum_cases": MIN_TRAINING_CASES,
            "summary": f"Lernmodus aktiv, aber erst {len(cases)} verifizierte Fälle. Startgewichte bleiben aktiv.",
        }

    temp_weight, temp_mae = best_weight(
        cases,
        model_key="temp_model",
        dwd_key="temp_dwd",
        actual_key="actual_temp",
        metric="mae",
    )
    rain_probability_weight, rain_brier = best_weight(
        cases,
        model_key="rain_probability_model",
        dwd_key="rain_probability_dwd",
        actual_key="actual_wet",
        metric="brier",
    )
    rain_amount_weight, rain_mae = best_weight(
        cases,
        model_key="rain_amount_model",
        dwd_key="rain_amount_dwd",
        actual_key="actual_rain",
        metric="mae",
    )
    weights = {
        "temp_model": temp_weight,
        "rain_probability_model": rain_probability_weight,
        "rain_amount_model": rain_amount_weight,
    }
    return {
        "status": "active",
        "weights": weights,
        "cases": len(cases),
        "minimum_cases": MIN_TRAINING_CASES,
        "scores": {
            "temp_mae_c": round(temp_mae, 3),
            "rain_probability_brier": round(rain_brier, 4),
            "rain_amount_mae_mm": round(rain_mae, 3),
        },
        "summary": (
            f"Gelernte Gewichte aus {len(cases)} verifizierten Fällen: "
            f"Temperatur {temp_weight:.2f} Modell, Regen-Wahrscheinlichkeit {rain_probability_weight:.2f} Modell, "
            f"Regenmenge {rain_amount_weight:.2f} Modell."
        ),
    }


def training_cases(station: Station, observations: list[dict[str, Any]]) -> list[dict[str, float]]:
    actuals = {row["date"]: row for row in observations if row.get("t_mean") is not None}
    cases = []
    seen: set[tuple[str, str]] = set()
    for snapshot in load_forecast_archive():
        if snapshot.get("station", {}).get("id") != station.station_id:
            continue
        issued_date = (snapshot.get("generated_at") or "")[:10]
        for forecast in snapshot.get("days", []):
            target_date = forecast.get("date")
            actual = actuals.get(target_date)
            math_block = forecast.get("math") or {}
            temp = math_block.get("temperature") or {}
            rain = math_block.get("rain") or {}
            key = (issued_date, target_date or "")
            if key in seen or not actual:
                continue
            required = [
                temp.get("model_mean_c"),
                temp.get("dwd_adjusted_pattern_c"),
                rain.get("model_probability"),
                rain.get("dwd_probability"),
                rain.get("model_mm"),
                rain.get("dwd_expected_mm"),
            ]
            if any(value is None for value in required):
                continue
            actual_rain = actual.get("rain_mm") or 0.0
            cases.append({
                "temp_model": float(temp["model_mean_c"]),
                "temp_dwd": float(temp["dwd_adjusted_pattern_c"]),
                "actual_temp": float(actual["t_mean"]),
                "rain_probability_model": float(rain["model_probability"]),
                "rain_probability_dwd": float(rain["dwd_probability"]),
                "actual_wet": 1.0 if actual_rain >= 0.2 else 0.0,
                "rain_amount_model": float(rain["model_mm"]),
                "rain_amount_dwd": float(rain["dwd_expected_mm"]),
                "actual_rain": float(actual_rain),
            })
            seen.add(key)
    return cases


def best_weight(
    cases: list[dict[str, float]],
    model_key: str,
    dwd_key: str,
    actual_key: str,
    metric: str,
) -> tuple[float, float]:
    candidates = [round(value / 100, 2) for value in range(45, 96, 5)]
    best_candidate = DEFAULT_BLEND_WEIGHTS.get(model_key.replace("_model", "_model"), 0.75)
    best_score = float("inf")
    for candidate in candidates:
        errors = []
        for case in cases:
            predicted = candidate * case[model_key] + (1 - candidate) * case[dwd_key]
            actual = case[actual_key]
            if metric == "brier":
                predicted = clamp(predicted, 0.0, 1.0)
                errors.append((predicted - actual) ** 2)
            else:
                errors.append(abs(predicted - actual))
        score = statistics.fmean(errors) if errors else float("inf")
        if score < best_score:
            best_candidate = candidate
            best_score = score
    return best_candidate, best_score


def record_forecast_snapshot(payload: dict[str, Any]) -> None:
    if forecast_snapshot_exists(payload):
        return
    snapshot = {
        "generated_at": payload["source"]["generated_at"],
        "location": payload["location"],
        "station": {
            "id": payload["station"]["id"],
            "name": payload["station"]["name"],
        },
        "days": [
            {
                "date": day["date"],
                "openweather": compact_forecast(day.get("openweather")),
                "open_meteo": compact_forecast(day.get("open_meteo")),
                "model_consensus": compact_forecast(day.get("model_consensus")),
                "likely": compact_forecast(day.get("likely")),
                "math": day.get("math"),
            }
            for day in payload.get("days", [])
        ],
    }
    with ARCHIVE_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(snapshot, ensure_ascii=False) + "\n")


def forecast_snapshot_exists(payload: dict[str, Any]) -> bool:
    issued_date = payload["source"]["generated_at"][:10]
    station_id = payload["station"]["id"]
    location_label = normalize_city(payload["location"]["label"])
    for snapshot in load_forecast_archive():
        if (snapshot.get("generated_at") or "")[:10] != issued_date:
            continue
        if snapshot.get("station", {}).get("id") != station_id:
            continue
        if normalize_city(snapshot.get("location", {}).get("label", "")) == location_label:
            return True
    return False


def archive_calibration(station: Station, observations: list[dict[str, Any]]) -> dict[str, Any]:
    snapshots = load_forecast_archive()
    station_snapshots = [item for item in snapshots if item.get("station", {}).get("id") == station.station_id]
    actuals = {row["date"]: row for row in observations if row.get("t_mean") is not None}
    rows = []
    for snapshot in station_snapshots[-300:]:
        for forecast in snapshot.get("days", []):
            actual = actuals.get(forecast.get("date"))
            if not actual:
                continue
            likely = forecast.get("likely") or {}
            openweather = forecast.get("openweather") or {}
            if likely.get("t_mean") is None or openweather.get("t_mean") is None:
                continue
            observed_wet = 1.0 if (actual.get("rain_mm") or 0.0) >= 0.2 else 0.0
            rows.append({
                "likely_temp_error": abs(float(likely["t_mean"]) - float(actual["t_mean"])),
                "openweather_temp_error": abs(float(openweather["t_mean"]) - float(actual["t_mean"])),
                "likely_rain_brier": (float(likely.get("rain_probability") or 0.0) - observed_wet) ** 2,
                "openweather_rain_brier": (float(openweather.get("rain_probability") or 0.0) - observed_wet) ** 2,
            })

    if not rows:
        return {
            "status": "learning",
            "snapshots": len(station_snapshots),
            "evaluated_days": 0,
            "summary": "Kalibrierung baut sich auf: Nach den ersten abgelaufenen Forecast-Tagen werden Temperaturfehler und Regen-Brier-Score gegen DWD-Istwerte bewertet.",
        }

    likely_mae = statistics.fmean(row["likely_temp_error"] for row in rows)
    openweather_mae = statistics.fmean(row["openweather_temp_error"] for row in rows)
    likely_brier = statistics.fmean(row["likely_rain_brier"] for row in rows)
    openweather_brier = statistics.fmean(row["openweather_rain_brier"] for row in rows)
    better_temp = likely_mae <= openweather_mae
    better_rain = likely_brier <= openweather_brier
    return {
        "status": "active",
        "snapshots": len(station_snapshots),
        "evaluated_days": len(rows),
        "likely_temp_mae_c": round(likely_mae, 2),
        "openweather_temp_mae_c": round(openweather_mae, 2),
        "likely_rain_brier": round(likely_brier, 3),
        "openweather_rain_brier": round(openweather_brier, 3),
        "summary": (
            f"Archiv-Backtest aktiv: {len(rows)} bewertete Tage. "
            f"Temperatur {'besser' if better_temp else 'noch schwächer'} als OpenWeather, "
            f"Regen {'besser' if better_rain else 'noch schwächer'} im Brier-Score."
        ),
    }


def load_forecast_archive() -> list[dict[str, Any]]:
    if not ARCHIVE_PATH.exists():
        return []
    snapshots = []
    for line in ARCHIVE_PATH.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            snapshots.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return snapshots


def compact_forecast(forecast: dict[str, Any] | None) -> dict[str, Any] | None:
    if not forecast:
        return None
    return {
        "t_mean": forecast.get("t_mean"),
        "t_min": forecast.get("t_min"),
        "t_max": forecast.get("t_max"),
        "rain_probability": forecast.get("rain_probability"),
        "rain_mm": forecast.get("rain_mm"),
        "wind_mean": forecast.get("wind_mean"),
        "confidence": forecast.get("confidence"),
    }


def condition_label(description: str, rain_probability: float, wind_mps: float | None, secondary_description: str | None = None) -> str:
    desc = description.lower()
    secondary = (secondary_description or "").lower()
    if wind_mps is not None and wind_mps >= 17.2:
        return "Stürmisch"
    if rain_probability >= 0.75:
        return "Regen wahrscheinlich"
    if rain_probability >= 0.45:
        return "Schauer möglich"
    if ("klar" in desc or "sonne" in desc) and ("bedeckt" in secondary or "wolken" in secondary or "bewölkt" in secondary):
        return "Sonne/Wolken unsicher"
    if ("klar" in secondary or "sonne" in secondary) and ("bedeckt" in desc or "wolken" in desc or "bewölkt" in desc):
        return "Sonne/Wolken unsicher"
    if "klar" in desc or "sonne" in desc:
        return "Eher sonnig"
    if "klar" in secondary or "sonne" in secondary:
        return "Eher sonnig"
    if "wolken" in desc or "bedeckt" in desc:
        return "Wolkig"
    if "wolken" in secondary or "bedeckt" in secondary or "bewölkt" in secondary:
        return "Wolkig"
    if rain_probability <= 0.2:
        return "Eher trocken"
    return "Wechselhaft"


def risk_labels(temp_c: float, rain_probability: float, rain_mm: float, wind_mps: float | None) -> list[str]:
    risks = []
    if temp_c >= 28:
        risks.append("Hitze")
    elif temp_c <= 0:
        risks.append("Frost")
    if rain_probability >= 0.7 or rain_mm >= 8:
        risks.append("Regen")
    elif rain_probability >= 0.45:
        risks.append("Schauer")
    if wind_mps is not None:
        if wind_mps >= 17.2:
            risks.append("Sturm")
        elif wind_mps >= 10.8:
            risks.append("Wind")
    return risks


def advice_labels(temp_c: float, rain_probability: float, rain_mm: float, wind_mps: float | None) -> list[str]:
    advice = []
    if rain_probability >= 0.65 or rain_mm >= 4:
        advice.append("Schirm/Regenjacke einplanen")
    elif rain_probability >= 0.35:
        advice.append("Regenfenster im Blick behalten")
    if temp_c >= 28:
        advice.append("Hitze und Sonne berücksichtigen")
    elif temp_c <= 8:
        advice.append("wärmere Kleidung sinnvoll")
    if wind_mps is not None:
        if wind_mps >= 17.2:
            advice.append("lose Gegenstände sichern")
        elif wind_mps >= 10.8:
            advice.append("windanfällige Wege prüfen")
    return advice


def format_day_label(value: str) -> str:
    day = date.fromisoformat(value)
    names = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]
    return f"{names[day.weekday()]}, {day.strftime('%d.%m.')}"


def fetch_json(url: str, cache_key: str, ttl_seconds: int) -> Any:
    cache_path = CACHE_DIR / cache_key
    if is_fresh(cache_path, ttl_seconds):
        return json.loads(cache_path.read_text(encoding="utf-8"))
    with open_url(url, timeout=25) as response:
        data = json.loads(response.read().decode("utf-8"))
    cache_path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return data


def fetch_text(url: str, cache_key: str, ttl_seconds: int) -> str:
    cache_path = CACHE_DIR / cache_key
    if is_fresh(cache_path, ttl_seconds):
        return cache_path.read_text(encoding="utf-8", errors="replace")
    with open_url(url, timeout=30) as response:
        raw = response.read()
    text = raw.decode("latin-1")
    cache_path.write_text(text, encoding="utf-8")
    return text


def fetch_bytes(url: str, cache_key: str, ttl_seconds: int) -> bytes:
    cache_path = CACHE_DIR / cache_key
    if is_fresh(cache_path, ttl_seconds):
        return cache_path.read_bytes()
    with open_url(url, timeout=60) as response:
        data = response.read()
    cache_path.write_bytes(data)
    return data


def open_url(url: str, timeout: int):
    try:
        return urllib.request.urlopen(url, timeout=timeout)
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, ssl.SSLCertVerificationError):
            context = ssl._create_unverified_context()
            return urllib.request.urlopen(url, timeout=timeout, context=context)
        raise


def is_fresh(path: Path, ttl_seconds: int) -> bool:
    return path.exists() and time.time() - path.stat().st_mtime <= ttl_seconds


def parse_yyyymmdd(value: str) -> date:
    return datetime.strptime(value, "%Y%m%d").date()


def safe_datetime(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return datetime.min.replace(tzinfo=LOCAL_TZ)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=LOCAL_TZ)
    return parsed.astimezone(LOCAL_TZ)


def timestamp_to_local(value: Any) -> str | None:
    if value is None:
        return None
    try:
        return datetime.fromtimestamp(float(value), timezone.utc).astimezone(LOCAL_TZ).isoformat()
    except (TypeError, ValueError, OSError):
        return None


def normalize_open_meteo_time(value: Any) -> str | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value)).replace(tzinfo=LOCAL_TZ).isoformat()
    except ValueError:
        return None


def parse_float(value: str | None) -> float | None:
    if value is None:
        return None
    value = value.strip()
    if not value or value == "-999":
        return None
    try:
        return float(value)
    except ValueError:
        return None


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    return radius * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def circular_day_distance(day_a: int, day_b: int) -> int:
    distance = abs(day_a - day_b)
    return min(distance, 366 - distance)


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    position = (len(ordered) - 1) * pct / 100
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[int(position)]
    return ordered[lower] * (upper - position) + ordered[upper] * (position - lower)


def blend(model_value: float | None, pattern_value: float, model_weight: float) -> float:
    if model_value is None:
        return pattern_value
    return model_value * model_weight + pattern_value * (1 - model_weight)


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def most_common(values: list[str]) -> str:
    values = [value for value in values if value]
    if not values:
        return ""
    return max(set(values), key=values.count)


def list_value(data: dict[str, Any], key: str, index: int) -> Any:
    values = data.get(key) or []
    if index >= len(values):
        return None
    return values[index]


def round_optional(value: Any, digits: int) -> float | None:
    if value is None:
        return None
    try:
        return round(float(value), digits)
    except (TypeError, ValueError):
        return None


def probability_from_percent(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return round(clamp(float(value) / 100, 0.0, 1.0), 2)
    except (TypeError, ValueError):
        return None


def model_consensus_value(primary: float | int | None, secondary: float | int | None) -> float:
    values = [float(value) for value in (primary, secondary) if value is not None]
    if not values:
        return 0.0
    return statistics.fmean(values)


def weather_code_label(code: Any) -> str:
    try:
        code_int = int(code)
    except (TypeError, ValueError):
        return "Unbekannt"
    labels = {
        0: "Klarer Himmel",
        1: "Überwiegend klar",
        2: "Teilweise bewölkt",
        3: "Bedeckt",
        45: "Nebel",
        48: "Reifnebel",
        51: "Leichter Niesel",
        53: "Niesel",
        55: "Starker Niesel",
        61: "Leichter Regen",
        63: "Regen",
        65: "Starker Regen",
        71: "Leichter Schnee",
        73: "Schnee",
        75: "Starker Schnee",
        80: "Leichte Schauer",
        81: "Schauer",
        82: "Starke Schauer",
        95: "Gewitter",
        96: "Gewitter mit Hagel",
        99: "Starkes Gewitter mit Hagel",
    }
    return labels.get(code_int, "Wechselhaft")


def confidence_label(confidence: int) -> str:
    if confidence >= 78:
        return "hoch"
    if confidence >= 58:
        return "mittel"
    return "fragil"


def wind_risk_label(wind_mps: float | None) -> str:
    if wind_mps is None:
        return "unbekannt"
    if wind_mps >= 17.2:
        return "Sturmrisiko"
    if wind_mps >= 10.8:
        return "windig"
    return "kein Sturmsignal"


def synthetic_observations() -> list[dict[str, Any]]:
    today = date.today()
    rows = []
    for days_back in range(365 * 12, 0, -1):
        current = today - timedelta(days=days_back)
        seasonal = math.sin((current.timetuple().tm_yday - 95) / 365 * 2 * math.pi)
        temp = 10.5 + seasonal * 9.5 + math.sin(days_back / 13) * 2.1
        rain = 0.0 if days_back % 3 else 1.5 + (days_back % 7) * 0.4
        rows.append({
            "date": current.isoformat(),
            "t_mean": round(temp, 1),
            "t_max": round(temp + 4.0, 1),
            "t_min": round(temp - 4.0, 1),
            "rain_mm": round(rain, 1),
            "sun_hours": None,
            "wind_mean": None,
        })
    return rows
