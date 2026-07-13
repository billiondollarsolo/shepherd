# Shepherd dev/CI orchestration. Host needs ONLY docker.
# All real work runs inside the dev containers (docker-compose.dev.yml).

COMPOSE := docker compose -f docker-compose.dev.yml
RUN     := $(COMPOSE) run --rm builder sh -lc

.DEFAULT_GOAL := help

.PHONY: help up down verify test-int e2e sh build install logs ps

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

up: ## Start postgres + orchestrator + web (detached)
	$(COMPOSE) up -d postgres orchestrator web

down: ## Stop everything and remove containers
	$(COMPOSE) down

install: ## Install workspace deps inside the builder
	$(RUN) 'pnpm install'

verify: ## UNIT gate: install + typecheck + build + unit tests
	$(RUN) 'pnpm install && pnpm -r typecheck && pnpm -r build && pnpm test:unit'

test-int: ## Integration gate: needs postgres + sshd + chromium
	$(COMPOSE) up -d postgres sshd
	$(RUN) 'pnpm install && pnpm test:int'

e2e: ## Playwright UI smokes
	$(RUN) 'pnpm install && pnpm test:e2e'

build: ## Build all packages inside the builder
	$(RUN) 'pnpm install && pnpm -r build'

sh: ## Open a shell in the builder
	$(COMPOSE) run --rm builder bash

logs: ## Tail logs from running services
	$(COMPOSE) logs -f

ps: ## Show service status
	$(COMPOSE) ps
