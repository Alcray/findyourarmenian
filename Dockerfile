FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

RUN mkdir -p /app/data/raw-runs

EXPOSE 3000
VOLUME ["/app/data"]

CMD ["node", "src/server.js"]
