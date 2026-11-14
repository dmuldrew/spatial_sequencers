FROM node:22-alpine

WORKDIR /app

# git is required to install d3-audio directly from GitHub
RUN apk add --no-cache git

COPY package.json ./
RUN npm install --omit=dev && apk del git

COPY server.js ./
COPY public ./public

ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1

CMD ["node", "server.js"]
