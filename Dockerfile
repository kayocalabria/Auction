# Roda o servidor do Leilão (modo sala) em qualquer lugar com Docker:
#   docker build -t leilao . && docker run -p 3000:3000 leilao
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server/index.js"]
