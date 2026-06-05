# flock-agentd build targets.
#
#   make            → build a local binary at ./flock-agentd
#   make dist       → cross-compile release binaries into ./dist for every node
#                     platform (consumed by FsAgentdBinaryProvider on bootstrap)
#   make test       → go test ./...
#
# T14 — VERSION is the SINGLE source of truth (the ./VERSION file). It is stamped
# into the binary (flock-agentd version), embedded via go:embed for unstamped
# builds, and MUST match the orchestrator's AgentdBootstrap `version` (set
# FLOCK_AGENTD_VERSION from this same file in deploy) so upgrade detection works.
# A mismatch forces the daemon to re-ship + restart, which kills live sessions.

VERSION ?= $(shell cat $(dir $(lastword $(MAKEFILE_LIST)))VERSION)
LDFLAGS := -s -w -X main.Version=$(VERSION)
PLATFORMS := linux/amd64 linux/arm64

.PHONY: all dist test clean

all:
	go build -ldflags "$(LDFLAGS)" -o flock-agentd .

dist:
	@mkdir -p dist
	@for p in $(PLATFORMS); do \
		os=$${p%/*}; arch=$${p#*/}; \
		echo "building dist/flock-agentd-$$os-$$arch"; \
		CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch \
			go build -ldflags "$(LDFLAGS)" -o dist/flock-agentd-$$os-$$arch . ; \
	done

test:
	go test ./...

clean:
	rm -f flock-agentd
	rm -rf dist
