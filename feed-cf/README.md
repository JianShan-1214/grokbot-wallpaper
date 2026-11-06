# grokbot-feed-cf

辦公室看板的狀態匯流排。跑在 **Workers 免費方案 + D1**。Wrangler 專案名稱是 `grokbot-feed-cf`。

這份變更沒有部署、沒有建立遠端 D1、沒有改 DNS、沒有開任何付費方案。`wrangler.jsonc` 裡的 `database_id` 是全零占位，等人執行 `wrangler d1 create` 之後才換上真的 id。

## 為什麼是 D1，而不是 KV 或 Durable Objects

文件核對日：2026-11-06（Workers limits、D1 pricing、KV pricing、Durable Objects pricing）。

| 產品 | 免費方案重點 | 這條匯流排 |
| --- | --- | --- |
| Workers | 每天 100,000 次請求，每次 CPU 10 ms。超過回 Error 1027 | 使用 |
| D1 | 每天 500 萬列讀取、10 萬列寫入、總共 5 GB。超過後查詢失敗，存檔還在，UTC 午夜重置 | 使用 |
| KV | 每天 10 萬次讀、**1,000 次寫** | 不用。1,000 次寫比已經用完的 ntfy 250 則還容易撞牆 |
| Durable Objects | 免費方案有 SQLite 後端，每天 10 萬次請求 | 不用。現有 `grokbot-relay` 已經在用同一帳號的 DO 請求額度 |

SSE 是**一批就結束**的回應，帶 `retry: 15000`。瀏覽器若用 EventSource 會自己重連。看板用同樣的短請求輪詢。不把連線掛在 Worker 上，因為免費方案每次只有 10 ms CPU，也沒有用 DO 的 hibernate WebSocket。

## API

房間仍是 hash 裡的 topic（`^[A-Za-z0-9_-]{6,64}$`）。讀取只要知道 topic。寫入要另外的 `PUBLISH_TOKEN`（`wrangler secret put`，或本機 `.dev.vars`）。Token 不進 git、不進看板網址。

JSON 本體與現在貼給 ntfy 的那一行相同，最多 4096 bytes。任一字串欄位超過 500 字會被拒絕，避免把整段對話寫進來。`bot` / `status` / `step`、既有的 `roster` / `looks` / `groups` / `chat` / `usage` / `routines` / `check` 都照原樣保存。可選的 `type` / `peer` / `summary` / `ts` 也原樣保存，不依賴它們是否已經合併進看板。

```sh
curl -sS \
  -H "Authorization: Bearer $PUBLISH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"bot":"X Writer","status":"working","step":"drafting a post"}' \
  "$CF_ORIGIN/publish/$TOPIC"
```

也可以 `POST /publish?topic=$TOPIC`，或在 JSON 裡多一個 `topic` 欄（存進去的本體不會被改寫）。

| 請求 | 回應 |
| --- | --- |
| `POST /publish/<topic>` | `200` `{ok,id,time,topic,event:"message",message}` |
| `GET /snapshot?topic=` | 每個 bot 最新一筆狀態，加上最新的 roster / looks / groups / chat / usage / check / routines |
| `GET /events?topic=&since=` | `since` 之後的行。`since` 可以是序號、`12h`、`30m`、unix 秒 |
| `GET /events?topic=&since=&stream=sse` | 同一批，SSE，然後結束。`retry` 是 15 秒 |
| `GET /health` | 免費額度、自訂每日發布上限、今天已用次數 |

錯誤時 JSON 都有 `behavior: "reject"`。不把失敗假裝成成功。

| 情況 | HTTP | 行為 |
| --- | --- | --- |
| token 錯 | 401 | 拒絕，不寫入 |
| 還沒設定 token | 503 `unconfigured` | 拒絕 |
| 自訂每日上限（預設 2000）用完 | 429 `budget` | 拒絕。`Retry-After` 指到下一個 UTC 午夜。這次不寫入 |
| D1 免費列數用完 | 503 `quota` | 拒絕。等 UTC 午夜，或人決定（這份 PR 不升級付費） |
| Worker 每天 10 萬次請求用完 | Cloudflare Error 1027 | 請求到不了 Worker。看板留著瀏覽器裡上一份狀態 |
| 本體超過 4096 bytes | 413 | 拒絕 |
| topic 不符或某一字串超過 500 字 | 400 | 拒絕 |

自訂上限 `DAILY_PUBLISH_BUDGET` 預設 2000，是為了在撞上帳號的 D1 10 萬列寫入之前先停。一行發布大約 5 列寫入（事件列、兩個索引、快照、當日計數；文件寫索引寫入另計）。2000 次大約 1 萬列，離 10 萬還有距離。不要把這個數字調到「無上限」。

## 看板

`web/lib/feedbase.js`：

- `FEED_BASE` 仍是 `https://ntfy.sh/`
- `CF_FEED_ENABLED` 預設 `false`
- `CF_FEED_BASE` 預設空字串

打開方式（不會打到正式 Pages，除非人自己部署）：

```text
/office/?cf=http%3A%2F%2F127.0.0.1%3A8787#gbw-cfstage01
```

`?cf=0` 強制關閉。`?cf=` 跟 `?feed=` 一樣會把 topic 送到你填的主機，不要貼到不信任的網址。

雙讀開啟時，3 分鐘內 ntfy 與這條匯流排上完全相同的 JSON 只算一次。預設關閉時，ntfy 與 relay 的合併跟以前一樣。

## 本機

```sh
cd feed-cf
npm install
cp .dev.vars.example .dev.vars   # 換成自己的長隨機字串
npm test                         # 不連正式帳號
npx wrangler dev --port 8787 --ip 127.0.0.1
```

`npm test` 會對本機 D1 做：帶 token 的 POST、snapshot、SSE、看板 reducer 在沒有 ntfy 的情況下看得到 bot、超長拒絕、每日上限 429。

`npx wrangler deploy --dry-run` 只打包。不要加 `--remote`，不要 `d1 create`，不要 `deploy`。

## 額度粗算（一個辦公室）

假設一天 400 則狀態、看板開 10 小時、每 15 秒抓一次：

| 項目 | 大約用量 | 免費上限 |
| --- | --- | --- |
| Worker 請求 | 約 3,000（2,400 次輪詢 + 400 次發布 + 重新整理） | 100,000 / 天，**與同帳號的 relay 共用** |
| D1 寫入 | 約 2,000 列 | 100,000 / 天 |
| D1 讀取 | 約 1 萬列 | 5,000,000 / 天 |

看板若 24 小時開著，輪詢大約 5,800 次，加上發布仍遠低於 10 萬。relay 自己的 README 估計一個活躍使用者大約 160 次 Worker 請求。兩邊加起來仍然在免費方案裡。真正先撞牆的是「很多人同時把看板開整天」或「自訂 2000 則發布上限」。

詳細開關順序見 `HANDOFF.md`。
