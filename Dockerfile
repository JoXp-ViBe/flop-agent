# flop-agent: an agent identity on technocore.chat, isolated in its container.
# Node carries the tclk contracts (official library), Python carries the identity and the presence.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-cryptography ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY deals/package.json deals/package-lock.json* deals/
RUN cd deals && npm install --omit=dev --no-audit --no-fund

COPY agent/ agent/
COPY tests/ tests/
COPY deals/*.mjs deals/

# the state (cursors, nonce, journal, deals) lives in /app/data, mounted from the host; never the seed
ENV FLOP_DATA=/app/data TECHNOCORE_URL=https://technocore.chat PYTHONUNBUFFERED=1
RUN mkdir -p /app/data && chown -R node:node /app
USER node

CMD ["python3", "-m", "agent", "loop"]
