# Playwright's own image pins a Chromium build that matches the `playwright`
# npm package version exactly. Do not substitute a bare node image and
# apt-get a browser: that mismatch between browser and driver is what rotted
# the prior art this project replaces. Tag pinned to package-lock.json's
# resolved "playwright" version (1.62.1) -- if they disagree, that's a bug.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app

# NODE_ENV=production is set AFTER `npm ci`, deliberately. npm ci honours
# NODE_ENV: if it were production already, `npm ci` would skip
# devDependencies -- which is where `typescript` lives -- and the `npx tsc`
# build step below would silently fall through to installing and running
# npm's unrelated decoy "tsc" package instead of the real compiler. That is
# not a hypothetical: it is exactly what happens if this ordering is
# reversed. devDependencies stay in the final image (this is a single-stage
# build); NODE_ENV=production still governs the app's own runtime behaviour.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

ENV NODE_ENV=production
USER pwuser
EXPOSE 3000
CMD ["node", "dist/src/index.js"]
