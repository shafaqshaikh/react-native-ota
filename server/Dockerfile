FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production --no-audit --no-fund

FROM node:20-alpine
WORKDIR /app
# mendsley/bsdiff produces the ENDSLEY/BSDIFF43 format that our client-side
# bspatch parses. Alpine ships only Colin Percival's bsdiff (BSDIFF40, in
# edge/testing) — incompatible. Compile from source.
RUN apk add --no-cache bzip2 \
 && apk add --no-cache --virtual .bsdiff-build build-base bzip2-dev wget \
 && wget -qO /tmp/bsdiff.c https://raw.githubusercontent.com/mendsley/bsdiff/master/bsdiff.c \
 && wget -qO /tmp/bsdiff.h https://raw.githubusercontent.com/mendsley/bsdiff/master/bsdiff.h \
 && cc -O2 -DBSDIFF_EXECUTABLE -I/tmp -o /usr/local/bin/bsdiff /tmp/bsdiff.c -lbz2 \
 && rm /tmp/bsdiff.c /tmp/bsdiff.h \
 && apk del .bsdiff-build
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/health || exit 1

CMD ["node", "src/index.js"]
