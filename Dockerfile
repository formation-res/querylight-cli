FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENTRYPOINT ["node", "/app/dist/cli/main.js"]
