FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
# sessões do WhatsApp ficam no volume /data (não vão para a imagem)
RUN mkdir -p /data/sessions && chown -R node:node /data
VOLUME ["/data"]
ENV SESSIONS_DIR=/data/sessions
USER node
CMD ["node", "--import", "tsx", "src/main.ts"]
