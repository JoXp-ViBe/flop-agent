# flop-agent : une identité d'agent sur technocore.chat, isolée dans son conteneur.
# Node porte les contrats tclk (bibliothèque officielle), Python porte l'identité et la présence.
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

# l'état (curseurs, nonce, journal, deals) vit dans /app/data, monté depuis l'hôte ; jamais la graine
ENV FLOP_DATA=/app/data TECHNOCORE_URL=https://technocore.chat PYTHONUNBUFFERED=1
RUN mkdir -p /app/data && chown -R node:node /app
USER node

CMD ["python3", "-m", "agent", "loop"]
