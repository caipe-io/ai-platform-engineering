FROM python:3.14-slim
WORKDIR /app
RUN groupadd -g 1001 appuser && useradd -u 1001 -g 1001 -M -s /usr/sbin/nologin appuser
RUN pip install --no-cache-dir httpx==0.28.1
COPY deploy/openfga/init/seed.py .
COPY charts/ai-platform-engineering/charts/openfga/files/publish_model.py .
COPY charts/ai-platform-engineering/charts/openfga/authorization-model.json /app/core-authorization-model.json
USER 1001:1001
ENTRYPOINT ["python", "/app/seed.py"]
