FROM node:24-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
RUN addgroup -S -g 1001 sarjy && adduser -S -u 1001 -G sarjy sarjy
COPY --from=build --chown=sarjy:sarjy /app/.next/standalone ./
COPY --from=build --chown=sarjy:sarjy /app/.next/static ./.next/static
COPY --from=build --chown=sarjy:sarjy /app/public ./public
USER sarjy
EXPOSE 3000
CMD ["node", "server.js"]
