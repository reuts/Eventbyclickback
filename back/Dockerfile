# ---------- Dependencies ----------
# A stage of its own so the final image can carry node_modules as a separate
# layer. It is 926 of the image's ~985 MB, and its bytes change only when
# package-lock.json does — so a source-only rebuild neither re-pushes it to
# GHCR nor re-pulls it on the server. Before this split, every deploy moved the
# whole 985 MB because node_modules shared a layer with the source.
FROM node:18-bullseye AS deps

WORKDIR /app

COPY package*.json ./
RUN npm ci --no-audit --no-fund

# ---------- Build ----------
FROM deps AS build

COPY . .
ENV NODE_ENV=production
# node_modules is dropped once the build is done, so the run stage's copy of
# /app does not bring along a second, source-dependent copy of it. `strapi
# build` writes only to dist/ and .strapi/, so the deps stage's copy is exactly
# what the build ran against.
RUN npm run build && rm -rf node_modules


# ---------- Run stage ----------
FROM node:18-bullseye

WORKDIR /app

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app ./

# Strapi default port
EXPOSE 1337

CMD ["npm", "run", "start"]
