const form = document.querySelector("#forecast-form");
const cityInput = document.querySelector("#city-input");
const learningForm = document.querySelector("#learning-form");
const learningCityInput = document.querySelector("#learning-city-input");
const learningCards = document.querySelector("#learning-cards");
const daysEl = document.querySelector("#days");
const chart = document.querySelector("#forecast-chart");
const ctx = chart.getContext("2d");

const briefEl = document.querySelector("#forecast-brief");
const currentBand = document.querySelector("#current-band");
const summaryBand = document.querySelector("#summary-band");
const calibrationBand = document.querySelector("#calibration-band");
const chartSection = document.querySelector("#chart-section");
const comparisonSection = document.querySelector("#comparison-section");
const hourlySection = document.querySelector("#hourly-section");
const methodNote = document.querySelector("#method-note");
const viewTabs = document.querySelector("#view-tabs");
const nerdSection = document.querySelector("#nerd-section");
const nerdLinks = document.querySelector("#nerd-links");
const nerdDays = document.querySelector("#nerd-days");
const methodologyWarning = document.querySelector("#methodology-warning");
const briefHeadline = document.querySelector("#brief-headline");
const briefDetail = document.querySelector("#brief-detail");
const briefActions = document.querySelector("#brief-actions");
const briefWatch = document.querySelector("#brief-watch");
const currentTemp = document.querySelector("#current-temp");
const currentDescription = document.querySelector("#current-description");
const currentOpenWeather = document.querySelector("#current-openweather");
const currentOpenWeatherMeta = document.querySelector("#current-openweather-meta");
const currentOpenMeteo = document.querySelector("#current-openmeteo");
const currentOpenMeteoMeta = document.querySelector("#current-openmeteo-meta");
const currentGap = document.querySelector("#current-gap");
const currentNote = document.querySelector("#current-note");
const locationLabel = document.querySelector("#location-label");
const stationLabel = document.querySelector("#station-label");
const distanceLabel = document.querySelector("#distance-label");
const sourceLabel = document.querySelector("#source-label");
const calibrationTitle = document.querySelector("#calibration-title");
const calibrationDetail = document.querySelector("#calibration-detail");
const calibrationProgress = document.querySelector("#calibration-progress");
const comparisonBody = document.querySelector("#comparison-body");
const hourlyList = document.querySelector("#hourly-list");
let lastDays = [];
let currentPayload = null;
let currentView = "overview";

window.addEventListener("resize", () => {
  if (lastDays.length) {
    renderChart(lastDays);
  }
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const city = cityInput.value.trim();
  if (!city) {
    showIdle("Bitte gib zuerst einen Ort ein.");
    cityInput.focus();
    return;
  }
  loadForecast(city);
});

learningForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const city = learningCityInput.value.trim();
  if (!city) return;
  await fetch(`/api/learning/add?city=${encodeURIComponent(city)}`);
  learningCityInput.value = "";
  loadLearningDashboard();
});

learningCards.addEventListener("click", async (event) => {
  const openButton = event.target.closest("[data-open-city]");
  const removeButton = event.target.closest("[data-remove-city]");
  if (openButton) {
    cityInput.value = openButton.dataset.openCity;
    loadForecast(openButton.dataset.openCity);
  }
  if (removeButton) {
    await fetch(`/api/learning/remove?city=${encodeURIComponent(removeButton.dataset.removeCity)}`);
    loadLearningDashboard();
  }
});

viewTabs.addEventListener("click", (event) => {
  const button = event.target.closest("[data-view]");
  if (!button) return;
  setActiveView(button.dataset.view);
});

showIdle("Ort eingeben und Wetter prüfen.");
loadLearningDashboard();

