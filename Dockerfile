FROM python:3.12-slim

WORKDIR /app

COPY forecast_engine.py server.py ./
COPY static/ static/

RUN mkdir -p /app/.weather_cache && chmod 777 /app/.weather_cache

ENV PYTHONUNBUFFERED=1
ENV HOST=0.0.0.0
ENV PORT=8765

EXPOSE 8765

CMD ["python3", "server.py"]
