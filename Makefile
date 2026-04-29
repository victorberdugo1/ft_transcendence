.PHONY: up down build logs clean re setup shell-% wasm

wasm:
	docker compose build frontend
	docker compose up -d

up:
	docker compose up -d

dev:
	docker compose up

down:
	docker compose down

re: down wasm

build:
	docker compose build

logs:
	docker compose logs -f

logs-%:
	docker compose logs -f $*

clean:
	docker compose down -v --rmi all

setup:
	@if [ ! -f .env ]; then \
		cp .env.example .env; \
		echo "✅ .env creado. Edítalo antes de hacer 'make up'"; \
	else \
		echo "⚠️  .env ya existe, no se sobreescribe"; \
	fi

shell-%:
	docker compose exec $* sh