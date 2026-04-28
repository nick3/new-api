FRONTEND_DIR = ./web/default
FRONTEND_CLASSIC_DIR = ./web/classic
BACKEND_DIR = .

.PHONY: all build-frontend build-frontend-classic build-all-frontends start-backend dev dev-api dev-web dev-web-classic dev-frontend dev-backend stop

all: build-all-frontends start-backend

# 生产环境构建
build-frontend:
	@echo "Building default frontend..."
	@cd $(FRONTEND_DIR) && bun install && DISABLE_ESLINT_PLUGIN='true' VITE_REACT_APP_VERSION=$(cat ../../VERSION) bun run build

build-frontend-classic:
	@echo "Building classic frontend..."
	@cd $(FRONTEND_CLASSIC_DIR) && bun install && VITE_REACT_APP_VERSION=$(cat ../../VERSION) bun run build

build-all-frontends: build-frontend build-frontend-classic

# 后端服务
start-backend:
	@echo "Starting backend dev server..."
	@cd $(BACKEND_DIR) && go run main.go &

# 开发模式 - 启动前后端（带热更新）
dev: dev-api dev-web

dev-api:
	@echo "Starting backend services (docker)..."
	@docker compose -f docker-compose.dev.yml up -d

dev-web:
	@echo "Starting frontend dev server..."
	@cd $(FRONTEND_DIR) && bun install && bun run dev

dev-web-classic:
	@echo "Starting classic frontend dev server..."
	@cd $(FRONTEND_CLASSIC_DIR) && bun install && bun run dev

# 兼容旧命令：默认前端开发服务器
dev-frontend: dev-web

# 单独启动后端开发服务器
dev-backend:
	@echo "Starting backend dev server..."
	@cd $(BACKEND_DIR) && go run main.go

# 停止所有服务
stop:
	@echo "Stopping all services..."
	@docker compose -f docker-compose.dev.yml down 2>/dev/null || true
	@pkill -f "go run main.go" 2>/dev/null || echo "No backend running"
	@pkill -f "vite" 2>/dev/null || echo "No frontend running"
	@echo "All services stopped"
