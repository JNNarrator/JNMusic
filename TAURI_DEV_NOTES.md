# JNMusic Tauri 开发笔记

> 从零开始用 Tauri v2 复刻音乐播放器的经验总结。  
> 记录遇到的问题、解决方案和设计决策，方便后续参考。

---

## 目录

- [一、项目架构](#一项目架构)
- [二、Rust 代理层设计](#二rust-代理层设计)
- [三、音频播放的血泪史](#三音频播放的血泪史)
- [四、前端 UI 迁移要点](#四前端-ui-迁移要点)
- [五、桌面端 + 移动端适配](#五桌面端--移动端适配)
- [六、调试技巧](#六调试技巧)
- [七、依赖清单](#七依赖清单)

---

## 一、项目架构

```
src/                          ← Vue 3 前端
  ├── main.ts                 ← Vant + Element Plus + Pinia
  ├── App.vue                 ← 主布局（flex 容器，track-scroll 可滚动）
  ├── styles.css              ← 主题变量（深色/浅色）
  ├── config.ts               ← 后端地址配置
  ├── stores/                 ← Pinia 状态管理
  │   ├── player.ts           ← 播放器核心（audio 单例 + Media Session）
  │   ├── theme.ts            ← 主题切换
  │   └── ui.ts               ← UI 状态
  ├── utils/
  │   ├── api.ts              ← Tauri invoke 封装（get/post）
  │   └── lrc.ts              ← LRC 歌词解析
  └── components/             ← Vue 组件
      ├── TrackList.vue       ← 歌单 + 搜索 + 下拉刷新
      ├── PlayerBar.vue       ← 底部播放栏
      ├── PlayerPage.vue      ← 全屏播放器 + 歌词
      ├── LanzouAuthPanel.vue ← 蓝奏云认证
      └── BrandLogo.vue       ← 黑胶唱片 SVG

src-tauri/                    ← Rust 后端
  ├── src/
  │   ├── proxy.rs            ← HTTP 代理（api_request 命令）
  │   └── lib.rs              ← 应用入口 + 状态注入
  ├── Cargo.toml              ← reqwest + serde
  └── tauri.conf.json         ← 窗口 + 构建 + 安全配置
```

### 数据流

```
前端 invoke('api_request', { method, path, query, body })
  ↓
Tauri IPC → Rust proxy.rs → reqwest → 远程 Spring Boot 后端
  ↓
后端返回 JSON → Rust 透传 → 前端解析
```

### 音频流

```
前端点击歌曲 → playIndex()
  ↓
fetchMediaUrl(trackId) → API 获取 CDN 直链
  ↓
audio.src = cdnUrl → WebView 直接请求 CDN
  ↓
CDN 返回 200 → canplay 事件 → audio.play()
```

**关键：音频不经过 Rust 代理层**，由 WebView 直接请求 CDN。

---

## 二、Rust 代理层设计

### 为什么需要代理

Tauri 的 WebView 直接发请求会有跨域问题。后端 API 在远程服务器，让 Rust 做一层转发可以绕过 CORS，还能统一处理鉴权、超时、证书等。

### 命令定义要点

```rust
// proxy.rs — 正确的做法：用独立参数而非结构体
#[tauri::command]
pub async fn api_request(
    config: tauri::State<'_, ApiConfig>,
    method: String,        // ← 独立参数，Tauri v2 IPC 反序列化更稳定
    path: String,
    query: Option<HashMap<String, String>>,
    body: Option<String>,
) -> Result<String, String> {
    // ...
}
```

**踩坑**：一开始用 `#[derive(Deserialize)]` 的结构体接收参数，Tauri v2 IPC 反序列化 HashMap 时静默失败，命令从未进入。换成独立参数后解决。

### 状态（State）注入

```rust
// lib.rs
.manage(proxy::ApiConfig {
    base_url: String::from("https://jiangnan.88933.vip/music/"),
})
```

在 `tauri::State<'_, ApiConfig>` 中读取。注意生命周期标注 `'_`。

### 超时与 TLS

```rust
let client = reqwest::Client::builder()
    .user_agent("JNMusic/1.0")           // 某些 CDN/网关要求 UA
    .danger_accept_invalid_certs(true)    // 蓝奏云 CDN 证书链问题
    .timeout(Duration::from_secs(30))     // API 请求 30s
    .build()?;
```

音频下载的超时要设长（120s+）应对大文件慢连接。

### 注册命令

```rust
// lib.rs
.invoke_handler(tauri::generate_handler![
    proxy::api_request,
    proxy::fetch_audio_by_track,  // 可选：音频文件代理下载
])
```

---

## 三、音频播放的血泪史

这是本项目最大的坑，花了最多时间。

### 第一阶段：直接 CDN URL → 403

原始 PWA 中 `audio.src = cdnUrl` 可以播放，Tauri 中同样的代码返回 403。

**最终原因**：蓝奏云 CDN（TencentEdgeOne）做了**无 User-Agent 请求检测**——没有 User-Agent 或 User-Agent 为空时允许访问，带浏览器/cURL 默认 UA 时返回 403。

而 Tauri WebView 的 audio 元素发出的请求**不带自定义 UA**，自然就能通过。

### 第二阶段：后端代理下载 → 太慢

让 Tauri → Rust 代理 → 后端 → CDN 下载 25MB 音频再传回来。服务器带宽不够，30 秒都下不完。

### 第三阶段：后端流式传输 → Content-Type 丢失

用 `StreamingResponseBody` 边收边传，但 `Content-Type` 没设对（变成 `application/octet-stream`），audio 元素不认识。

### 最终方案

```
playIndex → fetchMediaUrl(trackId) → Rust 代理 → 后端 API
  ↓ CDN URL 返回
audio.src = cdnUrl → WebView 直接请求 CDN → 200 OK → 播放
```

**关键结论**：
1. 音频直链始终让 WebView **直接请求**，不要经 Rust 代理（慢）
2. Rust 代理只用来转发 API 请求（小数据量）
3. CDN 的 User-Agent 策略：**不加自定义 UA**，让 WebView 发默认请求

### audio 单例的最佳实践

```ts
// player.ts — 模块级单例，组件卸载不影响播放
const audio: HTMLAudioElement | null =
  typeof window !== 'undefined' ? new Audio() : null
if (audio) audio.preload = 'metadata'
```

与组件生命周期解耦，符合桌面/移动端持久播放的心理预期。

### doPlay 函数的正确写法

```ts
function doPlay(url: string) {
    audio.src = url
    audio.currentTime = 0
    
    // 不急于立即 play()，等待 canplay 事件
    // 这是跨域/慢加载 URL 时的关键
    const onReady = () => {
        audio.removeEventListener('canplay', onReady)
        loading.value = false
        audio.play()  // 此时 buffered 足够，play() 不会拒绝
    }
    audio.addEventListener('canplay', onReady)
    
    // 兜底超时：8 秒后仍没 canplay 也尝试播放
    setTimeout(() => {
        if (loading.value) {
            audio.removeEventListener('canplay', onReady)
            loading.value = false
            audio.play()
        }
    }, 8000)
}
```

### 关于 Flutter 与 Tauri 的差异

Flutter 的 HTTP 请求使用平台原生网络栈（NSURLSession / OkHttp），不发送 `Origin` 和 `User-Agent` 头。

Tauri 的 WebView（WKWebView）发送 `Origin: tauri://localhost` 等浏览器特定头。某些 CDN 会根据这些头做拦截。

**解决方向**：如果 CDN 拦截，考虑：
- 不加自定义 User-Agent（让 WebView 发默认值）
- 代理 API 请求但直连 CDN
- 或用 Tauri 插件做原生音频播放

---

## 四、前端 UI 迁移要点

### 从 Web PWA 到 Tauri 的改动清单

| 改动项 | 原因 |
|--------|------|
| 移除 `beforeinstallprompt`、PWA manifest、Service Worker | Tauri 是原生应用 |
| 移除 `selectstart/copy/cut/paste/contextmenu` 禁用 | 原生窗口不需要 |
| `fetch()` → `invoke('api_request', ...)` | 通过 Rust 代理 |
| `main.ts` 去掉 `beforeinstallprompt` 和车机检测 | WebView 只需基础初始化 |
| `index.html` 保留 Google Fonts / safe-area 适配 | 移动端 WebView 同样需要 |

### 滚动容器布局

```css
/* App.vue — 关键：只有歌单列表可滚动 */
.shell {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  overflow: hidden;
}

.stage {
  flex: 1;
  min-height: 0;
  overflow: hidden;     /* 限制子元素不溢出 */
  display: flex;
  flex-direction: column;
}

.track-scroll {
  flex: 1;
  overflow-y: auto;     /* 只有这个区域可以滚动 */
  padding-bottom: 80px;  /* 给底部 PlayerBar 留空间 */
}
```

如果 `.stage` 不设置 `overflow: hidden`，整个页面会一起滚动而不是只有歌单滚。

### 组件库选择

- **Element Plus** — 图标库（`@element-plus/icons-vue`）
- **Vant 4** — 移动端组件（Toast、Popup、PullRefresh）
- 两个库同时使用不冲突

```ts
// main.ts
import 'element-plus/dist/index.css'
import 'vant/lib/index.css'
```

---

## 五、桌面端 + 移动端适配

### 当前配置

```json
// tauri.conf.json
{
  "app": {
    "windows": [{
      "title": "JNMusic · 夜猫电台",
      "width": 1080,
      "height": 720
    }]
  }
}
```

### 移动端初始化

```bash
# 需要 Android SDK / Xcode
pnpm tauri android init
pnpm tauri ios init
```

### 移动端注意事项

1. **iOS 后台播放**：Info.plist 添加 `UIBackgroundModes = audio`
2. **Android 音频前台服务**：AndroidManifest.xml 配置 foreground service
3. **safe-area 适配**：`env(safe-area-inset-*)` 已保留在 CSS 中
4. **车机模式**：CSS 中的 `html.car-mode` 规则已保留

---

## 六、调试技巧

### 1. 看 Rust 日志

```rust
// 在 proxy.rs 中加 eprintln!，输出到启动 Tauri 的终端
eprintln!("[proxy] method={}, path={}", method, path);
```

### 2. 测试后端 API

```bash
# 直接 curl 测试，绕过 Tauri
curl -s 'https://jiangnan.88933.vip/music/api/v1/tracks?page=1&pageSize=3'
```

### 3. 启动本地后端做联调

```bash
# 后端用 H2 内存数据库 + 蓝奏云 cookie 缓存
cd /Applications/work/workspace/music
java -jar target/music-0.0.1-SNAPSHOT.jar --server.port=19001

# Tauri 改 base_url 指向 localhost
# lib.rs: .manage(proxy::ApiConfig { base_url: "http://localhost:19001/music/" })
```

### 4. 测试 CDN 直链

```bash
# 获取 CDN URL 后直接 curl 验证
FRESH_URL=$(curl -s 'https://jiangnan.88933.vip/music/api/v1/tracks/296010465/media-url' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['mediaUrl'])")
curl -sI -H 'User-Agent:' "$FRESH_URL" | head -3
```

**注意**：CDN 可能根据 User-Agent 做防盗链，测试时用空 UA。

### 5. 查看 Tauri WebView 控制台

在 Tauri 窗口按 `Cmd+Shift+I` 打开 DevTools。

---

## 七、依赖清单

### 前端（package.json）

```json
{
  "dependencies": {
    "vue": "^3.5.13",
    "pinia": "^2.2.4",
    "element-plus": "^2.8.5",
    "@element-plus/icons-vue": "^2.3.1",
    "vant": "^4.10.0",
    "@tauri-apps/api": "^2",
    "@tauri-apps/plugin-opener": "^2"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.2.1",
    "vite": "^6.0.3",
    "typescript": "~5.6.2",
    "@tauri-apps/cli": "^2"
  }
}
```

### Rust 后端（Cargo.toml）

```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-opener = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
reqwest = { version = "0.12", features = ["json"] }  # HTTP 客户端
```

### 后端 Spring Boot 新增端点

| 端点 | 用途 | 说明 |
|------|------|------|
| `GET /api/v1/tracks/{id}/media-url` | 获取 CDN 直链（含 session cookie 绑定） | 已有，不需要改 |
| `GET /api/v1/proxy/stream-audio/{id}` | 流式代理音频（备用方案） | 新增，服务器带宽不足时用 |

---

## 总结：Tauri 迁移 checklist

- [ ] 安装 `@tauri-apps/api` `@tauri-apps/cli`
- [ ] 建立 Rust 代理层（`proxy.rs`），用独立参数避免 IPC 反序列化问题
- [ ] 封装前端 `api.ts`（`invoke` → `api.get/post`）
- [ ] 迁移 stores（替换 `fetch` → `api.get`）
- [ ] 音频直链始终走 WebView 直接请求，不走代理
- [ ] 注意 CDN 的 User-Agent 策略
- [ ] CSS 布局：`height: 100dvh; display: flex; overflow: hidden`
- [ ] 移除 PWA 特有代码
- [ ] 移动端：`pnpm tauri android/ios init` + 后台播放配置
- [ ] 调试：`eprintln!` + 后端本地联调 + DevTools

---

> **最后的建议**：Tauri v2 的 Rust 代理层非常强大，但音频/视频这种大数据量请求尽量交给 WebView 直接处理。  
> 代理层只做 API 转发和轻量计算，性能瓶颈不会出现在这里。
