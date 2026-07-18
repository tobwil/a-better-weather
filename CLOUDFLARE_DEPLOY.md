# Cloudflare Deploy

Der `kisruptiv`-Branch ist auf Cloudflare-first ausgelegt: statisches Frontend, API, Cron-Training und persistente Lerndaten laufen in einem kostenlosen Cloudflare-Setup.

## Architektur

- Cloudflare Worker serviert das Frontend aus `static/`.
- Derselbe Worker beantwortet `/api/*` und `/feed.xml`.
- Cloudflare D1 speichert Lernstaedte, Forecast-Snapshots, verifizierte Istwerte, Modellmetriken und API-Cache.
- Cron Triggers ziehen taeglich Forecasts fuer Berlin, Muenchen, Hamburg, Coburg und Nutzerstaedte.
- OpenWeather und Open-Meteo liefern aktuelle und prognostizierte Modellwerte.
- DWD Open Data liefert Stationen und historische/recent Tageswerte fuer Klimakorridor und Verifizierung.

## Einmaliges Setup

1. Dependencies installieren:

```bash
npm install
```

2. Bei Cloudflare anmelden:

```bash
npx wrangler login
```

3. D1-Datenbank erstellen:

```bash
npx wrangler d1 create a_better_weather
```

Cloudflare gibt danach eine `database_id` aus. Diese ID in `wrangler.toml` bei `database_id` eintragen.

4. Schema remote anlegen:

```bash
npx wrangler d1 migrations apply a_better_weather --remote
```

5. OpenWeather-Key als Secret setzen:

```bash
npx wrangler secret put OPENWEATHER_API_KEY
```

Optional fuer manuellen Trainings-Endpoint:

```bash
npx wrangler secret put TRAINING_SECRET
```

6. Deploy:

```bash
npm run deploy
```

Danach gibt Cloudflare eine Worker-URL aus. Diese URL ist Frontend und API zugleich.

## Endpunkte

```text
GET /
GET /api/forecast?city=Coburg
GET /api/forecast/compact?city=Coburg
GET /api/stations?city=Coburg
GET /api/learning
GET /api/learning/dashboard
GET /api/learning/add?city=Kassel
GET /api/learning/remove?city=Kassel
GET /api/train/daily?secret=...
GET /feed.xml?city=Coburg
GET /health
```

## Lernen

Das Lernen funktioniert kostenlos, weil die Daten nicht im kurzlebigen Worker-Dateisystem liegen, sondern in D1.

Der Worker speichert pro Stadt und Zieltag einen Forecast-Snapshot. Sobald der Zieltag in den DWD-Tageswerten verfuegbar ist, verifiziert der Trainingslauf den Snapshot gegen den DWD-Istwert. Daraus werden Temperaturfehler und Regen-Brier-Score berechnet und pro DWD-Station als Gewichtung gespeichert.

Bis mindestens 18 verifizierte Faelle pro Station vorliegen, nutzt die App konservative Startgewichte. Danach greift der gelernte Gewichtssatz aus `model_metrics`.

## Cron

`wrangler.toml` enthaelt zwei Cron-Zeiten:

```toml
[triggers]
crons = ["12 5 * * *", "22 19 * * *"]
```

Cloudflare fuehrt damit morgens und abends automatisch den Trainingslauf aus.

## Warum nicht Render/Netlify?

Render Free kann fuer eine Demo funktionieren, aber lokales Dateisystem und schlafende Webservices sind fuer dauerhaftes Lernen die falsche Grundlage. Cloudflare Workers + D1 loest genau das: persistente Datenbank, geplante Jobs und API in einem kostenlosen Setup.
