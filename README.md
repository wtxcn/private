# Card Offer Clickers

Tampermonkey userscripts for adding card offers by clicking each issuer's native UI.

## Scripts

- `CardOffersHub.user.js`: combined private local search for P1/P2 offer snapshots.
- `CitiOffersAssistant.user.js`: new selectable-offer assistant for Citi Merchant Offers.
- `USBankOffersAssistant.user.js`: new selectable-deal assistant for U.S. Bank.
- `AmexNativeOfferClicker.user.js`: Amex Offers helper.
- `ChaseOfferClicker.user.js`: Chase Offers helper for the currently loaded Chase Offers page.
- `CitiOfferClicker.user.js`: Citi Merchant Offers helper.
- `USBankOfferClicker.user.js`: U.S. Bank cash-back deals helper.
- `FidelityFullViewRefresher.user.js`: Fidelity Full View helper for refreshing linked institutions.

## Card Offers Hub

Install `CardOffersHub.user.js` alongside the bank assistants. It starts as a small
movable `Offer Hub` button on supported bank pages and on this repository page. Choose
whether the currently logged-in bank account belongs to P1 or P2 before scanning. A
completed Chase, Citi or U.S. Bank scan is then copied into the Hub automatically;
confirmed enrollment changes are copied as well. On Amex Offers pages, the Hub records
the currently visible addable offers for the selected card without clicking them.

The Hub combines both people and every supported bank in one search. Results show the
person, bank, masked card name, state and scan age. Filters cover P1/P2, bank and offer
state, and the current combined data can be downloaded as JSON or CSV. Full internal
card identifiers are replaced with local hashes before entering Hub storage. Logs,
selections, queues, image URLs, cookies and login information are not copied.

Hub data stays in Tampermonkey storage in the current browser profile. P1/P2 selection
is remembered separately for each bank. When changing which person's account is logged
in, switch that bank's label before running its scan so the new snapshot does not replace
the other person's saved copy. Opening a bank never starts a full scan or enrollment.

## New Citi and U.S. Bank Assistants

The new assistants are separate installations, not replacements for the old clickers.
Disable the matching old clicker before enabling the new assistant. The new assistant
refuses to start if the old clicker's stored run is active. It never imports or resumes
an old run. Opening or refreshing a page does not start scanning or enrollment.

Open the bank's offers page, then click Scan. Click an offer's image, heading or empty
area to select every scanned addable card for that offer. Click again to deselect;
individual card buttons adjust the selection. Add selected starts the selected queue
without an extra confirmation dialog. Stop cancels subsequent clicks. Refreshing the
page stops the queue; rescan and explicitly start a new queue if needed.

The Added view includes only offers confirmed added in every scanned applicable scope.
Partial offers remain Addable. An uncertain result remains Unverified, not green.
Disappearance of an enrollment button alone never counts as success. Scanning only
reads visible offer state, opens details and changes the selected card; it never enrolls.
The list is a dated snapshot, not an assertion of live account state.

- **Citi:** supports the native card select and linked listbox picker, using the old
  script's Merchant Offers tile and one-click enroll controls. Card names must be
  identifiable by masked/ending digits. The scanner waits for a changed, settled grid
  after switching cards. An unrecognized picker or unchanged grid stops that card's scan.
  Native category/filter settings and inaccessible frames can limit scan coverage.
- **U.S. Bank:** uses the old script's Offer from tiles and Activate Offer detail modal.
  The old script does not expose a per-card picker, so this version manages the visible
  **Cash-back deals collection**, not an invented card inventory. It cannot claim that
  every U.S. Bank card has an offer. Scanning opens each deal read-only to inspect its
  status, then closes its detail before continuing.

The two installable files bundle their UI, adapter and icons without remote libraries.
Only the matching bank's native controls are used; no private enrollment API is called.
Offer snapshots stay in that bank origin's localStorage. Selections and queues are in
memory, and the trash button clears the assistant's cache. No scan or account data is
sent to GitHub. The configured update URL downloads code from this repository.

### Verification and Development

The automated tests use synthetic card and merchant data. Live authenticated Citi and
U.S. Bank pages have not yet been verified for this initial release; layout changes may
require adapter updates. Generated files are built from `src/offers-assistant/`:

```sh
npm ci
npm run build
npm test
npm run check:build
```

Do not commit bank screenshots, account snapshots, cookies or real card identifiers.

## Private VPN dashboard

`CardOffersHub.user.js` can copy its already-sanitized bank, card-ending, offer and status data to a small server on the same Mac. The server keeps its data and random keys in `~/.card-offers-hub`, outside this repository.

