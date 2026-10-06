FROM node:20-alpine AS base
WORKDIR /app

# Alpine ships no OpenSSL package by default - Prisma's query engine needs it
# both to detect which OpenSSL ABI is present (see schema.prisma binaryTargets)
# and to actually load at runtime.
RUN apk add --no-cache openssl

COPY package*.json ./
RUN npm ci --omit=dev

COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src

EXPOSE 4000
# Apply migrations and (idempotently) ensure the permission catalog exists, so a
# fresh database is usable with no manual step, then start the API.
CMD ["sh", "-c", "npx prisma migrate deploy && node prisma/seedPermissions.js && node src/server.js"]
