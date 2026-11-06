# Cloudflare Pages（grokbot-wallpaper）

公開靜態站由 `landing/assemble.mjs` 組成，輸出 `_site`。這個檔只說明怎麼建與怎麼預覽。**不要**從這份文件或這個 repo 的自動化去部署、改 Cloudflare 設定、綁自訂網域，或把站推上 `main`。

登入 Cloudflare、在 Pages 連結這個 GitHub repo（或提供 API token）是人工關卡，留給 Shan。

## Pages 專案設定

| 項目 | 值 |
| --- | --- |
| Repo | `JianShan-1214/grokbot-wallpaper` |
| Production branch | `main`（或先用 `zh-tw` 預覽這次繁中） |
| Root directory | `/`（repo 根目錄） |
| Build command | `node landing/assemble.mjs _site` |
| Output directory | `_site` |
| 環境變數 | 不必。可選 `NODE_VERSION=20` |

建置只需要 Node，沒有套件安裝步驟。組出來的樹與 GitHub Pages workflow 相同：`/` 轉進 `/office/`（保留 hash 與 query），`/office/` 是 3D 辦公室，`/face/` 是桌布。行銷 landing 不會進 `_site`。

## 本機預覽

在 repo 根目錄：

```sh
node landing/assemble.mjs _site
npx --yes serve _site
```

沒有 `npx` 時，也可以：

```sh
python3 -m http.server 4173 --directory _site
```

然後打開：

- `http://localhost:4173/` 轉進儀表板（`/office/`），query 與 `#gbw-…` 一起留下
- `http://localhost:4173/office/` 儀表板
- `http://localhost:4173/face/` 桌布
- `/#gbw-…` 與 `/office/#gbw-…` 相同（hash 留在瀏覽器，不會送到伺服器）

`_site` 是建置產物，不要提交。

## 另一條路：wrangler（不要在這裡執行）

本機先組好 `_site`，再由人執行：

```sh
npx --yes wrangler pages deploy _site --project-name grokbot-wallpaper
```

需要 `CLOUDFLARE_API_TOKEN`，權限為 Pages:Edit。Token 是人工關卡。這份變更**沒有**執行 deploy，也沒有改 Cloudflare 帳號、專案或網域。

## GitHub Pages

`.github/workflows/pages.yml` 的 `push` 到 `main` 已暫停，只留 `workflow_dispatch`，避免和 Cloudflare Pages 同時發佈。要恢復 GitHub Pages，把 `on.push.branches: [main]` 加回去。這個暫停要等 PR 合併才會作用在預設分支上；合併前不會改線上的 GitHub Pages。

## 沒有改到的契約

繁中只動使用者看得到的文案與 `lang="zh-Hant"`。以下維持原樣：ntfy topic、hash 解析（`#<topic>`、`#<topic>@<host>`、`#<topic>&ntfy=<url>`）、`FEED_BASE`、`relay.0xcodila.com`、ntfy.sh 網址、狀態 JSON 欄位名稱、`data/demo-*.json` 的 key。機器人貼上的 `step`、`group`、名稱仍照原資料顯示（內建示範 JSON 的敘述也還是原文）。

## 狀態匯流排（另一個 Worker，預設關閉）

`feed-cf/` 是辦公室看板的免費狀態匯流排（Wrangler 專案名稱 `grokbot-feed-cf`，D1，沒有 Durable Objects）。它不屬於這個 Pages 專案。`FEED_BASE` 仍是 `https://ntfy.sh/`。看板只有在網址帶 `?cf=<Worker 來源>`，或有人把 `web/lib/feedbase.js` 的 `CF_FEED_ENABLED` 打開並填上 `CF_FEED_BASE` 之後，才會一併讀它。

不要為了這條匯流排去部署 Pages、改 DNS，或在 `wrangler.jsonc` 加上自訂網域。部署步驟與免費額度寫在 `feed-cf/HANDOFF.md`。開啟雙寫、關掉 ntfy，都要等人決定。
