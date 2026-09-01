# @poppincn/dsh-popup-capture

`@poppincn/dsh-popup-capture` 是一个独立的 DeepSeek Harness（DSH）视频抓取插件。它注册 `popup_capture` Tool；每个合法请求都会启动一个异步 `popup-capture` DSH Job，最终通过 `job_output` 返回符合 v1 JSON Schema 的 `CapturedVideoSet` 和 `ArtifactRef`。

## 发布与使用边界

- 本插件源码在个人私有仓库 `Rust-7/video-capture-dsh-plugin` 中维护，仅供获授权的公司内部开发组成员使用。
- 已验收的 `0.1.1` 稳定安装包仍通过原私有仓库 `poppincn/popup` 的 GitHub Release 分发；本源码仓库当前不发布新的 tag、Release 或 Registry 包。
- 本插件不会发布到 npmjs、GitHub Packages 或其他 Registry。npm tarball 只是 DSH 可安装的发布载体。
- 软件和文档采用内部专有许可，详见包内 `LICENSE`。不得把 Release 资产复制到未授权位置或提供给第三方。
- 只能抓取调用者拥有或已明确获得下载、处理和存储授权的视频。
- 插件之间不得直接调用或共享内部路径。下游插件只能通过 DSH Tool/Job/Session Event 和版本化 `ArtifactRef` 接收结果。

- 稳定内部版本：`0.1.1`
- 稳定 Release tag：`capture-v0.1.1-internal`
- 独立仓库运行时代码基线：`poppincn/popup@81696f892a0da825fdd2eac5d58ce9883cfbedce`

## 工作方式

1. 调用方向 `popup_capture` 提交 1～3 个互不重复、无用户名密码的 HTTPS 视频链接。
2. Tool 校验请求并立即返回 `queued`、`run_id` 和 DSH `job_id`。
3. 插件内部的 yt-dlp 适配器在 DSH Job 中下载视频并写入配置的 Artifact 根目录。
4. 调用方使用 DSH `job_output` 读取最终 JSON。
5. 成功视频只通过 `ArtifactRef v1` 暴露；其他 Popup 业务插件不是本插件的依赖。

## 1. 前置条件

### 1.1 访问权限

安装者必须：

- 使用自己的 GitHub 账号获得源码仓库 `Rust-7/video-capture-dsh-plugin` 的读取权限；下载既有稳定包时还需具备 `poppincn/popup` 的读取权限；
- 按公司要求完成 GitHub SSO/2FA；
- 使用浏览器登录下载，或在本机执行 `gh auth login`；
- 不共享个人 Token，也不把 Token 写入 README、脚本、环境文件、聊天或日志。

### 1.2 DSH 与 Node

- Node.js `>=20.9.0`；
- 可用的 `dsh` CLI 和 pnpm；
- 目标 DSH 运行时满足以下 peer 依赖：
    - `@deepseek-ai/cordis@^4.0.1`
    - `@deepseek-ai/dsh-tools@^0.1.0-rc.6`
    - `@deepseek-ai/dsh-jobs@^0.1.0-rc.6`

在 PowerShell 中检查：

```powershell
node --version
pnpm --version

$dsh = (Get-Command dsh -ErrorAction Stop).Source
& $dsh --version
& $dsh --help
```

如果 `dsh` 不在 `PATH`，请把 `$dsh` 设置为当前 DSH 部署提供的 `dsh.CMD` 绝对路径。不要把 Popup 源码仓库中的开发链接当作生产安装。

### 1.3 下载运行时

生产抓取需要在 DSH 宿主机上单独部署：

- yt-dlp；
- Deno；
- FFmpeg 与 FFprobe；
- 抖音 managed-edge 模式还需要系统 Microsoft Edge。

```powershell
Get-Command yt-dlp.exe, deno.exe, ffmpeg.exe, ffprobe.exe
Get-Item "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" |
  Select-Object FullName, VersionInfo
```

这些程序不包含在 `.tgz` 中。安装或升级宿主机运行时后，应重新执行本文的注册检查和冒烟测试。

