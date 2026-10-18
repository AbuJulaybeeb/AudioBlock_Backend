# oEmbed

**Related:** `GET /api/embed/song/:id`, `GET /api/embed/album/:id` (embeddable player data)

Platforms such as Discord, Notion, WordPress, Medium and Slack discover rich embeds through [oEmbed](https://oembed.com/). The backend exposes a public provider endpoint so a shared AudioBlocks link renders as a playable card.

## Endpoint

```
GET /api/oembed?url=<listener app song/album URL>&maxwidth=&maxheight=&format=json
```

| Parameter   | Required | Description                                                               |
| ----------- | -------- | ------------------------------------------------------------------------- |
| `url`       | Yes      | Listener app URL: `https://<host>/song/:id` or `https://<host>/album/:id` |
| `maxwidth`  | No       | Maximum iframe width in pixels (default player width is 480)              |
| `maxheight` | No       | Maximum iframe height in pixels (default 180 for songs, 400 for albums)   |
| `format`    | No       | `json` (default). Any other value, including `xml`, returns `501`         |

### Response

`200` with a `rich` oEmbed response:

```json
{
  "version": "1.0",
  "type": "rich",
  "provider_name": "AudioBlocks",
  "provider_url": "https://listen.example.com",
  "title": "Song title",
  "author_name": "Artist Name",
  "author_url": "https://listen.example.com/artist/<artistId>",
  "thumbnail_url": "https://cdn.example.com/cover.jpg",
  "html": "<iframe src=\"https://listen.example.com/embed/song/<id>\" width=\"480\" height=\"180\" frameborder=\"0\" allow=\"autoplay\" title=\"Song title\"></iframe>",
  "width": 480,
  "height": 180
}
```

The iframe points at the listener app's player page, `/embed/song/:id` or `/embed/album/:id`, on the same host as the requested URL. Cover art dimensions are not known to the backend, so `thumbnail_width` and `thumbnail_height` are omitted.

### Errors

| Status | When                                                                        |
| ------ | --------------------------------------------------------------------------- |
| `400`  | Missing or malformed `url`, not a song/album path, or host not allow-listed |
| `404`  | Unknown, not-ready, flagged or taken-down song, or unknown album            |
| `501`  | `format` is anything other than `json`                                      |

### Caching

Successful responses carry an `ETag` and `Cache-Control: public, max-age=300`, and `If-None-Match` is honored with `304 Not Modified`.

## Configuration

Only AudioBlocks listener-app hostnames are resolved. The allow-list is built from the hosts of `APP_URL` and `FRONTEND_URLS`

If none are configured every request is rejected with `400`.

## Discovery tag

For platforms to find the endpoint, the listener app must add this tag to the `<head>` of every song and album page:

```html
<link
  rel="alternate"
  type="application/json+oembed"
  href="https://api.example.com/api/oembed?url=https%3A%2F%2Flisten.example.com%2Fsong%2F<id>&format=json"
  title="Song title"
/>
```

`href` is the `/api/oembed` URL with the page's own URL percent-encoded in `url`.
