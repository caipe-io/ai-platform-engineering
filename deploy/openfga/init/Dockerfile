FROM python:3.14-slim
WORKDIR /app
RUN groupadd -g 1001 appuser && useradd -u 1001 -g 1001 -M -s /usr/sbin/nologin appuser
RUN pip install --no-cache-dir httpx==0.28.1
COPY seed.py .
USER 1001:1001
ENTRYPOINT ["python", "/app/seed.py"]
