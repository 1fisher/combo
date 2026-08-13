.PHONY: help dev dev-proxy build build-cli build-relay build-desktop bundle dmg tsc \
	version version-patch version-minor version-major \
	release release-patch release-minor release-major \
	tag push clean

# 默认目标
.DEFAULT_GOAL := help

##@ 开发

dev: ## 启动 Vite 开发服务器 (浏览器模式, 端口 5173)
	npm run dev

dev-proxy: ## 启动开发服务器并指向本地 proxy (:18234)
	bash scripts/dev-proxy.sh

##@ 构建

build: ## 一键构建: 前端 + combo-cli / combo-relay / 桌面端
	npm run build
	cargo build --release --workspace --exclude combo
	cargo build --release -p combo --features tauri/custom-protocol

build-cli: ## 仅编译 combo-cli
	cargo build --release -p combo-cli

build-relay: ## 仅编译 combo-relay
	cargo build --release -p combo-relay


build-desktop: ## 编译桌面端,内嵌前端资源 (target/release/combo)
	npm run build
	cargo build --release -p combo --features tauri/custom-protocol

bundle: ## 打包桌面端安装包 (macOS: .app + .dmg)
	npx tauri build

dmg: ## 打包 macOS DMG 安装镜像 (仅 DMG, 跳过 .app 独立包)
	npx tauri build --bundles dmg
	@echo ""
	@echo "✓ DMG 打包完成:"
	@find src-tauri/target/release/bundle/dmg -name '*.dmg' -exec ls -lh {} \;

tsc: ## TypeScript 类型检查 (tsc -b)
	npm run tsc

##@ 测试

test: ## 运行单元测试 (Vitest)
	npm test

test-e2e: ## 运行 E2E 测试 (需要 COMBO_CLI_BIN)
	npm run test:e2e

gen-api: ## 从 swagger.json 重新生成 API 类型
	npm run gen:api

##@ 版本管理
#
# 版本号会同步更新到: package.json / tauri.conf.json / 两个 Cargo.toml / Cargo.lock
# release-* 目标会自动: bump → commit → tag → push,一步到位。

VERSION ?= $(shell node -e "console.log(require('./package.json').version)")

version: ## 升级版本。用法: make version V=patch | minor | major | 1.2.3
	@if [ -z "$(V)" ]; then echo "用法: make version V=patch|minor|major|1.2.3"; exit 1; fi
	@bash scripts/version.sh "$(V)"

version-patch: ## 补丁版本 +1 (0.0.3 → 0.0.4)
	bash scripts/version.sh patch

version-minor: ## 次版本 +1 (0.0.3 → 0.1.0)
	bash scripts/version.sh minor

version-major: ## 主版本 +1 (0.0.3 → 1.0.0)
	bash scripts/version.sh major

##@ 发布 (自动提交 + 打 tag + 推送)

release: ## 发布版本,默认 patch。用法: make release [V=patch|minor|major|1.2.3]
	@bash scripts/version.sh "$(if $(V),$(V),patch)"
	@$(MAKE) --no-print-directory _commit_tag_push

release-patch: ## 发布补丁版本 (bump + commit + tag + push)
	@bash scripts/version.sh patch
	@$(MAKE) --no-print-directory _commit_tag_push

release-minor: ## 发布次版本 (bump + commit + tag + push)
	@bash scripts/version.sh minor
	@$(MAKE) --no-print-directory _commit_tag_push

release-major: ## 发布主版本 (bump + commit + tag + push)
	@bash scripts/version.sh major
	@$(MAKE) --no-print-directory _commit_tag_push

# 内部目标: 提交版本变更 → 打 tag → 推送 (含 tags)
_commit_tag_push:
	@NEW_VER=$$(node -e "console.log(require('./package.json').version)"); \
	echo "→ 提交版本 $$NEW_VER …"; \
	git add -A && \
	git commit -m "chore: 升级版本至 $$NEW_VER"; \
	echo "→ 创建 tag v$$NEW_VER …"; \
	git tag "v$$NEW_VER"; \
	echo "→ 推送到 origin/main (含 tags) …"; \
	git push origin main --tags; \
	echo "✓ 完成! v$$NEW_VER 已发布。"

tag: ## 为当前版本打 tag (不推送)
	@git tag "v$(VERSION)" 2>/dev/null || echo "tag v$(VERSION) 已存在"
	@echo "已创建 tag v$(VERSION),使用 'make push' 推送"

push: ## 推送当前分支和所有 tags 到 origin
	git push origin main --tags

##@ 其他

clean: ## 清理构建产物
	rm -rf dist/ target/ src-tauri/target/
	rm -f tsconfig.node.tsbuildinfo tsconfig.app.tsbuildinfo

help: ## 显示此帮助信息
	@awk 'BEGIN {FS = ":.*##"; printf "用法:\n  make \033[36m<target>\033[0m\n\n目标:\n"} \
 /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2 } \
 /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) }' $(MAKEFILE_LIST)
