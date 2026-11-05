FROM node:24.22.1-alpine3.24

WORKDIR /app
ENV NODE_ENV=production
ENV WEATHER_APP_PORT=3020

COPY --chown=node:node . .

USER node
EXPOSE 3020

HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.WEATHER_APP_PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
