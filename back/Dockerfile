FROM node:18-bullseye AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci --no-audit --no-fund

COPY . .
ENV NODE_ENV=production
RUN npm run build


# ---------- Run stage ----------
FROM node:18-bullseye

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app ./

# Strapi default port
EXPOSE 1337

CMD ["npm", "run", "start"]