# XiaoT Translate (小T翻译)

[中文文档](README.zh-CN.md) | English

A Chrome extension for **academic PDF translation** with a side-by-side bilingual reader, multi-engine translation, AI document chat, and text-to-speech export.

## Features

- **PDF document translation** — translate local/online PDFs into a bilingual side-by-side view, with translation overlay, selection and annotation support
- **Select-to-translate** — select text in a PDF reader, press `Ctrl+C` then `Alt+T` to translate via clipboard
- **Multi-engine translation** — Baidu, Volcano Engine, Tencent, cloud DeepSeek (Pro), custom OpenAI-compatible models (1–3 slots), and local models (e.g. Ollama)
- **AI document chat** — ask questions about the document using cloud DeepSeek (Pro), custom, or local models
- **Paragraph-level cache** — local cache plus a shared cloud pool, so repeated paragraphs are never re-translated
- **Translation history** — local records with optional cloud sync (Supabase account)
- **Text-to-speech export** — Baidu TTS, custom OpenAI-compatible `/v1/audio/speech` APIs, and a one-click preset for a local [CosyVoice2-0.5B](https://github.com/FunAudioLLM/CosyVoice) server
- **Share translations** — export as HTML or a long image
- **Unified settings page** — edit and test every engine/model configuration in one place, with credential reuse
- **Free & Pro tiers** — account system, quotas, and cloud features via Supabase + Cloudflare Worker

## Install

1. Download or clone this repository
2. Open `chrome://extensions` and enable **Developer mode**
3. Click **Load unpacked** and select the repository folder

## Development

```bash
npm install
npm run lint   # ESLint
npm test       # Node test runner (169 tests)
```

### Project structure

| Path | Description |
|---|---|
| `manifest.json` | Chrome MV3 manifest |
| `lib/` | Core modules: settings, translator, TTS, cache |
| `options.html/js` | Unified settings page |
| `doc-translate.html/js` | Bilingual document translation page |
| `background.js`, `content.js`, `popup.*`, `offscreen.*` | Extension entry points |
| `test/` | Node tests |

> **Cloud backend is not open-sourced.** All local features above work fully with this repository alone (bring your own API keys / local models). Account, Pro, and cloud-sync features rely on the author's hosted backend and are not required for local usage.

### Using Baidu translation

The extension ships with several translation engines. You only need to enter the credentials of the service you want, then pick that engine when translating.

1. **Get your credentials** — sign up on the [Baidu Translate Open Platform](https://fanyi-api.baidu.com/) and apply for the general text translation service. Create an app and note the **APPID** and **key** shown on the page.
2. **Fill in the settings** — open the extension's unified settings page (click **⚙️ Settings** in the popup). Under **Translation engine**, choose **Baidu (APPID + key)** and paste the APPID and key. Changes save automatically.
3. **Check it works** — click **Test translation**. A success message means the credentials are valid.
4. **Start using it** — back in the popup, select **Baidu** as the translation engine. PDF translation and select-to-translate will now use it.

Tips: the free Baidu plan has a request-rate limit, so long documents take a little longer — this is normal. Keys are stored only on your device and are never uploaded.

If your provider offers an OpenAI-compatible API, choose **Custom model** instead and fill in the endpoint, API key, and model name — no separate integration is needed.

### Using Baidu text-to-speech

The **🎧 Export audio** feature turns translated text into an MP3 you can listen to offline or share.

1. **Get your credentials** — sign in to the Baidu AI Cloud speech console, create an app, and note the **API Key** and **Secret Key**. These are separate from your Baidu translation keys.
2. **Fill in the settings** — on the unified settings page, open **Speech synthesis**, set the source to **Baidu (own keys)**, enter the API Key and Secret Key, and choose a voice and speed. Changes save automatically.
3. **Check it works** — click **Test synthesis** and listen to the sample.
4. **Export audio** — open the document translation page. After the translation is ready, click **🎧 Export audio**, choose **Baidu (own keys)** in the dialog, and click **Generate and download** to get the MP3.

Tips: long documents are synthesized paragraph by paragraph and merged into one file, so give it a moment. You can also switch to **Custom endpoint** in the dialog to use any other OpenAI-compatible speech service.

### Using a local CosyVoice2 server

Deploy [CosyVoice2-0.5B](https://github.com/FunAudioLLM/CosyVoice) locally behind an OpenAI-compatible `/v1/audio/speech` endpoint, then use the **「填入本地 CosyVoice2」** ("Fill local CosyVoice2") button on the settings page to configure it in one click. Local `127.0.0.1` endpoints need no API key.

## License

[MIT](LICENSE) © wenzelian
