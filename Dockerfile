FROM node:22-slim
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENTRYPOINT ["node", "/app/dist/cli/main.js"]
