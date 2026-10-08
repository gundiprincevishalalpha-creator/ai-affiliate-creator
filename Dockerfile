FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg zip ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
ENV PORT=8787
EXPOSE 8787
CMD ["node","server.js"]
