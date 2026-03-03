FROM node:18-bullseye-slim
WORKDIR /app
COPY server/package.json server/
RUN cd server && npm ci --production
COPY server/ server/
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server/index.js"]
