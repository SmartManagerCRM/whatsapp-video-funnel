# User guide (for the business owner)

**Languages**: the app is available in English, Français and العربية (the language menu is on the sign-in page and at the bottom of the sidebar; Arabic switches the whole layout to right-to-left). Your choice is remembered on that device. The chatbot has its own *Default language* under Settings, with built-in French and Arabic messages you can edit under **Messages**.

Open your private link (`…/t/<your-name>/`), sign in, and optionally **Install** the app (browser menu → Install, or the *Install app* button in the sidebar). Your WhatsApp automation keeps running on the server when the app is closed or your computer is off; the app is only your control panel. The app shows an **offline** banner when you lose internet.

**Setup** - a checklist of everything needed before going live. *Activate automation* switches the chatbot on; until then it never replies.

**Categories** - the business types customers choose from (e.g. Restaurant, Café). Toggle to hide one. Each has its own sequence.

**Video Library** - upload MP4 videos (H.264 video + AAC audio, up to 16 MB - WhatsApp's limit). Add a caption, preview, replace the file, retry the WhatsApp upload if it failed. Videos are sent as real video messages, never as links.

**Sequences** - choose a category, add videos from the library, drag to reorder (or use the arrows), set the delay after each video and an optional caption. *Preview* plays them in order; *Duplicate to…* copies a sequence to another category.

**Messages** - edit every text the bot sends (welcome, category question, continue prompt, website invitation, goodbye, …) for each language. Placeholders: `{{business}}`, `{{name}}`, `{{category}}`, `{{website}}`.

**Settings** - business name, **currency** (MENA currencies are listed first, followed by every other international currency; used for cost estimates), delivery mode: *Hybrid* (default: next video after the delay **or** immediately when the customer taps Continue), *Automatic*, *Manual*. Default delay, website link, time zone, handover rules, opt-out words, data retention, logo.

**Customers / Conversations** - search, filter, export CSV, open a timeline. In a conversation you can *Pause*, *Resume*, *Restart*, *Change category*, *Mark human-handled*, *Complete*, and *Retry* a failed one. When you reply to a customer from the WhatsApp Business app, the automation pauses by itself for that customer (resume it here). The badge shows the WhatsApp 24-hour window: **open / expiring soon / expired** - outside it the bot cannot send free messages and simply waits until the customer writes again.

**Analytics** - completion rate, customers per category, delivery counts, drop-off, failures. "Delivered" means WhatsApp delivered the message; WhatsApp does **not** tell us whether a video was watched, so the app never claims views.

**License** - shows your license type: *Lifetime* never expires; a *Limited-time* license shows its expiry date and warns you 30 days ahead. When it expires the chatbot stops until a renewal license is activated (just load the new `.smlic` file under License).

**WhatsApp** - connection status, webhook details, credentials, *Verify connection*. Tokens are never shown. **License** - your lifetime licence; load the `.smlic` file you received.

**Customer protection** - customers can send STOP (or your configured words, incl. Arabic/French) to opt out; the bot stops immediately and only restarts if they send START.

**Costs** - SmartManager has no monthly fee. Meta bills WhatsApp usage to your own business account; rates vary by country/category: <https://developers.facebook.com/docs/whatsapp/pricing>. The Analytics estimator multiplies your own rate by your presentations - it is not a quote.