async function loadForecast(city) {
  const button = form.querySelector("button");
  button.disabled = true;
  briefEl.classList.add("is-hidden");
  currentBand.classList.add("is-hidden");
  summaryBand.classList.add("is-hidden");
  calibrationBand.classList.add("is-hidden");
  chartSection.classList.add("is-hidden");
  comparisonSection.classList.add("is-hidden");
  hourlySection.classList.add("is-hidden");
  methodNote.classList.add("is-hidden");
  viewTabs.classList.add("is-hidden");
  nerdSection.classList.add("is-hidden");
  daysEl.classList.remove("is-hidden");
  daysEl.innerHTML = `<div class="loading">DWD-Station und Forecast werden geladen...</div>`;
  try {
    const response = await fetch(`/api/forecast?city=${encodeURIComponent(city)}`);
    const payload = await response.json();
    if (!response.ok || payload.error) {
      throw new Error(payload.error || "Forecast konnte nicht geladen werden");
    }
    renderOverview(payload.overview);
    renderCurrent(payload.current);
    renderSummary(payload);
    renderCalibration(payload.calibration, payload.location?.label);
    renderComparison(payload.days, payload.current);
    renderHourly(payload.hourly || []);
    renderNerd(payload);
    renderDays(payload.days, payload.current);
    lastDays = payload.days;
    currentPayload = payload;
    briefEl.classList.remove("is-hidden");
    currentBand.classList.remove("is-hidden");
    summaryBand.classList.remove("is-hidden");
    calibrationBand.classList.remove("is-hidden");
    viewTabs.classList.remove("is-hidden");
    setActiveView("overview");
    renderChart(payload.days);
  } catch (error) {
    daysEl.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
  } finally {
    button.disabled = false;
  }
}

function showIdle(message) {
  lastDays = [];
  briefEl.classList.add("is-hidden");
  currentBand.classList.add("is-hidden");
  summaryBand.classList.add("is-hidden");
  calibrationBand.classList.add("is-hidden");
  chartSection.classList.add("is-hidden");
  comparisonSection.classList.add("is-hidden");
  hourlySection.classList.add("is-hidden");
  methodNote.classList.add("is-hidden");
  viewTabs.classList.add("is-hidden");
  nerdSection.classList.add("is-hidden");
  daysEl.classList.remove("is-hidden");
  daysEl.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
}

async function loadLearningDashboard() {
  learningCards.innerHTML = `<div class="loading">Lernstädte werden geladen...</div>`;
  try {
    const response = await fetch("/api/learning/cards");
    const payload = await readJsonResponse(response, "Lernpfad konnte nicht geladen werden");
    if (!response.ok || payload.error) {
      throw new Error(payload.error || "Lernpfad konnte nicht geladen werden");
    }
    renderLearningDashboard(payload);
  } catch (error) {
    learningCards.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
  }
}

function renderLearningDashboard(payload) {
  const cards = payload.cards || [];
  const errors = payload.errors || [];
  learningCards.innerHTML = [
    ...cards.map(renderLearningCard),
    ...errors.map((item) => `
      <article class="learning-card error-card">
        <p class="date">${escapeHtml(item.city)}</p>
        <strong>Fehler</strong>
        <span>${escapeHtml(item.error)}</span>
        <button type="button" class="ghost-button" data-remove-city="${escapeHtml(item.city)}">Entfernen</button>
      </article>
    `),
  ].join("") || `<div class="empty-state">Noch keine Lernstädte ausgewählt.</div>`;
}

async function readJsonResponse(response, fallbackMessage) {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (!contentType.includes("application/json")) {
    throw new Error(`${fallbackMessage}: Cloudflare lieferte keine JSON-Antwort (${response.status}). Bitte neu laden.`);
  }
  try {
    return JSON.parse(text);
  } catch (_error) {
    throw new Error(`${fallbackMessage}: Antwort konnte nicht gelesen werden.`);
  }
}

function renderLearningCard(card) {
  const today = card.today || {};
  const now = card.current?.best || {};
  const observedAt = card.current?.openweather?.observed_at || card.current?.open_meteo?.observed_at;
  const insight = learningCardInsight(card);
  const confidence = today.confidence ?? 0;
  const confidenceClass = confidence >= 78 ? "high" : confidence >= 58 ? "medium" : "low";
  const hasCurrent = Number.isFinite(now.temperature_c);
  return `
    <article class="learning-card">
      <div class="learning-card-top">
        <div>
          <p class="date">${escapeHtml(card.location?.label || card.city)}</p>
          <strong>${escapeHtml(now.description || today.condition || "-")}</strong>
        </div>
        <span class="badge ${confidenceClass}">${today.confidence ?? "-"}%</span>
      </div>
      ${hasCurrent ? `
        <div class="learning-current">
          <span>Aktuelle Temperatur</span>
          <strong>${formatTemp(now.temperature_c)}</strong>
          <em>${escapeHtml(now.source || "Jetzt-Wert")}${formatTime(observedAt) ? ` · ${formatTime(observedAt)}` : ""}</em>
        </div>
      ` : `
        <div class="learning-current missing">
          <span>Aktuelle Temperatur</span>
          <strong>-</strong>
          <em>kein Current-Wert verfügbar</em>
        </div>
      `}
      <div class="learning-mini">
        <span>Heute tagsüber</span><strong>${formatTemp(today.temperature_c)}</strong>
        <span>Heute Spanne</span><strong>${formatTemp(today.temperature_min_c)} bis ${formatTemp(today.temperature_max_c)}</strong>
        <span>Regen</span><strong>${Math.round((today.rain_probability || 0) * 100)}%</strong>
        <span>Index</span><strong>${today.rain_index ?? "-"} / 100</strong>
        <span>Confidence</span><strong>${today.confidence ?? "-"}%</strong>
        <span>Signal</span><strong>${escapeHtml(today.rain_level || "unauffällig")}</strong>
      </div>
      <p>${escapeHtml(insight)}</p>
      <div class="learning-actions">
        <button type="button" data-open-city="${escapeHtml(card.city)}">Öffnen</button>
        <button type="button" class="ghost-button" data-remove-city="${escapeHtml(card.city)}">Aus Lernpfad entfernen</button>
      </div>
    </article>
  `;
}

