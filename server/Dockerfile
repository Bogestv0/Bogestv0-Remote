FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js entrypoint.sh ./
RUN chmod +x entrypoint.sh
ENV DATA_DIR=/data
VOLUME /data
ENTRYPOINT ["./entrypoint.sh"]
