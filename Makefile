ENV_CHECK = if [ ! -f .env ]; then cp .env.example .env; echo ".env created. Edit it before running Docker"; else echo ".env already exists, not overwritten"; fi

all: up

up:
	@$(ENV_CHECK) && docker compose up -d

dev:
	@$(ENV_CHECK) && docker compose up

wasm:
	@$(ENV_CHECK) && docker compose build frontend && docker compose up -d

wasm-full:
	@$(ENV_CHECK) && docker compose build --no-cache frontend && docker compose up -d

down:
	docker compose down

re: down wasm

build:
	@$(ENV_CHECK) && docker compose build

logs:
	docker compose logs -f

logs-%:
	docker compose logs -f $*

clean:
	docker compose down -v --rmi all

destroy:
	docker compose down -v
	docker system prune -a -f

delete: destroy

shell-%:
	docker compose exec $* sh

.PHONY: all up down dev build logs clean destroy delete re shell-% wasm wasm-full