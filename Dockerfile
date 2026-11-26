# glibc >= 2.38 is needed by the WebTransport (quiche) native module.
FROM node:22-trixie-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
