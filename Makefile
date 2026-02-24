.DEFAULT_GOAL := help

.PHONY: help build test lint clean run docs-serve docs-build

help: ## Show this help message
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-15s\033[0m %s\n", $$1, $$2}'

VERSION ?= dev

docs-serve: ## Serve documentation locally
	uvx --with mkdocs-material mkdocs serve

docs-build: ## Build documentation site
	uvx --with mkdocs-material mkdocs build --strict
