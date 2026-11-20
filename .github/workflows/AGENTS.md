# 站点验证与发布

- 棱镜检查从干净的依赖和生产构建开始：`npm ci`、`npx playwright install --with-deps chromium`、`npm run build`、`npm run test:prism`。它与其他游戏的检查不共享构建目录，也不需要部署凭据。
- 保留必经检查名 `Validate site`。只有 `site`、`prism` 两个前置任务都返回 `success` 才可通过；失败、取消或跳过都不是成功。`Validate Ace WebGL` 另行把关。
- 只有 `deploy` 任务可使用 Cloudflare 部署凭据。它依赖 `validate` 和 `ace`，只在 `main` 原有事件下检出本次通过验证的 SHA。不要通过跳过测试或手动部署来处理超时。
