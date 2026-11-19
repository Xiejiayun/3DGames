# 3DGames

基于 Three.js 构建的单页面 3D 游戏合集。在线访问：**https://game.jeremyxie.com/**。

## 游戏列表

| 游戏 | 类型 | 入口 |
| --- | --- | --- |
| **Midnight Port · 午夜港口** | 3D 战术射击 (FPS) | [`games/cs.html`](games/cs.html) |
| **Flappy Bird 3D** | 3D 街机飞行 | [`games/flappy.html`](games/flappy.html) |
| **Turbo Kart 3D · 极速卡丁车** | 3D 卡丁车竞速 | [`games/kart.html`](games/kart.html) |
| **Ace Archipelago · 王牌群岛** | 3D 现代海岛空战（[场景清单与验收](docs/ace-scene-review.md)） | [`games/ace.html`](games/ace.html) |
| **Prism Vault · 棱镜密室** | 3D 光学解谜：在十间密室中用镜子、棱镜与滤色晶体引导光束 | [`games/prism.html`](games/prism.html) |
| **Iron Core Arena · 铁核竞技场** | 俯视角机甲生存：三款机甲、八波攻势与波间模块改装 | [`games/ironcore.html`](games/ironcore.html) |

## 目录结构

**单独玩或分享赛车：** 下载原始 `games/kart.html`，用支持 WebGL 2 的现代浏览器打开即可。三辆赛车及车手、三条赛道、道具和渲染引擎都在这个文件内，不需要 Blender、模型目录、CDN 或本地服务器。

玩法、镜头和光照仍可直接编辑 HTML 中的模块脚本。若要替换某个模型，先执行 `node scripts/pack-kart-html.mjs --extract kart-models`，替换导出目录里的对应 GLB，再执行 `node scripts/pack-kart-html.mjs kart-models` 写回 HTML。正常构建和部署不需要执行这两步。

```text
.
├── .github/workflows/   # Cloudflare 自动部署工作流
├── assets/previews/     # 首页游戏实机截图（WebP）
├── games/               # 单文件 3D 游戏页面
│   ├── cs.html
│   ├── flappy.html
│   ├── kart.html
│   ├── ace.html
│   ├── prism.html
│   └── ironcore.html
├── scripts/             # 静态站点构建脚本
├── index.html           # 游戏合集首页
├── cloudflare.config.ts # Cloudflare Workers 配置
├── wrangler.config.ts   # Wrangler 静态资源配置
└── package.json
```

首页每张游戏卡片顶部提供可点击的实机截图，并支持中英文图片说明。`assets/previews/` 中的图片来自对应游戏的实际 Three.js 渲染画面，统一为 960 × 540 的 WebP；游戏页面本身不依赖这些首页预览图。更新截图时需将图片加入 Git，构建才会收集它们。

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

4. 将部署配置推送到 `main`，或者在 **Actions → Site validation and deployment → Run workflow** 中选择 `main` 手动运行。
5. 在成功运行的 **Deploy to Cloudflare** 步骤日志中查看站点地址。

### 部署规则

- `Validate site` 任务负责测试、构建和发布包 dry-run，不上传文件、不读取部署凭据；Pull Request 只运行此校验任务。
- `Deploy production (main only)` 是独立的正式部署任务，仅在 `main` 的 push 或手动运行事件中、且校验任务成功后执行，检出同一次运行的准确提交重新构建并部署。PR 和其他分支会跳过此任务。
- 构建脚本将所有已加入 Git 的 HTML 和 `assets/previews/*.webp` 预览图复制到 `dist/`，保留文件名及子目录结构；只部署该目录。新增 HTML 和该目录下的 WebP 无需修改工作流。如果以后增加其他独立 CSS、JS 或图片等资源，需要同步调整 `scripts/build-site.mjs` 的收集规则。
- `index.html` 为首页，各游戏的直达路径见游戏列表。不存在的路径返回 404。
- 同一分支的发布使用固定的并发组。即使工作流改名，也请保留原组名，让新旧任务继续排在同一队列，避免旧版本晚发布而覆盖新版。手动运行非 `main` 分支只校验，不更新线上站点。
- 若账户中已存在同名 Worker，部署会更新该 Worker；需要另一个站点时，先修改 `cloudflare.config.ts` 中的 `worker.name`。

### 本地校验

需要 Node.js 24（最低支持 22.18）：

```sh
npm ci
npm run build
npm run test:home
npm run test:prism
npm run test:ironcore
npx cf deploy --prebuilt --mode production --dry-run
```

以上命令无需 Cloudflare 凭据，也不会上传文件。首页检查需要先运行 `npx playwright install chromium`，会验证构建产物中的截图、中英文切换、游戏入口及桌面/平板/手机布局。依赖版本由 `package-lock.json` 固定。

如需回滚，在 Cloudflare 控制台打开该 Worker 的 **Deployments**，选择上一版本回滚；同时回退 GitHub 上对应变更，避免下一次推送再次发布问题版本。
