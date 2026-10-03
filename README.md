# copilot-gateway
一個輕量級的 Node.js 本地代理工具，專門用來解決 VS Code Copilot Chat 連接 OpenCode Go 時缺少 x-opencode-session 請求標頭導致的 400 錯誤。

## 使用方式

需要安裝 Node.js 18 或更新版本。在本資料夾執行（不需安裝 npm 套件）：

```sh
node proxy.js
```

將 Copilot Chat 的自訂 API Base 設為 `http://127.0.0.1:43187/zen/go/v1`，並使用自己的 OpenCode Go API Key。
代理原樣轉發路徑、Body 與授權標頭至 `https://opencode.ai`，支援串流回應。

若客戶端未提供 `x-opencode-session`，代理使用本次啟動產生的固定 UUID；重啟後會更新。
這是暫時 workaround：不同對話共用備援 ID，並非官方要求的每段對話獨立 ID。客戶端已有該標頭時會保留。
服務僅監聽 `127.0.0.1:43187`；在執行終端按 `Ctrl+C` 可停止。

## VS Code Copilot Chat 設定

在 VS Code 執行「Chat: Manage Language Models」，新增 Custom Endpoint。VS Code 會開啟 `chatLanguageModels.json`：

- Windows：`%APPDATA%\Code\User\chatLanguageModels.json`
- Windows Insiders：`%APPDATA%\Code - Insiders\User\chatLanguageModels.json`
- macOS：`~/Library/Application Support/Code/User/chatLanguageModels.json`
- macOS Insiders：`~/Library/Application Support/Code - Insiders/User/chatLanguageModels.json`

將 OpenCode Go 模型的 `url` 設為本機代理位址，並使用 `chat-completions` API 類型。`chatLanguageModels.json` 的格式範例如下：

```json
[
  {
    "name": "OpenCode Go",
    "vendor": "customendpoint",
    "apiKey": "${input:openCodeGoApiKey}",
    "apiType": "chat-completions",
    "models": [
      {
        "id": "deepseek-v4.1-flash",
        "name": "DeepSeek V4.1 Flash",
        "url": "http://127.0.0.1:43187/zen/go/v1",
        "toolCalling": true,
        "vision": true,
        "maxInputTokens": 128000,
        "maxOutputTokens": 16000
      },
      {
        "id": "gpt-6-luna",
        "name": "GPT-6 Luna",
        "url": "http://127.0.0.1:43187/zen/go/v1",
        "toolCalling": true,
        "vision": true,
        "maxInputTokens": 128000,
        "maxOutputTokens": 16000
      }
    ]
  }
]
```

第一次使用時，VS Code 會提示輸入並安全保存 API Key。模型清單與能力可能變動，請以 OpenCode Go 官方文件為準。

VS Code 官方支援 API 類型：`chat-completions`、`responses`、`messages`。請選擇同時受模型與上游端點支援的類型。

驗證：`node --test`。

官方要求：https://opencode.ai/docs/go/#where-can-i-use-it
