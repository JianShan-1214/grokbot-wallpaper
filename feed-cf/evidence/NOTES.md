# WP-FEED-CF-20261106 證據

協調者可把這個目錄複製到 `/workspace/team-build/logs/deliverables/WP-FEED-CF-20261106/`。

## 身分

| 項目 | 值 |
| --- | --- |
| Wrangler 專案名稱 | `grokbot-feed-cf` |
| 方案 | Workers Free。`wrangler deploy --dry-run` 綁定只有 D1 `env.DB`（名稱 `grokbot-feed-cf`）與四個數字變數 |
| 儲存 | D1。沒有 Durable Objects、沒有 KV、沒有自訂網域、沒有 route |
| `database_id` | `00000000-0000-0000-0000-000000000000`（占位，沒有建立遠端資料庫） |
| 相容日 | `2026-11-06` |
| 超過額度 | **拒絕**（429 自訂上限，503 D1 額度，1027 是 Cloudflare 在 Worker 之前拒絕）。不靜默丟棄 |

這份 PR 沒有 `wrangler deploy`、沒有 `wrangler d1 create`、沒有改 DNS、沒有部署 Pages、沒有開啟付費方案。

## 本機指令

在 `feed-cf/`：

```sh
npm test
node --test ../server/test/index.js
npx wrangler deploy --dry-run --outdir /tmp/feed-cf-dry
```

`npm test`（2026-11-06，本機 D1，沒有連正式帳號）通過的檢查：

- `POST /publish/<topic>` 需要 Bearer token；錯 token 是 401，而且 snapshot 仍是空的
- curl 貼上 `{"bot":"CF Writer","status":"working","step":"免費匯流排測試"}` 得到 200，本體原樣回來（`publish.json`）
- `GET /snapshot` 看得到該 bot，也看得到 usage、roster、routines，以及可選的 `type` / `peer` / `summary` / `ts`（`snapshot.json`）
- `GET /events?stream=sse` 是 `text/event-stream`，含 `retry: 15000` 與同一筆狀態（`events.sse`）
- 辦公室 reducer（`web/feed.js` 的 `connectFeed`，mailboxes 為空）在沒有 ntfy 的情況下看得到 CF Writer、Quiet Bot、用量 37、routine Morning
- 壞 topic、超過 500 字的字串、超過 4096 bytes，分別是 400 / 400 / 413
- 保留上限生效；每日發布上限用完回 429 `behavior:"reject"`，該筆沒有寫進 events

`server/test/index.js`：61 通過。`FEED_BASE` 仍是 `https://ntfy.sh/`。`CF_FEED_ENABLED` 仍是 `false`。

`wrangler deploy --dry-run`：Total Upload 16.94 KiB，然後 `--dry-run: exiting now.` 沒有部署。

## 免費方案備註

- Worker 請求 100,000 / 天（與同帳號的 `grokbot-relay` 共用），CPU 10 ms / 次
- D1 讀取 5,000,000 列 / 天，寫入 100,000 列 / 天，儲存 5 GB
- KV 不用：免費方案每天只有 1,000 次寫入
- Durable Objects 在免費方案可用（SQLite），這次不用，避免再吃 relay 的 DO 每日 100,000 次請求
- 自訂 `DAILY_PUBLISH_BUDGET=2000`，先於帳號的 D1 寫入上限拒絕
- 一個辦公室、400 則/天、看板開 10 小時、15 秒輪詢：大約 3,000 次請求、2,000 列寫入。算式在 `HANDOFF.md`

## 看板怎麼看（不經過 ntfy）

```sh
cd feed-cf
cp .dev.vars.example .dev.vars   # 放入本機測試 token，不要提交
npx wrangler dev --port 8787 --ip 127.0.0.1
curl -sS -H "Authorization: Bearer <本機 token>" -H "Content-Type: application/json" \
  -d '{"bot":"CF Writer","status":"working","step":"免費匯流排測試"}' \
  http://127.0.0.1:8787/publish/gbw-cfstage01
curl -sS "http://127.0.0.1:8787/snapshot?topic=gbw-cfstage01"
```

另開一個終端機，在 repo 根目錄：

```sh
node landing/assemble.mjs _site
python3 -m http.server 4173 --directory _site
```

瀏覽器：

```text
http://127.0.0.1:4173/office/?cf=http%3A%2F%2F127.0.0.1%3A8787#gbw-cfstage01
```

畫面上應出現 **CF Writer**，狀態為工作中，步驟為「免費匯流排測試」。這個網址的 `?cf=` 只影響這個瀏覽器。預設的 `https://office.jianshan.me` 在這支 PR 合併並另行部署 Pages 之前不會改。

## 2026-11-06 本機畫面（沒有部署、沒有 ntfy）

`wrangler dev --local` 聽在 `127.0.0.1:8787`。`node landing/assemble.mjs _site` 之後用 `python3 -m http.server 4173`。對 `gbw-cfstage01` POST 一筆 `{"bot":"CF Writer","status":"working","step":"免費匯流排測試"}`，回應 200（`staging-publish.json`）。`GET /snapshot` 回同一筆（`staging-snapshot.json`，截圖 `cf-snapshot.png`）。

瀏覽器開啟

```text
http://127.0.0.1:4173/office/?cf=http%3A%2F%2F127.0.0.1%3A8787#gbw-cfstage01
```

約 1 秒後表格出現：**工作中**、**CF Writer**、步驟 **免費匯流排測試**、群組 Main floor（截圖 `cf-office-board.png`）。這一頁的 mailboxes 仍是預設的 relay 與 ntfy，但這一筆狀態只存在於本機 Worker。正式 `office.jianshan.me` 沒有被改。