function learningCardInsight(card) {
  const today = card.today || {};
  const now = card.current?.best || {};
  const currentTemp = now.temperature_c;
  const forecastTemp = today.temperature_c;
  const rain = today.rain_probability || 0;
  const confidence = today.confidence || 0;
  if (Number.isFinite(currentTemp) && Number.isFinite(forecastTemp)) {
    const gap = currentTemp - forecastTemp;
    if (Math.abs(gap) >= 2.5) {
      return `Jetzt ${formatTemp(currentTemp)}, tagsüber eher um ${formatTemp(forecastTemp)}. Das heißt: Die Kachel zeigt oben den echten Momentanwert, darunter die Erwartung für den weiteren Tag.`;
    }
  }
  if (rain >= 0.55) {
    return `${Math.round(rain * 100)}% Regenrisiko für den weiteren Tag. Öffnen zeigt, wann die nasseste Phase erwartet wird.`;
  }
  if (rain <= 0.2) {
    return `Heute kaum Regensignal. Interessanter ist, wie stark die Temperatur im Tagesverlauf noch steigt oder fällt.`;
  }
  if (confidence < 60) {
    return `Heute sind die Modelle weniger einig. Öffnen zeigt, ob Temperatur, Regen oder lokale DWD-Historie den Forecast unsicher machen.`;
  }
  return `Momentanwert und Tagesausblick passen gut zusammen. Öffnen zeigt OpenWeather, Open-Meteo und DWD-Vergleich im Detail.`;
}

function setActiveView(view) {
  currentView = view === "nerd" ? "nerd" : "overview";
  viewTabs.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === currentView);
  });
  const overviewVisible = currentView === "overview";
  chartSection.classList.toggle("is-hidden", !overviewVisible);
  comparisonSection.classList.toggle("is-hidden", !overviewVisible);
  hourlySection.classList.toggle("is-hidden", !overviewVisible);
  methodNote.classList.toggle("is-hidden", !overviewVisible);
  daysEl.classList.toggle("is-hidden", !overviewVisible);
  nerdSection.classList.toggle("is-hidden", overviewVisible);
  if (overviewVisible && lastDays.length) {
    renderChart(lastDays);
  }
}

function renderOverview(overview) {
  briefHeadline.textContent = overview?.headline || "Forecast bereit.";
  briefDetail.textContent = [overview?.detail, overview?.station_note].filter(Boolean).join(" ");
  briefActions.innerHTML = renderList(overview?.actions || []);
  briefWatch.innerHTML = renderList(overview?.watch || []);
}

function renderCurrent(current) {
  const best = current?.best || {};
  const owm = current?.openweather || {};
  const om = current?.open_meteo || {};
  currentTemp.textContent = formatTemp(best.temperature_c);
  currentDescription.textContent = `${best.source || "Jetzt-Wert"} · ${best.confidence || "unbekannt"} plausibel · ${best.description || "-"}`;
  currentOpenWeather.textContent = formatTemp(owm.temperature_c);
  currentOpenWeatherMeta.textContent = [
    owm.description,
    Number.isFinite(owm.feels_like_c) ? `gefühlt ${formatTemp(owm.feels_like_c)}` : "",
    formatTime(owm.observed_at),
  ].filter(Boolean).join(" · ") || "-";
  currentOpenMeteo.textContent = formatTemp(om.temperature_c);
  currentOpenMeteoMeta.textContent = [
    om.description,
    Number.isFinite(om.wind_mps) ? formatWind(om.wind_mps) : "",
    formatTime(om.observed_at),
  ].filter(Boolean).join(" · ") || "-";
  currentGap.textContent = Number.isFinite(current?.temperature_gap_c)
    ? `${current.temperature_gap_c.toFixed(1)}° Differenz`
    : "keine Differenz berechnet";
  currentNote.textContent = current?.explanation || current?.note || "Jetzt-Wert ist kein Tagesmittel.";
}

