# 3DGames

基于 Three.js 构建的单页面 3D 游戏合集。在线访问：**https://game.jeremyxie.com/**。

## 游戏列表

| 游戏 | 类型 | 入口 |
| --- | --- | --- |
| **Midnight Port · 午夜港口** | 3D 战术射击 (FPS) | [`games/cs.html`](games/cs.html) |
| **Flappy Bird 3D** | 3D 街机飞行 | [`games/flappy.html`](games/flappy.html) |
| **Turbo Kart 3D · 极速卡丁车** | 3D 卡丁车竞速 | [`games/kart.html`](games/kart.html) |

## 目录结构

**单独玩或分享赛车：** 下载原始 `games/kart.html`，用支持 WebGL 2 的现代浏览器打开即可。三辆赛车及车手、三条赛道、道具和渲染引擎都在这个文件内，不需要 Blender、模型目录、CDN 或本地服务器。

玩法、镜头和光照仍可直接编辑 HTML 中的模块脚本。若要替换某个模型，先执行 `node scripts/pack-kart-html.mjs --extract kart-models`，替换导出目录里的对应 GLB，再执行 `node scripts/pack-kart-html.mjs kart-models` 写回 HTML。正常构建和部署不需要执行这两步。

```text
.
├── .github/workflows/   # Cloudflare 自动部署工作流
├── games/               # 单文件 3D 游戏页面
│   ├── cs.html
│   ├── flappy.html
│   └── kart.html
├── scripts/             # 静态站点构建脚本
├── index.html           # 游戏合集首页
├── cloudflare.config.ts # Cloudflare Workers 配置
├── wrangler.config.ts   # Wrangler 静态资源配置
└── package.json
```

## 自动部署到 Cloudflare

本仓库通过 GitHub Actions 部署到 **Cloudflare Workers Static Assets**，Worker 名称为 `game`，站点地址为 **https://game.jeremyxie.com/**。账户与自定义域名由 `cloudflare.config.ts` 管理。

### 首次配置

1. 在 [Cloudflare 控制台](https://dash.cloudflare.com/) 选择目标账户，复制 **Account ID**。首次使用 Workers 时，先在 **Workers & Pages** 中完成账户的 `workers.dev` 子域名设置。
2. 在 Cloudflare 账户的 **Manage account → Account API tokens** 创建部署 Token：将 **Specified Workers → game** 的权限设为 **Individual Workers Editor**，并对 **Specified Domains → jeremyxie.com** 授予 **Workers Routes → Edit** 和 **Zone → Read**。限定 Worker 和域名资源，勿使用 Global API Key。当前部署 Token 到期日为 **2027-11-17**，到期前需更新 GitHub Secret。
3. 打开 GitHub 仓库的 **Settings → Secrets and variables → Actions → New repository secret**，添加：

   | Secret | 内容 |
   | --- | --- |
   | `CLOUDFLARE_API_TOKEN` | 上一步创建的 API Token |
   | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |

4. 将部署配置推送到 `main`，或者在 **Actions → Deploy HTML to Cloudflare → Run workflow** 中选择 `main` 手动运行。
5. 在成功运行的 **Deploy to Cloudflare** 步骤日志中查看站点地址。

### 部署规则

- 每次推送到 `main` 自动校验并部署；Pull Request 只构建和校验，不读取部署凭据。
- 构建脚本将所有已加入 Git 的 HTML 复制到 `dist/`，保留文件名及子目录结构；只部署该目录。新增 HTML 无需修改工作流；当前页面的脚本和样式均内嵌或引用 CDN。如果以后增加独立 CSS、JS、图片等资源，需要同步调整 `scripts/build-site.mjs` 的收集规则。
- `index.html` 为首页，游戏页面可通过 `/games/cs.html`、`/games/flappy.html`、`/games/kart.html` 访问。不存在的路径返回 404。
- 同一分支同一时间只运行一个工作流，避免并行发布。手动运行非 `main` 分支只校验，不更新线上站点。
- 若账户中已存在同名 Worker，部署会更新该 Worker；需要另一个站点时，先修改 `cloudflare.config.ts` 中的 `worker.name`。

### 本地校验

需要 Node.js 24（最低支持 22.18）：

```sh
npm ci
npm run build
npx cf deploy --prebuilt --mode production --dry-run
```

以上命令无需 Cloudflare 凭据，也不会上传文件。依赖版本由 `package-lock.json` 固定。

如需回滚，在 Cloudflare 控制台打开该 Worker 的 **Deployments**，选择上一版本回滚；同时回退 GitHub 上对应变更，避免下一次推送再次发布问题版本。
