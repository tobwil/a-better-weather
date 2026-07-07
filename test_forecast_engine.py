import unittest
from datetime import date, datetime, timedelta

from forecast_engine import (
    Station,
    build_hourly_forecast,
    build_overview,
    challenge_day,
    rain_level,
    rain_score,
    synthetic_observations,
    historical_pattern,
)
from server import compact_forecast_payload, rss_feed


class ForecastEngineTests(unittest.TestCase):
    def test_historical_pattern_has_temperature_band_and_samples(self):
        observations = synthetic_observations()
        pattern = historical_pattern(observations, date.today())

        self.assertGreater(pattern["sample_size"], 100)
        self.assertLess(pattern["t_low"], pattern["t_mean"])
        self.assertGreater(pattern["t_high"], pattern["t_mean"])
        self.assertGreaterEqual(pattern["rain_probability"], 0)
        self.assertLessEqual(pattern["rain_probability"], 1)

    def test_challenge_day_returns_confidence_and_blended_forecast(self):
        observations = synthetic_observations()
        station = Station(
            station_id="00000",
            name="Demo",
            state="Test",
            lat=52.0,
            lon=13.0,
            height_m=50,
            from_date=date.today() - timedelta(days=3650),
            to_date=date.today(),
            distance_km=1.2,
        )
        day = {
            "date": date.today().isoformat(),
            "openweather": {
                "t_mean": 21.0,
                "t_min": 18.0,
                "t_max": 24.0,
                "rain_mm": 2.0,
                "rain_probability": 0.45,
                "wind_mean": 3.0,
                "description": "wechselhaft",
            },
        }

        result = challenge_day(day, observations, 0, station)

        self.assertIn("likely", result)
        self.assertIn("confidence", result)
        self.assertIn("explanation", result)
        self.assertGreaterEqual(result["likely"]["confidence"], 28)
        self.assertLessEqual(result["likely"]["confidence"], 96)
        self.assertIn("temperature_adjustment_c", result["likely"])
        self.assertIn("rain_adjustment_points", result["likely"])
        self.assertIn("condition", result["likely"])
        self.assertIn("advice", result["likely"])
        self.assertIn("rain_signal", result)
        self.assertIn("math", result)
        self.assertIn("temperature", result["math"])
        self.assertIn("confidence", result["math"])
        self.assertIn("components", result["confidence"])
        self.assertGreaterEqual(result["rain_signal"]["score"], 0)
        self.assertTrue(result["explanation"]["summary"])
        self.assertTrue(result["explanation"]["confidence"])
        self.assertTrue(result["signal"])

    def test_overview_summarizes_days(self):
        observations = synthetic_observations()
        station = Station(
            station_id="00000",
            name="Demo",
            state="Test",
            lat=52.0,
            lon=13.0,
            height_m=50,
            from_date=date.today() - timedelta(days=3650),
            to_date=date.today(),
            distance_km=1.2,
        )
        days = [
            challenge_day({
                "date": (date.today() + timedelta(days=index)).isoformat(),
                "openweather": {
                    "t_mean": 20.0 + index,
                    "t_min": 16.0 + index,
                    "t_max": 24.0 + index,
                    "rain_mm": 1.0 * index,
                    "rain_probability": 0.2 + index * 0.1,
                    "wind_mean": 3.0,
                    "description": "wechselhaft",
                },
            }, observations, index, station)
            for index in range(3)
        ]

        overview = build_overview("Teststadt", station, days)

        self.assertIn("Teststadt", overview["headline"])
        self.assertTrue(overview["actions"])
        self.assertTrue(overview["watch"])

    def test_challenge_day_uses_open_meteo_validation(self):
        observations = synthetic_observations()
        station = Station(
            station_id="00000",
            name="Demo",
            state="Test",
            lat=52.0,
            lon=13.0,
            height_m=50,
            from_date=date.today() - timedelta(days=3650),
            to_date=date.today(),
            distance_km=1.2,
        )
        day = {
            "date": date.today().isoformat(),
            "openweather": {
                "t_mean": 24.0,
                "t_min": 18.0,
                "t_max": 29.0,
                "rain_mm": 0.0,
                "rain_probability": 0.05,
                "wind_mean": 4.0,
                "description": "Klarer Himmel",
            },
            "open_meteo": {
                "t_mean": 18.0,
                "t_min": 12.0,
                "t_max": 23.0,
                "rain_mm": 2.0,
                "rain_probability": 0.55,
                "wind_mean": 5.0,
                "description": "Bedeckt",
            },
        }

        result = challenge_day(day, observations, 0, station)

        self.assertIn("open_meteo", result)
        self.assertIn("model_consensus", result)
        self.assertGreater(result["confidence"]["model_temperature_gap_c"], 0)
        self.assertGreater(result["confidence"]["model_precipitation_gap_points"], 0)
        self.assertIn("Modell", result["explanation"]["summary"])

    def test_hourly_forecast_applies_daily_adjustments(self):
        day = {
            "date": date.today().isoformat(),
            "likely": {
                "temperature_adjustment_c": 1.2,
                "rain_adjustment_points": 0.1,
                "confidence": 72,
            },
        }
        slot_time = f"{date.today().isoformat()}T12:00:00+02:00"
        hourly = build_hourly_forecast(
            {
                slot_time: {
                    "time": slot_time,
                    "t": 20.0,
                    "rain_probability": 0.2,
                    "rain_mm": 0.0,
                    "wind": 3.0,
                }
            },
            {
                slot_time: {
                    "time": slot_time,
                    "t": 22.0,
                    "rain_probability": 0.4,
                    "rain_mm": 1.0,
                    "wind": 5.0,
                }
            },
            [day],
            now=datetime.fromisoformat(slot_time),
        )

        self.assertEqual(len(hourly), 1)
        self.assertAlmostEqual(hourly[0]["likely"]["t"], 22.2)
        self.assertAlmostEqual(hourly[0]["likely"]["rain_probability"], 0.4)
        self.assertEqual(hourly[0]["likely"]["confidence"], 72)

    def test_low_rain_index_is_not_labeled_as_showers(self):
        self.assertEqual(rain_score(0.11, 0.2), 8)
        self.assertEqual(rain_level(0.11, 0.2), "geringes Regenrisiko")

    def test_compact_payload_and_rss_use_forecast_days(self):
        payload = {
            "location": {"label": "Teststadt", "lat": 50.0, "lon": 8.0},
            "station": {"id": "00000", "name": "Demo"},
            "source": {"generated_at": "2026-07-07T12:00:00+00:00"},
            "overview": {"headline": "Teststadt: trocken.", "detail": "", "actions": [], "watch": []},
            "days": [
                {
                    "date": "2026-07-07",
                    "likely": {
                        "condition": "Eher trocken",
                        "t_mean": 21.0,
                        "t_min": 16.0,
                        "t_max": 25.0,
                        "rain_probability": 0.1,
                        "confidence": 82,
                        "label": "hoch",
                        "verdict": "eher trocken",
                    },
                    "rain_signal": {
                        "score": 9,
                        "level": "geringes Regenrisiko",
                        "timing": {"wet_window": "kein klares Regenfenster"},
                    },
                }
            ],
        }

        compact = compact_forecast_payload(payload)
        feed = rss_feed(payload)

        self.assertEqual(compact["days"][0]["rain_index"], 9)
        self.assertIn("/feed.xml?city=Teststadt", compact["feed"])
        self.assertIn("<rss", feed)
        self.assertIn("geringes Regenrisiko", feed)


if __name__ == "__main__":
    unittest.main()
