# copilot-gateway
一個輕量級的 Node.js 本地代理工具，專門用來解決 VS Code Copilot Chat 連接 OpenCode Go 時缺少 x-opencode-session 請求標頭導致的 400 錯誤。

## 使用方式

需要安裝 Node.js 18 或更新版本。在本資料夾執行（不需安裝 npm 套件）：

```sh
node proxy.js
```

將 Copilot Chat 的自訂 API Base 設為 `http://127.0.0.1:43187/zen/go/v1`，並使用自己的 OpenCode Go API Key。
代理原樣轉發路徑、Body 與授權標頭至 `https://opencode.ai`，支援串流回應。上游若在 60 秒內沒有送出回應標頭，代理會關閉該請求並回傳 502；標頭送出後的串流不再受這個逾時限制。

若客戶端未提供 `x-opencode-session`，代理使用本次啟動產生的固定 UUID；重啟後會更新。
這是暫時 workaround：不同對話共用備援 ID，並非官方要求的每段對話獨立 ID。客戶端已有該標頭時會保留。
服務僅監聽 `127.0.0.1:43187`；在執行終端按 `Ctrl+C` 可停止。
可用 `COPILOT_GATEWAY_PORT` 環境變數更換連接埠。查詢逾時或失敗時仍會提示改埠或停止占用程序。PowerShell 範例：

```powershell
$env:COPILOT_GATEWAY_PORT = '43188'
node proxy.js
```

Linux 範例：

```sh
COPILOT_GATEWAY_PORT=43188 node proxy.js
```

macOS 的環境變數寫法與 Linux 相同。

### Windows 與 Linux 的差異

代理的轉送、健康檢查、逾時與終端機狀態列在兩個系統上相同。不同的是啟動方式，以及連接埠被占用時怎麼查出程序。

| 項目 | Linux | Windows |
| --- | --- | --- |
| 更換連接埠 | `COPILOT_GATEWAY_PORT=43188 node proxy.js` | `$env:COPILOT_GATEWAY_PORT = '43188'`，下一行再執行 `node proxy.js` |
| 占用連接埠時 | 使用 `lsof -F`。系統需已安裝 `lsof` 並可在 `PATH` 找到 | 使用 PowerShell 的 `Get-NetTCPConnection` 與 `Get-Process` |
| 查不到占用程序時 | 仍提示改用其他連接埠或停止占用程序，結束碼為 1 | 相同 |
| VS Code 設定檔 | `~/.config/Code/User/chatLanguageModels.json` | `%APPDATA%\Code\User\chatLanguageModels.json` |

macOS 的占用查詢與 Linux 相同，都使用 `lsof -F`。

啟動後可開啟 `http://127.0.0.1:43187/healthz` 確認代理正在執行；若更換連接埠，請相應更新網址。在互動終端機中，畫面會持續顯示服務運作中、轉送次數、進行中筆數、最近上游狀態碼，以及這次等到上游回應標頭的速度。未滿 2 秒以綠色顯示「快」並附上毫秒數，達到 2 秒以黃色顯示「慢」並附上秒數。第二行是最近 20 筆的成功與失敗、這 20 筆標頭等待時間的中位數、標頭逾時次數與客戶端中斷次數。失敗包含上游 5xx、連線失敗與標頭逾時；客戶端中斷不計入失敗。成功的下一筆會清掉最近異常，但近況筆數仍保留。等待時間只算到標頭到達，不含之後的串流內容。正常為綠色，仍有異常時運作狀態改為黃色，異常訊息與 5xx 狀態碼為紅色。設定 `NO_COLOR` 時不使用顏色。轉送失敗或上游 5xx 會立刻出現在最近異常，下一筆成功轉送後清除。`Ctrl+C` 會印出已停止。輸出被導向檔案時只保留靜態啟動資訊。

## VS Code Copilot Chat 設定

在 VS Code 執行「Chat: Manage Language Models」，新增 Custom Endpoint。VS Code 會開啟 `chatLanguageModels.json`：

- Windows：`%APPDATA%\Code\User\chatLanguageModels.json`
- Windows Insiders：`%APPDATA%\Code - Insiders\User\chatLanguageModels.json`
- Linux：`~/.config/Code/User/chatLanguageModels.json`
- Linux Insiders：`~/.config/Code - Insiders/User/chatLanguageModels.json`
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

執行測試：`node --test`。Node.js 18.15 或更新版本可產生覆蓋率報告：`node --test --experimental-test-coverage`。

官方要求：https://opencode.ai/docs/go/#where-can-i-use-it
