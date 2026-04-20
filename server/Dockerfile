FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server/ ./server/
ENV PORT=4000
ENV OTA_DATA_DIR=/app/data
ENV OTA_UPLOADS_DIR=/app/uploads
EXPOSE 4000
CMD ["node", "server/src/index.js"]
