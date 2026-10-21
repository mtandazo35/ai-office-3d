FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY scripts ./scripts

# /datos guarda el certificado autofirmado (volumen con nombre en el compose).
RUN mkdir -p /datos && chmod 0777 /datos

USER node
EXPOSE 7777 7778

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:7778/salud >/dev/null || exit 1

CMD ["node", "src/servidor.js"]
