.PHONY: build test vet fmt lint race clean release-snapshot

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -X main.Version=$(VERSION)
DIST ?= dist

build:
	go build -ldflags "$(LDFLAGS)" -o bin/shep-tui ./cmd/shep-tui

test:
	go test ./...

race:
	go test -race ./...

vet:
	go vet ./...

fmt:
	gofmt -w .

lint: vet
	@command -v golangci-lint >/dev/null 2>&1 && golangci-lint run ./... || echo "golangci-lint not installed; ran go vet only"

clean:
	rm -rf bin/ $(DIST)/

# Cross-compile snapshot binaries into dist/ (linux amd64 + arm64).
release-snapshot:
	@mkdir -p $(DIST)
	@echo "$(VERSION)" > $(DIST)/VERSION
	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags "$(LDFLAGS)" \
		-o $(DIST)/shep-tui_linux_amd64 ./cmd/shep-tui
	GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -ldflags "$(LDFLAGS)" \
		-o $(DIST)/shep-tui_linux_arm64 ./cmd/shep-tui
	@echo "release-snapshot: $(VERSION)"
	@ls -la $(DIST)/
