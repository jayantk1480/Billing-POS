# One image for the whole product. Every service (API, back office, billing screen, kitchen display,
# platform admin, database migrations) runs from it with a different command; see infra/prod/docker-compose.yml.
#
# The public addresses are build arguments because Next.js fixes NEXT_PUBLIC_* values into the pages when
# they are built. Change a domain name and the image has to be built again.

FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/* && corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages ./packages
COPY apps ./apps
# The browser tests are part of the workspace, so the lockfile expects their package file. The tests themselves stay out.
COPY e2e/package.json ./e2e/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile

ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_POS_URL
ARG NEXT_PUBLIC_APP_NAME="Rasoi POS"
ARG NEXT_PUBLIC_SUPPORT_EMAIL=""
RUN test -n "$NEXT_PUBLIC_API_URL" && test -n "$NEXT_PUBLIC_POS_URL" \
  || (echo "Set the NEXT_PUBLIC_API_URL and NEXT_PUBLIC_POS_URL build arguments (infra/prod/docker-compose.yml does this from .env)" && exit 1)
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_PUBLIC_POS_URL=$NEXT_PUBLIC_POS_URL \
    NEXT_PUBLIC_APP_NAME=$NEXT_PUBLIC_APP_NAME NEXT_PUBLIC_SUPPORT_EMAIL=$NEXT_PUBLIC_SUPPORT_EMAIL
# One at a time: four Next.js builds side by side need more memory than a small server has.
RUN pnpm turbo run build --concurrency=1

# Nothing is installed or built when a container starts: every service is started with plain `node`.
# (Starting through pnpm would make it check, and try to reinstall, the packages on every start.)
FROM node:22-bookworm-slim AS run
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app /app
# Uploaded images. A volume is mounted here, so they outlive the container.
RUN mkdir -p /app/storage && chown node:node /app/storage
USER node
EXPOSE 4000 3100 3101 3102 3103
CMD ["node", "apps/api/dist/main.js"]
