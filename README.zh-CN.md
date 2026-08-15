# 声笺 · M5StickS3 语音收件箱

[English](README.md)

声笺把 M5StickS3 变成一个随身语音收件箱：录下短语音，离线时可靠排队，联网后自动上传，完成转写、纠错、分类和摘要，并在只读网页中查看结果。

这是一个供自行部署的完整参考实现。仓库不包含作者的生产凭据、录音、转写、设备转储，也不提供作者私人 Dashboard 的访问权限。

## 功能

- 一键录音，支持结束、取消和 30 秒上限
- 离线队列、重启恢复和幂等上传
- 多 Wi-Fi、电池显示、自动熄屏
- 基础番茄钟
- 使用阿里云百炼/DashScope `paraformer-v2` 进行 ASR
- 使用 `qwen-turbo` 纠错，并生成标题、摘要和六类分类
- 分类包括：灵感、活动、任务、笔记、日记、待整理
- 日报和周报生成
- 可选 Notion 写入
- 使用临时签名音频地址的只读响应式 Dashboard
- 主机模拟器与自动化测试

## 架构

```text
M5StickS3 固件
  -> 带认证的幂等上传
Supabase Storage + PostgreSQL + Edge Functions
  -> ASR -> 纠错 -> 分类 -> 摘要/回顾
只读 Dashboard
```

固件负责录音、离线保存、重试和设备界面；Supabase 负责私有音频、元数据、处理状态、定时回顾与只读接口；Dashboard 只在服务端用独立读取令牌调用 `dashboard-data`，不会把 service-role 凭据发送给浏览器。

详细内容见[架构文档](docs/architecture.md)、[API 文档](docs/api.md)和[测试计划](docs/test-plan.md)。

## 目录

| 路径 | 用途 |
| --- | --- |
| `firmware/` | M5StickS3 PlatformIO 固件 |
| `supabase/` | 数据库迁移、种子数据和 Edge Functions |
| `dashboard/` | 只读 Next.js Dashboard |
| `simulator/` | Python 状态机模拟器 |
| `mobile-simulator/` | 浏览器录音模拟器 |
| `shared/` | JSON Schema 和合成样例 |
| `scripts/` | 配置、验证和公开发布审计工具 |

## 环境要求

- M5StickS3 和 USB-C 数据线
- Python 3.11+
- Node.js 22+
- PlatformIO Core
- Supabase CLI 与你自己的 Supabase 项目
- 可调用 ASR 和语言模型的 DashScope 账户
- 可选：Notion 集成凭据

云端存储、函数、转写和模型调用可能产生费用，部署前请查看服务商的最新定价。

## 快速开始

1. 把 `.env.example` 复制为本地 `.env`，只填写自己的值，绝不要提交。
2. 启动本地 Supabase 或关联自己的项目，应用迁移并按架构文档设置 Vault secrets。
3. 配置设备令牌，并在烧录前替换固件中的 Supabase 项目主机占位符。
4. 构建固件：

   ```bash
   PLATFORMIO_CORE_DIR="$PWD/.platformio-core" pio run -d firmware
   ```

5. 本地启动 Dashboard：

   ```bash
   cd dashboard
   npm ci
   npm run dev
   ```

6. 执行本地检查：

   ```bash
   make test
   make validate-json
   make public-audit
   ```

部署步骤和必需的 secrets 见[架构文档](docs/architecture.md)。生产环境不要复用示例设备 ID 或示例令牌。

## 隐私与安全

- 音频桶必须保持私有，播放只使用短期签名 URL。
- 设备、后台函数和 Dashboard 令牌职责不同，应分别生成和轮换。
- Notion 写入是可选功能；没有明确配置时保持关闭。
- 预览记录全部是合成内容，个人数据只应进入你自己的私有部署。
- 发布 fork、日志或问题报告前运行 `make public-audit`。

Dashboard 只读不等于数据可以公开。只要部署中含个人录音，就应在站点前保留可靠的账户访问控制。

## 当前限制

- 参考处理流程主要面向普通话和文档列出的 DashScope 模型。
- Wi-Fi 与云端配置需要本地配置，项目暂不包含面向普通用户的配网 App。
- 周报生成已实现，但 Cron 和 Notion 写入由部署者自行决定是否启用。
- 这是个人项目，不是医疗、财务或长期归档系统。

## 贡献与许可

提交 PR 或报告漏洞前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。

项目采用 [MIT License](LICENSE)。Copyright © 2026 Masicheng Ma。