function renderSummary(payload) {
  locationLabel.textContent = payload.location.label;
  stationLabel.textContent = `${payload.station.name} (${payload.station.id})`;
  distanceLabel.textContent = `${payload.station.distance_km} km`;
  sourceLabel.textContent = "OpenWeather + Open-Meteo + DWD";
}

function renderCalibration(calibration, cityLabel = "Ort") {
  if (!calibration) {
    calibrationTitle.textContent = `${cityLabel}: 0/18 verifizierte Fälle`;
    calibrationDetail.textContent = "Noch kein Lernstatus verfügbar.";
    calibrationProgress.style.width = "0%";
    return;
  }
  const verified = calibration.evaluated_days ?? 0;
  const required = calibration.required_cases ?? 18;
  const progress = Math.max(0, Math.min(100, (verified / required) * 100));
  calibrationTitle.textContent = `${cityLabel}: ${verified}/${required} verifizierte Fälle`;
  calibrationProgress.style.width = `${progress}%`;
  calibrationDetail.textContent = calibration.weights_active
    ? "Gelernte lokale Gewichte sind aktiv und werden mit jedem Trainingslauf nachgeschärft."
    : `${calibration.next_check || "Nächster Check nach DWD-Istwert."} Gelernte Gewichte noch nicht aktiv.`;
}

function renderComparison(days, current) {
  comparisonBody.innerHTML = days.map((day, index) => {
    const likely = day.likely || day.challenged;
    return `
      <tr>
        <th>${formatDate(day.date)}</th>
        <td>${formatForecastCell(day.openweather)}</td>
        <td>${formatForecastCell(day.open_meteo)}</td>
        <td>${formatForecastCell(day.model_consensus)}</td>
        <td>${formatDwdCell(day.pattern)}</td>
        <td>${formatLikelyCell(day, current, index)}</td>
        <td><strong>${escapeHtml(day.rain_signal?.level || "-")}</strong><span>${day.rain_signal?.score ?? "-"} / 100 · ${escapeHtml(day.rain_signal?.timing?.wet_window || "")}</span></td>
      </tr>
    `;
  }).join("");
}

function renderHourly(slots) {
  hourlyList.innerHTML = slots.slice(0, 24).map((slot) => {
    const time = new Date(slot.time).toLocaleString("de-DE", { weekday: "short", hour: "2-digit", minute: "2-digit" });
    const rain = Math.round((slot.likely?.rain_probability || 0) * 100);
    return `
      <div class="hour-pill">
        <span>${time}</span>
        <strong>${formatTemp(slot.likely?.t)}</strong>
        <em>${rain}% · ${formatWind(slot.likely?.wind)}</em>
      </div>
    `;
  }).join("");
}

function renderNerd(payload) {
  const city = encodeURIComponent(payload.location.label);
  const learning = payload.source?.learning || {};
  const weights = learning.weights || {};
  methodologyWarning.innerHTML = `
    <strong>Lernmodell aktiv:</strong> ${escapeHtml(learning.summary || "Die App vergleicht gespeicherte Vorhersagen mit späteren offiziellen Tageswerten und passt die Gewichte lokal an.")}
    Aktive Gewichte: Temperatur ${formatNumber(weights.temp_model)}, Regen-Wahrscheinlichkeit ${formatNumber(weights.rain_probability_model)}, Regenmenge ${formatNumber(weights.rain_amount_model)}.
  `;
  nerdLinks.innerHTML = `
    <a href="/api/forecast?city=${city}" target="_blank" rel="noreferrer">Vollständige JSON-API</a>
    <a href="/api/forecast/compact?city=${city}" target="_blank" rel="noreferrer">Kompakte JSON-API</a>
    <a href="/feed.xml?city=${city}" target="_blank" rel="noreferrer">RSS-Feed</a>
  `;
  nerdDays.innerHTML = payload.days.map((day) => renderNerdDay(day)).join("");
}

