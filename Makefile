#!/usr/bin/make -f

ifeq ($(OS),Windows_NT)
    CWD ?= "$(shell echo %CD%)"
    DOCKER ?= docker
    DOCKER_USER ?=
else
    CWD ?= "$(shell pwd)"
    DOCKER ?= $(if $(shell docker -v 2>/dev/null),docker,podman)
    # Run as you, so files the container writes (dist/, package-lock.json, the
    # .tgz) belong to you. Rootless podman already maps the container's root to you.
    DOCKER_USER ?= $(if $(filter docker,$(DOCKER)),--user $(shell id -u):$(shell id -g),)
endif
DOCKER_IMAGE_TAG ?= y2z/valex
PORT ?= 8080
TTY ?= -it

DOCKER_RUN = $(DOCKER) run $(TTY) --rm $(DOCKER_USER) -e HOME=/tmp -v $(CWD):/src/$(DOCKER_IMAGE_TAG)

.DEFAULT_GOAL := help

create-image: ## Create image
	@$(DOCKER) build -t $(DOCKER_IMAGE_TAG) .
.PHONY: create-image

help: ## Show this helpful message
	@for ML in $(MAKEFILE_LIST); do \
		grep -E '^[a-zA-Z_-]+:.*?## .*$$' $$ML | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'; \
	done
.PHONY: help

serve: create-image ## Start demo server in a container (http://localhost:8080/demo/)
	@$(DOCKER_RUN) -e PORT=$(PORT) -p $(PORT):$(PORT) $(DOCKER_IMAGE_TAG)
.PHONY: serve

SERVE: ## Start demo server
	@npm run demo
.PHONY: SERVE

build: create-image ## Compile to dist/ in a container
	@$(DOCKER_RUN) $(DOCKER_IMAGE_TAG) make BUILD
.PHONY: build

BUILD: ## Compile to dist/
	@npm run build
.PHONY: BUILD

test: create-image ## Run engine tests in a container
	@$(DOCKER_RUN) $(DOCKER_IMAGE_TAG) make TEST
.PHONY: test

TEST: ## Run engine tests
	@npm test
.PHONY: TEST

test-browser: create-image ## Run DOM tests in Chromium, in a container
	@$(DOCKER_RUN) --ipc=host $(DOCKER_IMAGE_TAG) make TEST_BROWSER
.PHONY: test-browser

TEST_BROWSER: ## Run DOM tests in Chromium
	@npm run test:browser
.PHONY: TEST_BROWSER

pack: create-image ## Build the npm package (.tgz) in a container
	@$(DOCKER_RUN) $(DOCKER_IMAGE_TAG) make PACK
.PHONY: pack

PACK: ## Build the npm package (.tgz)
	@npm run build && npm pack
.PHONY: PACK

shell: create-image ## Open a shell in the container
	@$(DOCKER_RUN) -p $(PORT):$(PORT) $(DOCKER_IMAGE_TAG) bash
.PHONY: shell

update-lock-file: create-image ## Update package-lock.json
	@$(DOCKER_RUN) $(DOCKER_IMAGE_TAG) make -f Prebuild.mk UPDATE_LOCK_FILE
.PHONY: update-lock-file
