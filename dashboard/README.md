# 声笺 Dashboard

这是声笺的只读查看界面，展示设备状态、最近录音、转写、日报和周报。公开仓库只提供自托管源码，不连接作者的生产站点或个人数据。

## 配置

服务端需要两个环境变量：

- `DASHBOARD_API_URL`：你部署的 `dashboard-data` Edge Function URL
- `DASHBOARD_READ_TOKEN`：只用于该只读函数的独立令牌

令牌必须保存在部署平台的加密环境变量中，不能使用 `NEXT_PUBLIC_` 前缀，也不能写入仓库。Dashboard 不应持有 Supabase service-role key。

## 本地运行

```bash
npm ci
npm run dev
```

未设置环境变量时，开发模式使用明确标注的合成预览数据；生产构建不会回退到预览数据。只要数据源中含个人录音，部署者就必须在站点前配置可靠的账户访问控制。