function renderNerdDay(day) {
  const math = day.math || {};
  const temp = math.temperature || {};
  const rain = math.rain || {};
  const confidence = math.confidence || {};
  const likely = day.likely || {};
  return `
    <article class="nerd-card">
      <div class="nerd-card-top">
        <div>
          <p class="date">${formatDate(day.date)}</p>
          <h3>${escapeHtml(likely.condition || "Forecast")}: ${formatTemp(likely.t_mean)}, ${Math.round((likely.rain_probability || 0) * 100)}% Regen</h3>
        </div>
        <span class="badge ${likely.confidence >= 78 ? "high" : likely.confidence >= 58 ? "medium" : "low"}">${likely.confidence}%</span>
      </div>

      <div class="formula-grid">
        <section>
          <span class="metric-label">Temperatur</span>
          <code>${escapeHtml(temp.formula || "-")}</code>
          <p class="formula-note">${escapeHtml(temp.weight_note || "")}</p>
          ${renderEquationRows([
            ["OpenWeather", formatTemp(temp.openweather_c)],
            ["Open-Meteo", formatTemp(temp.open_meteo_c)],
            ["Modell-Mittel", formatTemp(temp.model_mean_c)],
            ["DWD-Mittel", formatTemp(temp.dwd_historical_mean_c)],
            ["14-Tage-Anomalie", formatSigned(temp.recent_anomaly_c, "°C")],
            ["Anomalie-Gewicht", formatNumber(temp.recent_weight)],
            ["DWD-Muster angepasst", formatTemp(temp.dwd_adjusted_pattern_c)],
            ["Gewichtung", `${pct(temp.model_weight)} Modell / ${pct(temp.dwd_weight)} DWD`],
            ["Ergebnis", formatTemp(temp.likely_c)],
          ])}
        </section>

        <section>
          <span class="metric-label">Regen</span>
          <code>${escapeHtml(rain.formula || "-")}</code>
          <p class="formula-note">${escapeHtml(rain.weight_note || "")}</p>
          ${renderEquationRows([
            ["OW / OM Wahrscheinlichkeit", `${pct(rain.openweather_probability)} / ${pct(rain.open_meteo_probability)}`],
            ["Modell-Wahrscheinlichkeit", pct(rain.model_probability)],
            ["DWD-Wahrscheinlichkeit", pct(rain.dwd_probability)],
            ["Forecast-Wahrscheinlichkeit", pct(rain.likely_probability)],
            ["OW / OM Menge", `${formatRainAmount(rain.openweather_mm)} / ${formatRainAmount(rain.open_meteo_mm)}`],
            ["DWD erwartet", formatRainAmount(rain.dwd_expected_mm)],
            ["DWD falls Regentag", formatRainAmount(rain.dwd_if_wet_mm)],
            ["Forecast-Menge", formatRainAmount(rain.likely_mm)],
            ["Regen-Index", `${rain.score ?? "-"} / 100`],
          ])}
        </section>

        <section>
          <span class="metric-label">Confidence</span>
          <code>${escapeHtml(confidence.formula || "-")}</code>
          <p class="formula-note">${escapeHtml(confidence.weight_note || "")}</p>
          ${renderEquationRows([
            ["Gesamt", `${confidence.overall ?? "-"} / 100`],
            ["Modelle", componentValue(confidence, "model_agreement")],
            ["DWD-Fit", componentValue(confidence, "climate_fit")],
            ["Regen-Fit", componentValue(confidence, "rain_fit")],
            ["Daten", componentValue(confidence, "data_depth")],
            ["Horizont", componentValue(confidence, "horizon")],
            ["Temp-Abstand zu DWD", formatSigned(confidence.temperature_gap_c, "°C")],
            ["Regen-Abstand zu DWD", formatSignedPercent(confidence.dwd_rain_gap_points)],
            ["Modell-Temp-Dissens", formatSigned(confidence.model_temperature_gap_c, "°C")],
            ["Modell-Regen-Dissens", formatSignedPercent(confidence.model_rain_gap_points)],
            ["Historische Stichprobe", confidence.sample_size ?? "-"],
          ])}
        </section>
      </div>
    </article>
  `;
}

function renderEquationRows(rows) {
  return `<dl class="equation-list">${rows.map(([label, value]) => `
    <div>
      <dt>${escapeHtml(label)}</dt>
      <dd>${escapeHtml(value)}</dd>
    </div>
  `).join("")}</dl>`;
}