## 2. 下载并校验稳定包

从原私有仓库 `poppincn/popup` 的稳定 Release 页面下载已验收的 `0.1.1`：

- `poppincn-dsh-popup-capture-0.1.1.tgz`
- `SHA512SUMS.txt`

也可以使用已登录的 GitHub CLI：

```powershell
$releaseDir = Join-Path $PWD "capture-v0.1.1-internal"

gh auth status
gh release download capture-v0.1.1-internal --repo poppincn/popup --pattern "poppincn-dsh-popup-capture-0.1.1.tgz" --pattern "SHA512SUMS.txt" --dir $releaseDir
```

安装前必须校验 SHA-512：

```powershell
$releaseDir = Resolve-Path ".\capture-v0.1.1-internal"
$tarball = Join-Path $releaseDir "poppincn-dsh-popup-capture-0.1.1.tgz"
$checksumFile = Join-Path $releaseDir "SHA512SUMS.txt"

$actual = (Get-FileHash -LiteralPath $tarball -Algorithm SHA512).Hash.ToLowerInvariant()
$expected = ((Get-Content -LiteralPath $checksumFile -Raw) -split '\s+')[0].ToLowerInvariant()
if ($actual -ne $expected) {
  throw "Capture package SHA-512 mismatch."
}

"SHA-512 verified: $actual"
```

校验不一致时停止安装，并重新从批准的私有 Release 下载。

## 3. 接入 DSH

### 3.1 安装到新 profile

`dsh plugin` 会在 profile 首次使用时初始化目录。选择 DSH 已支持的 `web` 或 `headless`，或者团队已设计好的其他 profile：

```powershell
$profile = "web"
$dsh = (Get-Command dsh -ErrorAction Stop).Source

& $dsh plugin --profile $profile add $tarball
if ($LASTEXITCODE -ne 0) { throw "DSH plugin installation failed." }
```

`web` 和 `headless` 使用 DSH 自带模板；其他新 profile 由 `dsh plugin` 创建默认目录，但应用层和模型配置仍需遵守团队的 DSH profile 设计。

### 3.2 安装到既有 profile

对既有 profile 使用同一命令：

```powershell
$profile = "web"
& $dsh plugin --profile $profile add $tarball
```

DSH 会把 tarball 作为 profile 依赖安装，并根据包内 `dsh.bundle.patch = "./cordis.patch.yml"` 自动把 `@poppincn/dsh-popup-capture` 加入 `dsh.profile.bundles`。不需要复制源码、手工编辑 profile manifest 或修改 DSH 核心。

### 3.3 检查安装和 patch

```powershell
& $dsh plugin --profile $profile list --depth 0
& $dsh --profile $profile --dump-config | Select-String -Pattern "popup-capture|artifactRoot|ytDlpExecutable|douyinCredentialMode|douyinManagedRoot" -Context 2,8
```

预期：

- 依赖列表包含 `@poppincn/dsh-popup-capture@0.1.1`；
- composed config 包含 id `popup-capture`；
- package row 名称为 `@poppincn/dsh-popup-capture`；
- `cordis.patch.yml` 的环境变量表达式已进入配置树。

`--dump-config` 证明 patch 组合，不等同于插件已经完成运行时启动。还必须重启 profile 并检查 Tool 注册。

## 4. 生产配置

环境变量必须设置在实际启动 DSH 的账户和进程环境中。以下 PowerShell 示例只影响当前会话；Windows 服务、容器或 CI runner 应使用其受控的密钥与环境配置机制。

### 4.1 通用配置

```powershell
$artifactRoot = Join-Path $env:LOCALAPPDATA "Popup\artifacts\capture"
New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null

$env:POPUP_CAPTURE_ARTIFACT_ROOT = $artifactRoot
$env:POPUP_CAPTURE_YT_DLP_EXECUTABLE = (Get-Command yt-dlp.exe -ErrorAction Stop).Source
```

