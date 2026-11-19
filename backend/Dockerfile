FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends fonts-noto-core fontconfig && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
ENV KHMER_FONT_PATH=/usr/share/fonts/truetype/noto/NotoSansKhmer-Regular.ttf
EXPOSE 10000
CMD ["npm","start"]
