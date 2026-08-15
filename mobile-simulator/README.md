# iPhone 手机模拟器

这是一个零依赖、设备本地优先的 PWA，用 iPhone 麦克风模拟 StickS3 的录音、离线队列、幂等上传和番茄钟流程。当前云端、转写、结构化与 Notion 步骤均为本地模拟，不会调用外部服务。

## 已实现

- 浏览器真实麦克风采集。
- 转换为 16 kHz、16-bit、单声道 PCM WAV。
- WAV 与 metadata 在同一 IndexedDB 记录中提交。
- 单条录音最长 60 秒，本地待同步队列上限 6 MB。
- 离线队列、页面恢复和手动同步。
- 响应丢失与错误 `event_id` 故障注入。
- 本地 Fake Cloud 幂等去重及处理状态推进。
- 番茄钟、暂停恢复、重启中断与 `session_id` 语音备注。
- Service Worker 应用外壳缓存。

## 电脑本地预览

在项目根目录运行：

```bash
python3 -m http.server 4173 --directory mobile-simulator
```

然后在电脑打开 `http://localhost:4173`。`localhost` 可用于页面与队列验证。

## iPhone 注意事项

iPhone 从电脑局域网地址访问时必须使用受信任的 HTTPS，普通的 `http://192.168.x.x:4173` 无法启用麦克风。HTTPS 接入将在用户授权安装本地证书工具或使用临时安全隧道后完成。

录音仅保存在当前站点的浏览器存储中。清除 Safari 网站数据或卸载对应主屏幕 Web App 会删除尚未同步的模拟数据。