| 环境变量                               | 默认值                     | 说明                                                 |
| -------------------------------------- | -------------------------- | ---------------------------------------------------- |
| `POPUP_CAPTURE_ARTIFACT_ROOT`          | `.popup-artifacts/capture` | 视频 Artifact 根目录；生产环境建议使用明确的绝对路径 |
| `POPUP_CAPTURE_YT_DLP_EXECUTABLE`      | `yt-dlp.exe`               | yt-dlp 可执行文件；不在 `PATH` 时必须使用绝对路径    |
| `POPUP_CAPTURE_DOUYIN_CREDENTIAL_MODE` | `file`                     | `file` 或 `managed-edge`                             |

### 4.2 推荐的抖音 managed-edge 模式

`managed-edge` 完成一次部署后，普通调用者只需提交获授权的抖音链接，不需要为每个视频手工保存 Cookie。插件使用系统 Edge、插件专用 profile 和抖音域名限定缓存；它不会读取个人浏览器 profile，也不会自动处理登录、验证码或 CAPTCHA。

使用启动 DSH 的同一 Windows 账号创建仓库外受保护目录：

```powershell
$managedRoot = Join-Path $env:LOCALAPPDATA "Popup\secrets\capture\douyin-managed"
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

New-Item -ItemType Directory -Force -Path $managedRoot | Out-Null
icacls $managedRoot /inheritance:r
icacls $managedRoot /grant:r "${identity}:(OI)(CI)F" "SYSTEM:(OI)(CI)F"
icacls $managedRoot
```

若 `Users`、`Authenticated Users`、`Everyone`、网络身份或其他非预期账户具有读取权限，停止部署。managed root 不得位于：

- Popup 仓库或 Artifact 根目录；
- `%TEMP%`；
- OneDrive 或其他同步目录；
- UNC/网络共享；
- 个人 Edge/Chrome `User Data`。

启用配置：

```powershell
$env:POPUP_CAPTURE_DOUYIN_CREDENTIAL_MODE = "managed-edge"
$env:POPUP_CAPTURE_DOUYIN_MANAGED_ROOT = $managedRoot
$env:POPUP_CAPTURE_DOUYIN_MANAGED_REFRESH_SECONDS = "1200"
$env:POPUP_CAPTURE_DOUYIN_MANAGED_BROWSER_TIMEOUT_MS = "45000"

Remove-Item Env:POPUP_CAPTURE_DOUYIN_COOKIE_FILE -ErrorAction SilentlyContinue
```

| 环境变量                                          | 默认值/限制            | 说明                                |
| ------------------------------------------------- | ---------------------- | ----------------------------------- |
| `POPUP_CAPTURE_DOUYIN_MANAGED_ROOT`               | 无；必须是安全绝对路径 | 专用 Edge profile、缓存和临时凭据根 |
| `POPUP_CAPTURE_DOUYIN_MANAGED_REFRESH_SECONDS`    | `1200`，最大 `1800`    | 缓存刷新窗口                        |
| `POPUP_CAPTURE_DOUYIN_MANAGED_BROWSER_TIMEOUT_MS` | `45000`，最大 `120000` | 浏览器操作超时                      |

### 4.3 file 模式

`file` 模式需要操作员提供最新的 Netscape/Mozilla Cookie 文件：

```powershell
$env:POPUP_CAPTURE_DOUYIN_CREDENTIAL_MODE = "file"
$env:POPUP_CAPTURE_DOUYIN_COOKIE_FILE = "<受保护的仓库外绝对路径>"
$env:POPUP_CAPTURE_DOUYIN_COOKIE_MAX_AGE_SECONDS = "1800"
```

Cookie 文件必须只包含抖音域名、使用专用浏览器 profile 导出、设置最小 ACL，并且不得进入 Git、Artifact、日志、截图、聊天或同步目录。插件不会调用 `--cookies-from-browser`。

### 4.4 重启 DSH

停止目标 profile 的旧进程，然后从已经设置环境变量的同一受控环境按团队现有方式重新启动。例如前台启动：

```powershell
& $dsh --profile $profile
```

