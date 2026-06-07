# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS deps
WORKDIR /app
COPY web/package.json ./package.json
COPY web/package-lock.json ./package-lock.json
RUN npm ci

FROM deps AS builder
COPY web ./
RUN npm run build

FROM nginx:1.27-alpine AS runner
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 8080
