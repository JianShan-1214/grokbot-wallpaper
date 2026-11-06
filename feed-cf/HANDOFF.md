# HANDOFF — WP-FEED-CF / COS-20261106-01

給協調者與 Shan。這是草稿。合併、正式部署 Pages、改 DNS、關掉 ntfy 雙寫，都還沒做，也不在這份變更裡。

## 結果

免費 Cloudflare 狀態匯流排可以餵辦公室看板。Wrangler 專案名稱：**`grokbot-feed-cf`**。儲存是 **D1**（綁定 `DB`，資料庫名稱 `grokbot-feed-cf`）。沒有 Durable Objects，沒有 KV，沒有 Rate Limiting 綁定，沒有自訂網域，沒有 route。`workers_dev` 維持可開，等人部署時才會有 `*.workers.dev` 網址，這份 PR 沒有去建立它。

`database_id` 目前是 `00000000-0000-0000-0000-000000000000`。這不是遠端資料庫。

## 架構

```text
bot  --POST /publish/<topic>-->  Worker (免費)  -->  D1
看板 --GET /snapshot------------>  Worker
看板 --GET /events?stream=sse--->  Worker   （一批就結束，15 秒後再要）
```

- 讀取密鑰仍是 hash topic。看板網址繼續用 `#<topic>`。
- 寫入多一把 `PUBLISH_TOKEN`。只放在 `wrangler secret` 或本機 `.dev.vars`。機器人自己的指令裡由人貼上，不要寫回 `step`，不要放進看板連結。
- 預設 `CF_FEED_ENABLED = false`。正式看板仍讀 relay + ntfy。`?cf=<來源>` 只讓這一個瀏覽器加讀匯流排。

SSE 不長掛。免費 Worker 每次 10 ms CPU；長連線要靠 Durable Objects 的休眠連線才划算，而 DO 的每日請求額度已經被 `grokbot-relay` 使用。所以這裡用 D1，加上短 SSE / 15 秒輪詢。

## 免費額度（2026-11-06 文件）

來源：

- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/kv/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/

| 計量 | 免費上限 | 超過時 |
| --- | --- | --- |
| Worker 請求 | 100,000 / 天 / 帳號 | Error 1027。看板留著 localStorage 上一份狀態 |
| Worker CPU | 10 ms / 次 | Error 1102。這支 Worker 只做幾次 SQL，正常到不了 |
| D1 列讀取 | 5,000,000 / 天 | 查詢失敗。Worker 回 **503** `error:"quota"` `behavior:"reject"` |
| D1 列寫入 | 100,000 / 天 | 同上，拒絕寫入，不靜默丟掉 |
| D1 儲存 | 5 GB | 要刪資料才寫得進去。12 小時加每 topic 最多約 600 行，一個辦公室到不了 |
| 自訂發布上限 | `DAILY_PUBLISH_BUDGET` 預設 2000 / UTC 日 | **429** `error:"budget"` `behavior:"reject"`。這次不寫入 |

重置都是 UTC 00:00。

一個辦公室、一天 400 則、看板開 10 小時、15 秒輪詢一次：大約 3,000 次 Worker 請求、2,000 列 D1 寫入、1 萬列讀取。請求數與 `grokbot-relay` 共用 10 萬上限。relay 自己的估計是一個活躍使用者約 160 次。

每次發布大約 5 列寫入（事件、`(topic,seq)` 索引、`(topic,time)` 索引、快照、當日計數）。文件說明索引寫入另計。2000 的自訂上限大約用掉 1 萬列，用來在帳號的 10 萬列之前停下來。

KV 每天只有 1,000 次寫入，所以不用。Durable Objects 在免費方案可用，但這次不用。

## 雙寫怎麼開（要等人）

現在預設兩條都不要切：

1. 看板：`CF_FEED_ENABLED` 是 `false`。ntfy 與 relay 照舊。
2. 機器人：繼續貼 ntfy 或 relay。`feed-cf/PROMPT-cf.md` 先不要貼給機器人。

等人要試：

1. 在自己的終端機 `wrangler login`（這份 PR 沒有登入）。
2. `npx wrangler d1 create grokbot-feed-cf`，把回傳的 id 寫進 `feed-cf/wrangler.jsonc` 的 `database_id`。不要在這之前 `deploy`。
3. `npx wrangler d1 migrations apply grokbot-feed-cf --remote`（Worker 也會在第一次請求補 `CREATE TABLE IF NOT EXISTS`）。
4. `npx wrangler secret put PUBLISH_TOKEN`。用長隨機字串。不要用 repo 裡的 `local-test-token`。
5. `npx wrangler deploy`。只要 `*.workers.dev`。不要加 route，不要改 `office.jianshan.me` 的 DNS。
6. 用 curl 對 `/publish/<topic>` 貼一筆，瀏覽器開  
   `https://office.jianshan.me/office/?cf=<workers.dev 來源>#<原來的 topic>`  
   確認看得到 bot。這一步會把 topic 送到該 Worker，跟現在把 topic 送到 ntfy 一樣。
7. 雙寫：同一份 JSON，一筆打 ntfy（或 relay），一筆打 `/publish/<topic>`。看板在 `?cf=` 開啟時，3 分鐘內相同 JSON 只畫一次。
8. 看一週的 `/health`：`budget.used` 與 Cloudflare 後台的請求數。
9. 要改預設，才改 `CF_FEED_BASE` 與 `CF_FEED_ENABLED`，再部署 Pages。那是另一個人工關卡。
10. 確認看板只靠匯流排也夠之後，才停 ntfy 的 curl。這一步是 Shan 的關卡。

## 相容

- 舊的 `bot` / `status` / `step`，以及 `roster`、`looks`、`groups`、`chat`、`type:"usage"`、`routines`、`check`，原樣進 D1，也原樣進現有的 `web/feed.js` reducer。
- 可選 `type` / `peer` / `summary` / `ts` 會存下來，snapshot 會帶出解析後的欄位。目前主線的 `web/lib/state.js` 仍會略過未知 `type`（不是 `usage` / `schedule` / `activity` / `event` 的整行不更新狀態）。這是既有行為。帶 `type` 的新行要等 WP-OFFICE-B2 那支看板合併之後，機器人才應該開始送。這份 PR 不改頭像、不改那個 reducer。
- 沒有 `type` 的舊行照常讓 bot 出現。測試蓋過這條。
- 單一字串超過 500 字會 400。正常 `step`（契約 80 字）不受影響。這是為了不收整段聊天。

## 本機怎麼證明

見 `evidence/NOTES.md`。`npm test` 在沒有 ntfy 的情況下，把一筆狀態送進辦公室的 reducer，看得到 bot、用量與 routine。

## 殘餘風險

- Worker 請求與 relay 共用每日 10 萬。這支 Worker 若跟 relay 部署在同一個免費帳號，要一起看用量。
- 自訂 2000 是軟牆，並行的兩筆可能多過一點。之後是 429，不是靜默丟棄。
- topic 仍是讀取密鑰。拿到 topic 的人讀得到狀態，但沒有 token 就不能寫，也不能燒 D1 寫入額度。
- `?cf=` 會把 topic 送到該主機。只填自己的 Worker。
- 沒有在正式帳號跑過 `wrangler deploy`。本機是 Miniflare / workerd 的 D1。遠端 D1 要等人做完上面的 1–6 步才算接通。
- 長掛的 SSE 沒有做。更新間隔大約 15 秒，不是手機推播。
