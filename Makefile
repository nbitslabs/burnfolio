.PHONY: build test install deploy

build:
	go build -o bin/pyro ./cmd/pyro

test:
	go test ./...

install:
	go install ./cmd/pyro

deploy:
	wrangler deploy