若 profile 由 Windows 服务、任务计划、容器或进程管理器托管，应更新该托管环境并执行其标准重启流程，不要同时启动第二份 profile。

## 5. 检查 Tool 注册

profile 启动后，在目标 DSH 会话或 Tool 目录中确认：

- `popup_capture` 已注册；
- `job_output` 已注册；
- `popup_capture` 的生成 Schema 根级 `required` 明确包含且仅包含 `contract_version` 和 `video_urls`。

如果 `popup_capture` 不存在：

1. 再次执行 `plugin list --depth 0`；
2. 再次执行 `--dump-config`；
3. 确认已重启正确的 profile；
4. 检查 profile 是否包含提供 `tools`、`jobs` 和 `job_output` 的 DSH 基础层。

## 6. 调用 popup_capture

通过目标 DSH 会话的 Tool 调用机制调用 `popup_capture`。插件本身不新增 HTTP API，也不要求其他插件直接 import 它。

### 6.1 请求

`contract_version` 和 `video_urls` 都是必填字段：

```json
{ "contract_version": "popup.capture.request.v1", "video_urls": ["https://v.douyin.com/REPLACE_WITH_AUTHORIZED_LINK/"] }
```

输入规则：

- 只能传 1～3 个链接；
- 每个链接必须是不同的 HTTPS URL；
- URL 不得包含用户名或密码；
- 抖音分享文案应先提取其中的 HTTPS 链接，不能把整段文案作为 URL；
- 只能使用已获授权处理的视频。

### 6.2 queued 响应

```json
{
    "contract_version": "popup.capture.submission.v1",
    "status": "queued",
    "run_id": "capture-run-00000000-0000-4000-8000-000000000001",
    "job_id": "popup-capture-1"
}
```

`queued` 只表示任务已入队，不表示视频已经下载成功。必须保存 `job_id` 并读取 Job 输出。

### 6.3 读取 Job 结果

向同一 DSH agent/session 的 `job_output` 传入：

```json
{ "job_id": "popup-capture-1", "wait": true, "timeout_ms": 600000 }
```

`job_output` 的 `text` 是序列化的 `CapturedVideoSet v1` JSON，响应末尾还会显示 DSH Job 状态。不要只根据通用 Job 状态判断业务结果；应解析 `text` 并校验其中的 `contract_version` 和 `status`。

成功结果的核心结构：

```json
{
    "contract_version": "popup.capture.video-set.v1",
    "run_id": "capture-run-00000000-0000-4000-8000-000000000001",
    "job_id": "popup-capture-1",
    "status": "completed",
    "videos": [
        {
            "source_url": "https://videos.example.test/one.mp4",
            "artifact": {
                "contract_version": "popup.artifact-ref.v1",
                "artifact_id": "capture:capture-run-00000000-0000-4000-8000-000000000001:1",
                "kind": "video",
                "uri": "file:///artifacts/video-1.mp4",
                "media_type": "video/mp4",
                "byte_size": 4,
                "sha256": "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
                "metadata": { "source_url": "https://videos.example.test/one.mp4" }
            }
        }
    ],
    "failures": []
}
```

正式验收至少检查：

- `contract_version === "popup.capture.video-set.v1"`；
- `status === "completed"`，或者多链接时明确处理 `partial`；
- `videos.length > 0`；
- 每个 ArtifactRef 的 `byte_size > 0`；
- `sha256` 为 64 位小写十六进制；
- `uri` 使用 `file:`，且只由获授权的同机消费者通过 ArtifactRef 解析；
- 输出不包含 Cookie、managed root、浏览器 profile 或临时凭据路径。

## 7. 多链接与失败语义

- 全部成功：`status: completed`；
- 部分成功：`status: partial`，成功项在 `videos`，失败项在 `failures`；
- 全部失败：`status: failed`，`videos` 为空，并包含聚合 `error`。

