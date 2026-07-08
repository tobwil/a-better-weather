# Netlify Deploy

Diese Branch-Variante hostet das Frontend auf Netlify und leitet API-Aufrufe über eine Netlify Function an die Python-Wetter-API weiter.

## Architektur

- Netlify serviert `static/index.html`, `static/app.js` und `static/styles.css`.
- `/api/*` und `/feed.xml` werden per `netlify/functions/weather-proxy.mjs` an `WEATHER_BACKEND_URL` weitergereicht.
- Die produktive Wetterlogik bleibt in `server.py` und `forecast_engine.py`.

Warum Proxy statt komplette Netlify-Portierung: Die App nutzt DWD-Downloads, lokalen Cache, Forecast-Archiv und Lernstatus. Ein Netlify Function Runtime ist kurzlebig; für echtes Lernen brauchst du ein dauerhaftes Backend oder später Netlify Blobs/Database plus eine JS/TS-Portierung.

## Schritt fuer Schritt

1. Branch pushen:

```bash
git push -u origin kisruptiv
```

2. Python-Backend deployen.

Nutze zum Beispiel Render, Fly.io, Railway, einen VPS oder einen internen Server. Dort muss laufen:

```bash
export OPENWEATHER_API_KEY="dein-openweather-key"
python3 server.py
```

Das Backend muss von Netlify aus per HTTPS erreichbar sein, zum Beispiel:

```text
https://weather-api.example.com
```

3. Netlify-Projekt anlegen.

- In Netlify: `Add new site` -> `Import an existing project`.
- GitHub-Repo `tobwil/a-better-weather` verbinden.
- Branch: `kisruptiv`.
- Build command leer lassen.
- Publish directory: `static`.

`netlify.toml` setzt diese Werte ebenfalls, aber die UI sollte dazu passen.

4. Environment Variable setzen.

In Netlify unter `Site configuration` -> `Environment variables`:

```text
WEATHER_BACKEND_URL=https://weather-api.example.com
```

Kein Slash am Ende ist sauberer, die Function toleriert ihn aber.

5. Deploy ausloesen.

In Netlify `Deploys` -> `Trigger deploy` oder durch einen Push auf `kisruptiv`.

6. Funktion pruefen.

Nach dem Deploy diese URLs testen:

```text
https://deine-netlify-domain.netlify.app/
https://deine-netlify-domain.netlify.app/api/forecast/compact?city=Coburg
https://deine-netlify-domain.netlify.app/feed.xml?city=Coburg
```

Wenn du bei `/api/...` `WEATHER_BACKEND_URL fehlt` siehst, fehlt die Netlify-Environment-Variable. Wenn du `OPENWEATHER_API_KEY fehlt` siehst, fehlt der Key auf dem Python-Backend.
