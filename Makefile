.PHONY: build test install ui deploy

build:
	go build -o bin/pyro ./cmd/pyro

test:
	go test ./...

install:
	go install ./cmd/pyro

ui:
	npm run build:ui

deploy: ui
	wrangler deploy