| 错误码                                 | 默认可重试 | 处理建议                                                |
| -------------------------------------- | ---------- | ------------------------------------------------------- |
| `POPUP_CAPTURE_INVALID_REQUEST`        | 否         | 补齐 `contract_version` 和 `video_urls`，检查数量       |
| `POPUP_CAPTURE_INVALID_URL`            | 否         | 提供互不重复、无凭据的 HTTPS URL                        |
| `POPUP_CAPTURE_DOWNLOADER_UNAVAILABLE` | 否         | 检查 yt-dlp、Edge、凭据配置和安全路径/ACL               |
| `POPUP_CAPTURE_NETWORK_ERROR`          | 是         | 网络恢复后重新提交一个新 Job                            |
| `POPUP_CAPTURE_DOWNLOAD_FAILED`        | 否         | 检查链接有效性、平台校验、Cookie 新鲜度和 yt-dlp 兼容性 |
| `POPUP_CAPTURE_ARTIFACT_WRITE_FAILED`  | 否         | 检查 Artifact 根目录权限和磁盘空间                      |
| `POPUP_CAPTURE_CANCELLED`              | 是         | 确认取消原因后重新提交                                  |
| `POPUP_CAPTURE_PARTIAL_FAILURE`        | 否         | 使用成功 Artifact，并逐项处理失败链接                   |
| `POPUP_CAPTURE_ALL_FAILED`             | 否         | 查看每个 `failure.code`，不要只重试聚合错误             |
| `POPUP_CAPTURE_INTERNAL_ERROR`         | 否         | 保留脱敏元数据并交由插件维护者排查                      |

抖音的 CAPTCHA、私有/已删除视频、地域限制或平台策略变化不会被自动绕过。managed-edge 首次 yt-dlp 失败时只会强制刷新并重试一次，不会无限循环。

## 8. 升级、回滚与卸载

升级时，下载并校验新 Release 后，对同一 profile 执行：

```powershell
& $dsh plugin --profile $profile add $newTarball
& $dsh plugin --profile $profile list --depth 0
```

随后重启 profile，复查 `--dump-config`、Tool Schema，并执行一次获授权的真实链接冒烟。

回滚时，校验上一个已验收 Release 的 tarball，然后执行：

```powershell
& $dsh plugin --profile $profile add $previousTarball
```

重启并重复注册与冒烟检查。不要覆盖 GitHub Release 资产或移动旧 tag。

卸载：

```powershell
& $dsh plugin --profile $profile remove @poppincn/dsh-popup-capture
& $dsh plugin --profile $profile list --depth 0
```

卸载 tarball 不会自动删除 Artifact 或受保护凭据。撤销 managed-edge 时，应先停止相关 Job 和 DSH，确认准确的 managed root，再按公司安全流程删除该专用目录并清除环境变量；不得对宽泛目录执行递归删除。

## 9. 安全与日志

- 不记录或传播 Cookie 内容、Token、OTP、恢复码、账号密码、个人 profile、yt-dlp stdout/stderr 或真实视频内容。
- managed profile、Cookie 缓存和每 Job 临时副本都按凭据处理。
- 非抖音 URL 不会启动 Edge，也不会获得抖音凭据。
- 插件以 `shell: false` 启动 yt-dlp，忽略用户配置，禁用第三方插件目录和播放列表。
- Job 完成后不应残留 `.managed-cookies-*.tmp`、每 Job Cookie 目录或本次启动的 Edge 进程。
- GitHub 私有权限只能控制首次下载，不能阻止已下载资产被复制；内部许可、最小权限和离职/调组撤权仍然必须执行。

## 10. 契约和开发验证

包内自带全部版本化 Schema 与 fixtures：

- `contracts/capture/v1/`
- `contracts/common/v1/artifact-ref.schema.json`
- `fixtures/requests/`
- `fixtures/results/`

内部贡献者使用 Node `>=20.9.0` 和 pnpm `10.34.5`：

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm format:check
npm pack --dry-run
```

任何新的发布候选还必须另行审批版本和发布动作，并通过 GitHub 托管的 Capture CI、tarball allowlist/敏感路径检查，以及从独立仓库 `main` 构建的全新 DSH_HOME 安装与真实获授权抖音链接验收。
