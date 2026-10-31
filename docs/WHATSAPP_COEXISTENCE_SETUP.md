# WhatsApp Cloud API + Coexistence setup

**Important status note.** This product verifies and uses a Coexistence connection; it does **not** implement Meta's Embedded Signup UI.
Onboarding is *administrator-assisted* (by the platform owner together with the client). Never treat a number registered as an ordinary Cloud API number as Coexistence:
the dashboard distinguishes `connected` (API works) from `coexistence_verified` (`is_on_biz_app = true`).

> Everything in this file about Meta's endpoints, fields, permissions and review process reflects Meta's documentation as understood when this was written.
> Meta changes it often. Re-check <https://developers.facebook.com/docs/whatsapp/embedded-signup/custom-flows/onboarding-business-app-users> before relying on any detail.

## Prerequisites (manual, outside this repo)
1. The **client's own** Meta Business Account (verified as Meta requires), WhatsApp Business Account (WABA) and a number already used in the **WhatsApp Business app** (Coexistence supports specific countries/app versions - check Meta's list).
2. A Meta developer **App** with the WhatsApp product. Permissions `whatsapp_business_messaging` and `whatsapp_business_management` need **App Review**/Advanced Access for production traffic to real customers.
3. The client **pays Meta directly** for conversations/templates; you never collect or pay Meta charges on their behalf. Pricing: <https://developers.facebook.com/docs/whatsapp/pricing> (rates vary by country/category and are not hard-coded here).

## Onboarding (administrator-assisted)
1. Complete Meta's Coexistence onboarding for the client's number (Embedded Signup coexistence flow: the client scans the QR with their WhatsApp Business app). Ownership stays with the client's WABA.
2. Obtain: **App ID**, **App Secret**, **WABA ID**, **Phone Number ID**, and a **System User access token** (long-lived) with the two permissions above.
3. In the client's PWA → **WhatsApp**: copy the **Callback URL** and **Verify token**; in the Meta App Dashboard → WhatsApp → Configuration set them, then subscribe the fields:
   `messages`, `smb_message_echoes`, `smb_app_state_sync`, `history`, `account_update`.
4. Enter the credentials in the PWA and **Save** (tokens are AES-GCM encrypted before storage; browsers never get them back). Press **Verify connection**:
   * Calls `GET /{phone-number-id}?fields=display_phone_number,verified_name,platform_type,is_on_biz_app` and `GET /{waba-id}/subscribed_apps`.
   * `is_on_biz_app = true` → status **coexistence verified**. `false` → only **connected**. Bad token → **token invalid**. Missing webhook fields → **webhook incomplete**.
   * The number is bound to the license; a different number later needs owner approval.
5. **Setup** page → all checks green → **Activate automation**. Until then nothing is ever sent.

## Behaviour with the WhatsApp Business app
* Echoes (`smb_message_echoes`) of messages the human sends from the Business app are stored as *human* messages and **never** treated as customer input.
* Default handover rule: a human reply pauses the sequence (`HUMAN_HANDLING`), cancels pending jobs and bumps the run version so stale timers can't send. Resume manually, or set an automatic timeout in **Settings**.
* `smb_app_state_sync` contact events only fill in customer names. `history` events are stored and never auto-replied to.

## 24-hour window
Free-form messages and videos are only sent within 24 h of the customer's last message. After that the sequence **pauses** (`PAUSED / window_expired`); when the customer writes again it resumes
automatically. If the client configured an *approved template* name in Settings it is sent once (tracked as kind `template`) - nothing else is sent outside the window.

## Real integration test procedure (to be executed by a human - not yet done)
Use a Meta test environment or a spare coexistence number:
1. Complete the steps above; verify the PWA shows *coexistence verified* and the webhook indicator turns to "receiving" after you message the number.
2. From a personal phone message the number → expect welcome text + category list. Select a category → expect video 1 as a playable video message and a *Continue* button (hybrid).
3. Tap **Continue** → video 2 immediately; wait the delay → next video without tapping. Finish → website invitation, URL, goodbye. Conversation shows `COMPLETED`.
4. Reply from the WhatsApp Business app mid-sequence → conversation goes to *Human handling*; no more videos. Resume → continues.
5. Send `STOP` → opted out; send `START` → fresh presentation. Wait >24 h mid-sequence → paused; message again → resumes.
6. Check delivery ticks update the message statuses (sent → delivered → read) in **Conversations**.
7. Record any payload that differs from what `worker/src/whatsapp/webhook.ts` expects (esp. `smb_*` fields, error codes `131047`/`131053`) and fix the parser; add the real payload as a test fixture.

Only after this passes may you say the real integration works. The automated tests use a mocked Meta API.
