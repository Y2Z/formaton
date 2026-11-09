#!/usr/bin/make -f

INSTALL_DEPS: ## Install required dependencies
	@npm ci --no-audit --no-fund
.PHONY: INSTALL_DEPS

INSTALL_BROWSERS: ## Install Chromium (and its system libraries) for the browser tests
	@npx playwright install --with-deps chromium
	@chmod -R a+rX "$${PLAYWRIGHT_BROWSERS_PATH:-$$HOME/.cache/ms-playwright}"
.PHONY: INSTALL_BROWSERS

UPDATE_LOCK_FILE: ## Generate new package-lock.json file
	@npm i --no-audit --no-fund --no-progress --package-lock-only
.PHONY: UPDATE_LOCK_FILE
