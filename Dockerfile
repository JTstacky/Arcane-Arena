# Optional self-hosted server (the GitHub Pages site doesn't need it): serves
# the game and hosts rooms over WebSockets.
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN VITE_TRANSPORT=ws npm run build && npm prune --omit=dev
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