function renderDays(days, current) {
  daysEl.innerHTML = days.map((day, index) => {
    const likely = day.likely || day.challenged;
    const display = primaryDayDisplay(day, current, index);
    const confidenceClass = likely.confidence >= 78 ? "high" : likely.confidence >= 58 ? "medium" : "low";
    const date = new Date(`${day.date}T12:00:00Z`);
    const dateLabel = date.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" });
    const isToday = index === 0 && Number.isFinite(current?.best?.temperature_c);
    return `
      <article class="day-card ${isToday ? "is-today-current" : ""}">
        <div class="day-top">
          <div>
            <p class="date">${dateLabel}</p>
            <p class="value-kind">${escapeHtml(display.label)}</p>
            <p class="temp">${formatTemp(display.temperature)}</p>
            <p class="condition">${escapeHtml(display.condition)}</p>
          </div>
          <span class="badge ${confidenceClass}" title="${escapeHtml(confidenceTitle(day))}">${likely.confidence}%</span>
        </div>
        ${isToday ? `
          <div class="today-forecast-note">
            <span>Forecast heute</span>
            <strong>Rest des Tages: ${formatTemp(likely.t_mean)} im Mittel, bis ${formatTemp(likely.t_max)}, ${Math.round((likely.rain_probability || 0) * 100)}% Regen</strong>
          </div>
        ` : ""}
        <div class="mini-grid">
          <div class="mini"><span>${isToday ? "Rest heute Mittel" : "Tagesmittel"}</span><strong>${formatTemp(likely.t_mean)}</strong></div>
          <div class="mini"><span>Spanne</span><strong>${formatTemp(likely.t_min)} bis ${formatTemp(likely.t_max)}</strong></div>
          <div class="mini"><span>OpenWeather Forecast</span><strong>${formatTemp(day.openweather.t_mean)}</strong></div>
          <div class="mini"><span>Open-Meteo Forecast</span><strong>${formatModel(day.open_meteo)}</strong></div>
          <div class="mini"><span title="Mittelwert aus OpenWeather und Open-Meteo vor DWD-Korrektur">Modell-Mittel</span><strong>${formatTemp(day.model_consensus?.t_mean)}</strong></div>
          <div class="mini"><span>DWD-Korridor</span><strong>${formatTemp(day.pattern.t_low)} bis ${formatTemp(day.pattern.t_high)}</strong></div>
          <div class="mini"><span>Regen</span><strong>${Math.round(likely.rain_probability * 100)}%</strong></div>
          <div class="mini"><span>Regen-Index</span><strong>${day.rain_signal?.score ?? "-"} / 100</strong></div>
          <div class="mini"><span>Wind</span><strong>${formatWind(likely.wind_mean)}</strong></div>
          <div class="mini"><span>Temp-Shift</span><strong>${formatSigned(likely.temperature_adjustment_c, "°C")}</strong></div>
          <div class="mini"><span>Regen-Shift</span><strong>${formatSignedPercent(likely.rain_adjustment_points)}</strong></div>
          <div class="mini"><span>Regenfenster</span><strong>${escapeHtml(likely.rain_timing?.wet_window || "-")}</strong></div>
        </div>
        <div class="confidence-split">${renderConfidenceSplit(day.confidence?.components)}</div>
        <div class="chips">${renderChips([...(likely.risk || []), ...(likely.advice || [])])}</div>
        <p class="signal">${escapeHtml(day.rain_signal?.interpretation || "")}</p>
        <p class="signal">${escapeHtml(day.explanation?.summary || day.signal)}</p>
        <p class="confidence-note">${escapeHtml(day.explanation?.confidence || confidenceTitle(day))}</p>
      </article>
    `;
  }).join("");
}

function primaryDayDisplay(day, current, index) {
  const likely = day.likely || day.challenged || {};
  const best = current?.best || {};
  if (index === 0 && Number.isFinite(best.temperature_c)) {
    const observedAt = current?.openweather?.observed_at || current?.open_meteo?.observed_at;
    const time = formatTime(observedAt);
    return {
      label: time ? `Aktuelle Temperatur · ${time}` : "Aktuelle Temperatur",
      temperature: best.temperature_c,
      condition: `Realwert jetzt · ${best.source || "Current"} · ${best.description || likely.condition || "-"}`,
    };
  }
  return {
    label: "Forecast-Tagesmittel",
    temperature: likely.t_mean,
    condition: likely.condition || day.openweather?.description || "-",
  };
}

