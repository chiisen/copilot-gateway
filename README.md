# copilot-gateway
一個輕量級的 Node.js 本地代理工具，專門用來解決 VS Code Copilot Chat 連接 OpenCode Go 時缺少 x-opencode-session 請求標頭導致的 400 錯誤。

## 使用方式

在本資料夾執行（不需安裝套件）：

```powershell
node proxy.js
```

將 Copilot Chat 的自訂 API Base 設為 `http://127.0.0.1:43187/zen/go/v1`，並使用自己的 OpenCode Go API Key。
代理原樣轉發路徑、Body 與授權標頭至 `https://opencode.ai`，支援串流回應。

若客戶端未提供 `x-opencode-session`，代理使用本次啟動產生的固定 UUID；重啟後會更新。
這是暫時 workaround：不同對話共用備援 ID，並非官方要求的每段對話獨立 ID。客戶端已有該標頭時會保留。
服務僅監聽 `127.0.0.1:43187`；在執行終端按 `Ctrl+C` 可停止。

驗證：`node --test`。

- MacOS
```bash!
~/Library/Application Support/Code/User/chatLanguageModels.json
```
```bash!
~/Library/Application Support/Code - Insiders/User/chatLanguageModels.json
```

- Windows 11
```bash!
C:\Users\chiis\AppData\Roaming\Code\User\chatLanguageModels.json
```
```bash!
C:\Users\chiis\AppData\Roaming\Code - Insiders\User\chatLanguageModels.json
```
- VS Code Copilot Chat 連接 OpenCode Go 時缺少 x-opencode-session 請求標頭導致的 400 錯誤。
```json!
"url": "https://opencode.ai/zen/go/v1",
```
改成:
```json!
"url": "http://127.0.0.1:43187/zen/go/v1",
```
```json!
[
	{
		"name": "MiniMax",
		"vendor": "customendpoint",
		"apiKey": "${input:chat.lm.secret.3243e186}",
		"apiType": "responses",
		"models": [
			{
				"id": "minimax-m3",
				"name": "MiniMax-M3",
				"url": "https://api.minimax.io/v1",
				"toolCalling": true,
				"vision": true,
				"maxInputTokens": 128000,
				"maxOutputTokens": 16000
			}
		]
	},
	{
		"name": "OpenCode",
		"vendor": "customendpoint",
		"apiKey": "${input:chat.lm.secret.14c81c73}",
		"apiType": "responses",
		"models": [
			{
				"id": "deepseek-v4.1-flash",
				"name": "DeepSeek-V4.1-Flash",
				"url": "http://127.0.0.1:43187/zen/go/v1",
				"toolCalling": true,
				"vision": true,
				"maxInputTokens": 128000,
				"maxOutputTokens": 16000
			},
			{
				"id": "gpt-6-luna",
                "name": "GPT-6-Luna",
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

官方要求：https://opencode.ai/docs/go/#where-can-i-use-it
