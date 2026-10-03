# 更新紀錄

## [Unreleased]

### 修正
- 修正 VS Code Copilot Chat 設定範例的 API 類型，整理跨平台設定路徑與 Markdown 格式。

### 變更
- 將本機代理連接埠由 `3000` 改為 `43187`，降低與常見開發服務衝突的機會。

### 新增
- 新增 `.gitignore`，排除套件、環境設定、日誌、測試產物與本機任務狀態。
- 新增本機 OpenCode Go 代理，補入缺少的 Session Header，支援串流轉發與 CORS 預檢。