function formatLikelyCell(day, current, index) {
  const likely = day.likely || day.challenged || {};
  if (index === 0 && Number.isFinite(current?.best?.temperature_c)) {
    const observedAt = current?.openweather?.observed_at || current?.open_meteo?.observed_at;
    const time = formatTime(observedAt);
    const nowLabel = time ? `Jetzt ${formatTemp(current.best.temperature_c)} um ${time}` : `Jetzt ${formatTemp(current.best.temperature_c)}`;
    return `<strong>${formatTemp(likely.t_min)} bis ${formatTemp(likely.t_max)}</strong><span>Heute Forecast: Mittel ${formatTemp(likely.t_mean)} · ${Math.round((likely.rain_probability || 0) * 100)}% Regen</span><span>${escapeHtml(nowLabel)} · Momentanwert, nicht Tagesforecast</span>`;
  }
  return `<strong>${formatTemp(likely.t_mean)}</strong><span>${Math.round((likely.rain_probability || 0) * 100)}% Regen, ${formatWind(likely.wind_mean)}</span>`;
}

function renderChart(days) {
  const bounds = chart.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const cssWidth = Math.max(640, Math.round(bounds.width));
  const cssHeight = Math.max(300, Math.round(cssWidth * 0.28));
  chart.width = Math.round(cssWidth * ratio);
  chart.height = Math.round(cssHeight * ratio);
  chart.style.height = `${cssHeight}px`;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const width = cssWidth;
  const height = cssHeight;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  const temps = days.flatMap((day) => [
    day.openweather.t_mean,
    day.open_meteo?.t_mean,
    (day.likely || day.challenged).t_mean,
    day.pattern.t_low,
    day.pattern.t_high,
  ]).filter((value) => Number.isFinite(value));
  const min = Math.floor(Math.min(...temps) - 2);
  const max = Math.ceil(Math.max(...temps) + 2);
  const padding = { left: 54, right: 28, top: 58, bottom: 44 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  ctx.strokeStyle = "#d7e0df";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#60717a";
  ctx.font = "13px system-ui";
  for (let i = 0; i <= 4; i += 1) {
    const value = min + ((max - min) * i) / 4;
    const y = yFor(value);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    ctx.fillText(`${Math.round(value)}°`, 12, y + 4);
  }

  const bandTop = days.map((day, index) => point(index, day.pattern.t_high));
  const bandBottom = days.map((day, index) => point(index, day.pattern.t_low)).reverse();
  ctx.beginPath();
  [...bandTop, ...bandBottom].forEach(([x, y], index) => {
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = "rgba(15, 118, 110, 0.14)";
  ctx.fill();

  drawLine(days.map((day, index) => point(index, day.openweather.t_mean)), "#2563eb", "OpenWeather");
  drawLine(days.map((day, index) => point(index, day.open_meteo?.t_mean)), "#0891b2", "Open-Meteo", { dash: [7, 5] });
  drawLine(days.map((day, index) => point(index, (day.likely || day.challenged).t_mean)), "#c2410c", "Wahrscheinlicher Forecast");

  ctx.fillStyle = "#1d2529";
  ctx.font = "700 13px system-ui";
  days.forEach((day, index) => {
    const [x] = point(index, min);
    const label = new Date(`${day.date}T12:00:00Z`).toLocaleDateString("de-DE", { weekday: "short" });
    ctx.fillText(label, x - 12, height - 17);
  });

  drawLegend(width);

  function point(index, value) {
    const x = padding.left + (days.length === 1 ? plotW / 2 : (plotW * index) / (days.length - 1));
    return [x, yFor(value)];
  }

  function yFor(value) {
    return padding.top + plotH - ((value - min) / (max - min || 1)) * plotH;
  }
}

function renderList(items) {
  if (!items.length) return "<li>-</li>";
  return items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
}

function renderChips(items) {
  const unique = [...new Set(items)].slice(0, 5);
  if (!unique.length) return `<span class="chip quiet">unauffällig</span>`;
  return unique.map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("");
}

function renderConfidenceSplit(components) {
  if (!components) return "";
  const items = [
    ["Modelle", components.model_agreement, "Einigkeit zwischen OpenWeather und Open-Meteo"],
    ["DWD-Fit", components.climate_fit, "Passt der Modellwert zum lokalen historischen DWD-Korridor?"],
    ["Regen", components.rain_fit, "Passen Modellregen und DWD-Regenrisiko zusammen?"],
    ["Daten", components.data_depth, "Wie viele historische DWD-Vergleichstage stehen dahinter?"],
    ["Horizont", components.horizon, "Wie nah liegt der Vorhersagetag? Heute ist sicherer als Tag 5."],
  ];
  return items.map(([label, value, explanation]) => `
    <div class="confidence-part" title="${escapeHtml(explanation)}">
      <span>${escapeHtml(label)}</span>
      <div><i style="width:${Math.max(4, Math.min(100, value))}%"></i></div>
      <strong>${value}</strong>
    </div>
  `).join("");
}

function drawLine(points, color, label = "", options = {}) {
  const cleanPoints = points.filter(([, y]) => Number.isFinite(y));
  if (!cleanPoints.length) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.setLineDash(options.dash || []);
  ctx.beginPath();
  cleanPoints.forEach(([x, y], index) => {
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  cleanPoints.forEach(([x, y]) => {
    ctx.beginPath();
    ctx.arc(x, y, label === "Open-Meteo" ? 3.5 : 4, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawLegend(width) {
  const items = [
    ["#2563eb", "OpenWeather", "solid"],
    ["#0891b2", "Open-Meteo", "dash"],
    ["#c2410c", "Wahrscheinlicher Forecast", "solid"],
    ["rgba(15, 118, 110, 0.45)", "DWD-Korridor", "solid"],
  ];
  let x = 62;
  let y = 20;
  items.forEach(([color, label, style]) => {
    const itemWidth = label.length * 7.5 + 78;
    if (x + itemWidth > width - 18) {
      x = 62;
      y += 22;
    }
    ctx.fillStyle = color;
    if (style === "dash") {
      ctx.strokeStyle = color;
      ctx.lineWidth = 4;
      ctx.setLineDash([8, 5]);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 22, y);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.fillRect(x, y - 2, 22, 4);
    }
    ctx.fillStyle = "#60717a";
    ctx.font = "700 13px system-ui";
    ctx.fillText(label, x + 30, y + 3);
    x += itemWidth;
  });
}

function formatTemp(value) {
  if (!Number.isFinite(value)) return "-";
  return `${value.toFixed(1)}°`;
}

function formatWind(value) {
  if (!Number.isFinite(value)) return "-";
  return `${value.toFixed(1)} m/s`;
}

function formatModel(model) {
  if (!model) return "-";
  return `${formatTemp(model.t_mean)} / ${Math.round((model.rain_probability || 0) * 100)}%`;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "-";
  return value.toFixed(2);
}

function pct(value) {
  if (!Number.isFinite(value)) return "-";
  return `${Math.round(value * 100)}%`;
}

function componentValue(confidence, key) {
  const value = confidence?.components?.[key];
  return Number.isFinite(value) ? `${value} / 100` : "-";
}

function formatForecastCell(model) {
  if (!model) return `<strong>-</strong><span>-</span>`;
  return `<strong>${formatTemp(model.t_mean)}</strong><span>${Math.round((model.rain_probability || 0) * 100)}% Regen · ${formatRainAmount(model.rain_mm)}</span>`;
}

function formatDwdCell(pattern) {
  if (!pattern) return `<strong>-</strong><span>-</span>`;
  return `<strong>${formatTemp(pattern.t_low)} bis ${formatTemp(pattern.t_high)}</strong><span>${Math.round((pattern.rain_probability || 0) * 100)}% historisches Risiko · ${formatRainAmount(pattern.rain_mm)} erwartet</span>`;
}

function formatRainAmount(value) {
  if (!Number.isFinite(value)) return "-";
  return `${value.toFixed(1)} mm`;
}

function formatDate(value) {
  return new Date(`${value}T12:00:00`).toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" });
}

function formatTime(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

function formatSigned(value, unit) {
  if (!Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}${unit}`;
}

function formatSignedPercent(value) {
  if (!Number.isFinite(value)) return "-";
  const points = Math.round(value * 100);
  const sign = points > 0 ? "+" : "";
  return `${sign}${points} Pp`;
}

function confidenceTitle(day) {
  if (!day.confidence) return "Confidence";
  return `DWD-Abstand: ${day.confidence.temperature_gap_c}°C, Regen-DWD-Abstand: ${Math.round(day.confidence.precipitation_gap_points * 100)} Pp, Modell-Dissens: ${day.confidence.model_temperature_gap_c}°C / ${Math.round((day.confidence.model_precipitation_gap_points || 0) * 100)} Pp, historische Stichprobe: ${day.confidence.historical_sample_size}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
