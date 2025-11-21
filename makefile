FRONTEND_DIR = ./web
BACKEND_DIR = .

.PHONY: all build-frontend start-backend dev dev-frontend dev-backend stop

all: build-frontend start-backend

# 生产环境构建
build-frontend:
	@echo "Building frontend..."
	@cd $(FRONTEND_DIR) && bun install && DISABLE_ESLINT_PLUGIN='true' VITE_REACT_APP_VERSION=$(cat VERSION) bun run build

# 后端服务
start-backend:
	@echo "Starting backend dev server..."
	@cd $(BACKEND_DIR) && go run main.go

# 开发模式 - 启动前后端（带热更新）
dev:
	@echo "Starting development servers..."
	@echo "Backend: http://localhost:3000"
	@echo "Frontend: http://localhost:5173 (with HMR)"
	@cd $(BACKEND_DIR) && go run main.go &
	@sleep 2
	@cd $(FRONTEND_DIR) && bun run dev

# 单独启动前端开发服务器（热更新）
dev-frontend:
	@echo "Starting frontend dev server with HMR..."
	@cd $(FRONTEND_DIR) && bun run dev

# 单独启动后端开发服务器
dev-backend:
	@echo "Starting backend dev server..."
	@cd $(BACKEND_DIR) && go run main.go

# 停止所有服务
stop:
	@echo "Stopping all services..."
	@pkill -f "go run main.go" 2>/dev/null || echo "No backend running"
	@pkill -f "vite" 2>/dev/null || echo "No frontend running"
	@echo "All services stopped"
