# syntax=docker/dockerfile:1.7
FROM node:24.22.1-alpine3.24
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && addgroup -S -g 1001 app && adduser -S -u 1001 -G app app
COPY --chown=app:app src ./src
USER app
EXPOSE 8088
CMD ["node", "src/server.mjs"]
