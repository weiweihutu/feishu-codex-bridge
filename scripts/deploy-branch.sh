#!/usr/bin/env bash
#
# Fetch, build, package, globally install, and start a specific Fork branch.
#
# Usage:
#   ./scripts/deploy-branch.sh bsq/0.6.10
#
# Optional environment variables:
#   DEPLOY_REMOTE=origin       Git remote to fetch from
#   DEPLOY_RUN_TESTS=1        Run the full test suite before installation
#   DEPLOY_NO_START=1         Install the package without starting the service
#   DEPLOY_ARTIFACT_DIR=...   Directory used for the generated .tgz
set -Eeuo pipefail

BRANCH="${1:-}"
REMOTE="${DEPLOY_REMOTE:-origin}"
RUN_TESTS="${DEPLOY_RUN_TESTS:-0}"
NO_START="${DEPLOY_NO_START:-0}"

say() {
  printf '\n\033[1;36m==> %s\033[0m\n' "$*"
}

ok() {
  printf '\033[1;32m✓ %s\033[0m\n' "$*"
}

die() {
  printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2
  exit 1
}

[ -n "$BRANCH" ] || die "缺少分支名。用法：$0 bsq/0.6.10"
command -v git >/dev/null 2>&1 || die "未找到 git"
command -v node >/dev/null 2>&1 || die "未找到 node"
command -v npm >/dev/null 2>&1 || die "未找到 npm"
git check-ref-format --branch "$BRANCH" >/dev/null 2>&1 || die "无效分支名：$BRANCH"

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "请在 feishu-codex-bridge Git 仓库中运行"
cd "$ROOT"

git remote get-url "$REMOTE" >/dev/null 2>&1 || die "Git remote 不存在：$REMOTE"

if [ -n "$(git status --porcelain)" ]; then
  git status --short
  die "工作区存在未提交改动。请先 commit 或 stash，再执行部署"
fi

say "拉取 $REMOTE/$BRANCH"
# Explicit refspec also works for repositories originally cloned with
# --single-branch.
git fetch "$REMOTE" \
  "+refs/heads/$BRANCH:refs/remotes/$REMOTE/$BRANCH"

REMOTE_REF="refs/remotes/$REMOTE/$BRANCH"
git show-ref --verify --quiet "$REMOTE_REF" || die "远程分支不存在：$REMOTE/$BRANCH"

if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git switch "$BRANCH"
  git merge --ff-only "$REMOTE/$BRANCH"
else
  git switch --create "$BRANCH" --track "$REMOTE/$BRANCH"
fi

COMMIT="$(git rev-parse --short HEAD)"
VERSION="$(node -p "require('./package.json').version")"
PACKAGE_FILE="$(node -p "require('./package.json').name.replace(/^@/, '').replace(/\\//g, '-') + '-' + require('./package.json').version + '.tgz'")"
ARTIFACT_DIR="${DEPLOY_ARTIFACT_DIR:-$HOME/.cache/feishu-codex-bridge-deploy}"
TGZ="$ARTIFACT_DIR/$PACKAGE_FILE"

say "安装依赖并验证源码（branch=$BRANCH commit=$COMMIT version=$VERSION）"
npm ci
npm run typecheck
if [ "$RUN_TESTS" = "1" ]; then
  npm test
fi
npm run build

say "打包 $PACKAGE_FILE"
mkdir -p "$ARTIFACT_DIR"
npm pack --pack-destination "$ARTIFACT_DIR"
[ -f "$TGZ" ] || die "打包完成但未找到：$TGZ"

say "停止旧服务"
if command -v feishu-codex-bridge >/dev/null 2>&1; then
  feishu-codex-bridge stop || true
fi

say "全局安装 Fork 包"
npm install -g "$TGZ"
hash -r

command -v feishu-codex-bridge >/dev/null 2>&1 || die "全局安装后找不到 feishu-codex-bridge"
INSTALLED_VERSION="$(feishu-codex-bridge --version)"
[ "$INSTALLED_VERSION" = "$VERSION" ] ||
  die "安装版本不一致：源码=$VERSION，命令=$INSTALLED_VERSION"

if [ "$NO_START" = "1" ]; then
  ok "已安装 $BRANCH ($COMMIT) 版本 $VERSION，按 DEPLOY_NO_START=1 未启动服务"
  printf 'package: %s\n' "$TGZ"
  exit 0
fi

say "安装并启动后台服务"
feishu-codex-bridge start
feishu-codex-bridge status

ok "部署完成：$BRANCH ($COMMIT) version=$VERSION"
printf 'package: %s\n' "$TGZ"
printf 'logs: feishu-codex-bridge logs -f\n'
printf 'note: Fork 部署不要运行 feishu-codex-bridge update\n'
