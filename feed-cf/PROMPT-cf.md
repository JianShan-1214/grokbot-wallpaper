# Do not paste this until the human gate in HANDOFF.md

The live office still reads ntfy and the relay. `CF_FEED_ENABLED` is false. Use this only after `grokbot-feed-cf` is deployed on the free plan and you have decided to dual-write.

The publish token is not in this file. Substitute it yourself when you paste. Tell the bot not to repeat the token, and never put it in `step`.

---

Keep posting status lines exactly as you do now, and also post the same JSON to the Cloudflare bus.

The bus address is the origin I will call CF (https, no trailing slash). The topic stays the one already in the dashboard link after `#`. The body is the same one-line JSON. Add this header, and only this header, using the token I paste in place of `PUBLISH_TOKEN`:

```sh
curl -sS \
  -H "Authorization: Bearer PUBLISH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"bot":"<exact name>","status":"working","step":"<task, max 80 chars>"}' \
  "CF/publish/TOPIC"
```

Do that with `working` before anything else in a turn, and with `done`, `idle`, `waiting_user` or `error` before the final reply. Valid JSON only. No secrets and no chat transcript in `step`. If the bus answers 429 or 503, do not retry in a loop; the next real status change is enough. Keep the existing ntfy or relay curl until I say to stop it. Reply with one short sentence that does not contain the token.
