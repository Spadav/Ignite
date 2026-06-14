GO_CACHE ?= /tmp/ignite-go-cache
GO_MOD_CACHE ?= /tmp/ignite-go-mod
VERSION ?= 2.0.0
COMMIT ?= dev
IGNITE_REPO ?= Spadav/Ignite
GO_ENV := GOCACHE=$(GO_CACHE) GOMODCACHE=$(GO_MOD_CACHE) GOFLAGS=-buildvcs=false
GO_LDFLAGS := -X ignite/version.Version=$(VERSION) -X ignite/version.Commit=$(COMMIT) -X ignite/version.Repo=$(IGNITE_REPO)
GO_PACKAGES := $(shell $(GO_ENV) go list ./... | grep -v '/llama-backends/')

.PHONY: backend frontend dev test go-test build web-build build-all check clean

backend: web-build
	$(GO_ENV) go run -ldflags "$(GO_LDFLAGS)" . --config ignite.yaml

frontend:
	cd web && npm run dev -- --host 0.0.0.0

dev: backend

go-test:
	$(GO_ENV) go test $(GO_PACKAGES)

test: web-build go-test

build: web-build
	$(GO_ENV) go build -ldflags "$(GO_LDFLAGS)" -o ignite .

web-build:
	cd web && npm run build

build-all: build

check: test build-all

clean:
	rm -f ignite