Install or update the service:

```sh
npm run server:install
```

The installer listens only on `127.0.0.1` and the detected `100.x` VPN address. It does not listen on the Mac's ordinary Wi-Fi/LAN address. Tampermonkey pairs through localhost and automatically syncs after an offer snapshot changes. Remote readers must be connected to the same VPN and provide the random read key from `~/.card-offers-hub/config.json`.

The server validates and rebuilds every upload. It retains only supported bank names, hashed card IDs, safe card labels, offer text, status and scan time. It discards cookies, login details, full card numbers, selections, images and logs.

## Why this script exists

The direct enrollment API can hit CORS or 429 errors. The safer approach is to click the same native Amex offer buttons a person would click.

Important lessons from testing:

- Use each card's `opaqueAccountId`, not the stale card state currently shown in the page.
- After a card appears done, reload the same Offers URL and check again.
- Amex can lazy-load more offers after refresh.
- Skip checking accounts. Only process credit cards.
- A slower delay is safer. `5000ms` is a good default; `7000ms` is better after rate-limit errors.
- Amex can time out during long runs. Keep-alive is enabled by default and sends light page activity every few minutes.
- The floating panel uses low-frequency cached status updates so it does not keep scanning the whole Amex page.

## Usage

1. Install `AmexNativeOfferClicker.user.js` in Tampermonkey.
2. Open any `global.americanexpress.com` dashboard or offers page.
3. Use the floating `Amex Native Offers` panel.
4. Click `Scan Cards` to confirm detected cards.
5. Click `Add All Cards` to process all detected credit cards.
6. Leave `Keep Alive On` enabled for long runs. The default interval is `4` minutes.

The script runs card by card:

1. Open `/offers?opaqueAccountId=...`
2. Click visible native `+` buttons slowly.
3. Reload the same page.
4. Continue if more offers appear.
5. Move to the next card only after a refresh shows no more add buttons.

## Keep-alive

The panel includes a `Keep Alive On/Off` button and an interval input in minutes.

When enabled, the script periodically sends light activity to the page. If Amex shows a session prompt such as `Stay logged in` or `Continue session`, the script clicks it.

## Notes

These scripts do not make purchases or payments. They only add available offers through the visible issuer UI.

## Chase Usage

1. Install `ChaseOfferClicker.user.js` in Tampermonkey.
2. Open the Chase Offers page for the card/account you want to process.
3. Use the floating `Chase Offers` panel.
4. Click `Add Loaded Offers`.
5. To run across cards, click `Add All Cards`. The script opens account overview, scans Chase account IDs, then tries each Offers Hub.

The Chase script is intentionally conservative:

- It does not call Chase private APIs.
- It only clicks visible Chase Offers Hub tiles marked `Add offer`.
- It skips tiles already marked `Success Added`.
- It scrolls slowly to load more offers.
- It reloads once to verify whether more addable offers appear.
- It shows a timeout warning when Chase has logged out.
- `Debug Scan` logs the offer-like controls it can see without clicking them.
- `Scan Cards` stores account ID candidates found on the current Chase overview page.

## Fidelity Full View Usage

1. Install `FidelityFullViewRefresher.user.js` in Tampermonkey.
2. Open Fidelity Full View Net Worth or `Edit accounts`.
3. Click `Refresh All`; it will open `Edit accounts` if needed.
4. Optional: click `Scan Institutions` first to preview the detected institutions.

The Fidelity script is intentionally UI-only:

- It does not call Fidelity or aggregation APIs directly.
- It scans visible linked institution cards.
- It ignores individual account rows and only opens institution cards.
- It opens each institution, clicks the native `Refresh information` control, waits, then clicks `Back`.
- If Fidelity asks for credentials, MFA, or manual repair, the script stops so you can handle it.

## U.S. Bank Usage

1. Install `USBankOfferClicker.user.js` in Tampermonkey.
2. Open U.S. Bank online banking. The script can open the cash-back deals page when you click `Activate All`.
3. Use the floating `US Bank Deals` panel.
4. Click `Debug Scan` to preview visible deal cards.
5. Click `Activate All` to open each deal, click the native `Activate Offer` button, close the detail panel, and continue.

The U.S. Bank script is intentionally UI-only:

- It does not call U.S. Bank or Cardlytics APIs directly.
- It only clicks visible deal cards and native `Activate Offer` controls.
- It skips deals it has already checked during the current run.
- It scrolls slowly to load more deals.
- Keep-alive is enabled by default for long runs.
