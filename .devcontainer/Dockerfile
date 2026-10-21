FROM golang:1.27.3-bookworm AS go
FROM node:24-bookworm-slim

COPY --from=go /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:${PATH}" \
    GOPATH=/home/node/go \
    GOCACHE=/home/node/.cache/go-build \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       build-essential ca-certificates curl git openssh-client postgresql-client sudo \
    && rm -rf /var/lib/apt/lists/* \
    && echo 'node ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/node \
    && chmod 0440 /etc/sudoers.d/node \
    && corepack enable \
    && corepack prepare pnpm@12.14.0 --activate

USER node
WORKDIR /workspaces/RelayAPI
CMD ["sleep", "infinity"]
