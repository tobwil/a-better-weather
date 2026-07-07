# a better weather

Eine produktive Wetter-Forecast-Anwendung für Deutschland, die OpenWeather und Open-Meteo mit historischen DWD-Tageswerten plausibilisiert, daraus lokale Muster lernt und einen wahrscheinlicheren Forecast ableitet.

## Idee

Die App sucht die nächstgelegene DWD-Klimastation, lädt deren historische und aktuelle Tageswerte aus dem DWD Open Data CDC, aggregiert OpenWeather und Open-Meteo auf Tagesbasis und legt darüber lokale Muster:

- jahreszeitlicher Temperaturkorridor aus DWD-Historie
- aktuelle Stationsanomalie aus den letzten Tagen
- historische Regenwahrscheinlichkeit rund um den Zieltag
- Regen-Index mit Menge, Modell-Dissens und Zeitfenster
- Confidence-Wert je Vorhersagetag mit Teilwerten für Modell-Einigkeit, DWD-Fit, Regen-Fit, Datentiefe und Horizont
- wahrscheinlicherer Forecast als gewichtete Kombination aus OpenWeather/Open-Meteo-Modellkonsens, DWD-Klimakorridor und aktueller Stationsanomalie
- stündliche Kurzfrist-Timeline aus OpenWeather-3h-Slots und Open-Meteo-Stundenwerten
- Forecast-Archiv für spätere Backtests gegen DWD-Istwerte
- Hinweise, wo OpenWeather warm/kalt/regnerisch/trocken gegen die lokale Historie läuft

Quellen:

- DWD Open Data: `https://opendata.dwd.de/`
- DWD CDC Tageswerte Klima: `climate_environment/CDC/observations_germany/climate/daily/kl/`
- OpenWeather 5 day / 3 hour forecast: `https://api.openweathermap.org/data/2.5/forecast`
- Open-Meteo Forecast API: `https://api.open-meteo.com/v1/forecast`

## Start

```bash
export OPENWEATHER_API_KEY="dein-key"
python3 server.py
```

Dann öffnen:

```text
http://127.0.0.1:8765
```

Ohne `OPENWEATHER_API_KEY` liefert die API bewusst einen Fehler. Die App verwendet im Produktivpfad keine Demo-Forecasts.
Die Startseite lädt standardmäßig Trainingskacheln für Berlin, Muenchen, Nuernberg, Hamburg und Coburg. Eine freie Detailabfrage startet erst nach Ortseingabe und Klick auf `Forecast bauen`.

## API

```text
GET /api/forecast?city=Berlin
GET /api/forecast/compact?city=Berlin
GET /api/forecast?lat=52.52&lon=13.405&label=Berlin
GET /api/stations?city=Hamburg
GET /api/learning
GET /api/learning/dashboard
GET /api/learning/add?city=Kassel
GET /api/learning/remove?city=Kassel
GET /feed.xml?city=Berlin
```

Der Cache liegt in `.weather_cache/`.
Forecast-Snapshots werden produktiv in `.weather_cache/forecast_archive.jsonl` gesammelt. Sobald abgelaufene Forecast-Tage als DWD-Istwerte vorliegen, berechnet die App daraus Temperatur-MAE und Regen-Brier-Score gegen OpenWeather.

`/api/forecast` liefert den vollständigen Payload inklusive `math`-Deep-Dive je Tag. `/api/forecast/compact` ist für Widgets oder externe Tools gedacht. `/feed.xml` erzeugt einen RSS-Feed für einen Ort.

## Modellstatus

Die App archiviert Forecasts, bewertet abgelaufene Tage gegen DWD-Istwerte und lernt daraus die Blend-Gewichte pro Station. Wenn noch zu wenige verifizierte Fälle vorliegen, nutzt sie konservative Startgewichte und markiert den Status als Lernphase.

Die Kalibrierung folgt einer MOS/EMOS-artigen Idee: Temperatur wird über Fehlermaße wie MAE gelernt, Regenwahrscheinlichkeit über Brier Score. So wird aus dem Startmodell schrittweise ein lokal trainiertes Modell statt einer festen Daumenregel.

## Lernpfad

Die Startseite zeigt standardmäßig Berlin, Muenchen, Nuernberg, Hamburg und Coburg als Trainingsstädte. Die Liste liegt in `.weather_cache/learning_cities.json` und kann über die UI oder die `/api/learning/add`-/`remove`-Endpunkte geändert werden.

Solange der Server läuft, zieht ein Hintergrundlauf die Lernstädte einmal beim Start und danach alle 24 Stunden. Jeder Tageslauf legt pro Stadt höchstens einen Forecast-Snapshot im Archiv ab. Sobald der Zieltag in den DWD-Istwerten vorhanden ist, wird dieser Snapshot fürs Training der Blend-Gewichte verwendet.

## Begriffe

`likely` ist der wahrscheinlich angepasste Forecast. OpenWeather und Open-Meteo bilden zuerst einen Modellkonsens; dieser wird mit dem lokalen DWD-Muster korrigiert.

`DWD-Korridor` meint das 10. bis 90. Perzentil der historischen DWD-Tagesmitteltemperaturen rund um den Zielkalendertag. Er ist kein Modellforecast, sondern der lokale Klimarahmen für diesen Tag.

`confidence` ist ein Qualitäts-/Vertrauensscore für die Anpassung. Er steigt, wenn OpenWeather, Open-Meteo und DWD-Muster gut zusammenpassen, viele historische Vergleichstage vorliegen und der Forecast-Horizont kurz ist. Er sinkt bei Modell-Dissens. Er ist nicht die Eintrittswahrscheinlichkeit des Wetters.

`rain_signal` trennt Regenwahrscheinlichkeit, erwartete Menge, Modell-Dissens und Stundenfenster. Ein hoher Regen-Index heißt: Regen ist nicht nur möglich, sondern nach Menge/Zeitfenster praktisch relevanter.

`calibration` ist der Backtest-Status aus dem lokalen Forecast-Archiv. Direkt nach dem Start steht er auf `learning`; nach abgelaufenen Tagen wird er zu einer echten Trefferbewertung gegen DWD-Istwerte.

Der Wetterbrief oberhalb der Tageskarten verdichtet den Forecast auf Kurzfazit, wichtigste Risiken, konkrete Maßnahmen und die schwächste Confidence-Stelle im Zeitraum.
