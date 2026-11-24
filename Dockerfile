# Stage 1: build the static site. This is the heavy part (Cesium): it needs a few GB of
# memory, so build the image on a machine that has them and copy it to a small server.
FROM node:24.4.1-alpine AS build

WORKDIR /app

# Some dependencies are installed from git
RUN apk add --no-cache git

# Dependencies first, so a code change does not reinstall them
COPY package.json package-lock.json ./
RUN npm ci

COPY . /app/

# The URLs are baked into the site at build time. Passed as build arguments they win over
# a .env file in the build context; an argument left out (empty) is unset, so .env counts.
# USE_DOTENV=false ignores .env files altogether: only the arguments count, and a local
# development .env cannot end up in a production build.
ARG USE_DOTENV=true
ARG APP_URL
ARG CONFIG_URL
ARG CONFIG_SERVER_URL
RUN [ "$USE_DOTENV" != "false" ] || rm -f .env .env.*
# Node's default heap (about 2 GB) is too small for bundling Cesium
ENV NODE_OPTIONS=--max-old-space-size=6144
RUN for name in APP_URL CONFIG_URL CONFIG_SERVER_URL; do \
        eval "[ -n \"\$$name\" ] || unset $name"; \
    done; \
    npm_config_adapter=static npm run build

# Stage 2: only the built files and a small static file server
FROM node:24.4.1-alpine

WORKDIR /app

RUN npm install -g serve@14.2.4

COPY --from=build /app/build ./build

EXPOSE 5000

CMD ["serve", "-s", "build", "-l", "5000"]
