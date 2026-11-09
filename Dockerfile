FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends make \
    && rm -rf /var/lib/apt/lists/*

# Browsers go to a shared location, so tests also run under your own user ID
# (the Makefile runs containers as you). The demo server listens on all
# interfaces so the published port reaches it. Tools from ../node_modules are
# on PATH for `make shell`.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HOST=0.0.0.0 \
    PATH=/src/y2z/node_modules/.bin:$PATH

# Install packages into ./../node_modules, outside the source tree that gets
# mounted over /src/y2z/valex (Node finds them by walking up)
WORKDIR /src/y2z/valex/..
COPY Prebuild.mk package.json package-lock.json* ./
RUN make -f Prebuild.mk UPDATE_LOCK_FILE
RUN make -f Prebuild.mk INSTALL_DEPS
RUN make -f Prebuild.mk INSTALL_BROWSERS

WORKDIR /src/y2z/valex

CMD ["make", "SERVE"]
