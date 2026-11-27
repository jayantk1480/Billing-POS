# Development status

Last updated: 2026-11-25

## Current progress

**Audit, 2026-11-24.** An independent audit compared the POS with the core of Petpooja and tested every workflow:
[POS_AUDIT_REPORT.md](POS_AUDIT_REPORT.md) has the findings and the comparison, and
[POS_TEST_RESULTS.md](POS_TEST_RESULTS.md) every test run. It found and fixed 12 bugs. Most were races between two
terminals: sending to the kitchen twice, hold, cancel or merge slipping in while another till billed the order, and two
opposite merges emptying both orders. It also fixed a request budget shared by a whole outlet, which would have refused
billing at a busy lunch. The verdict: comparable to Petpooja on the online billing core, not yet as a product. Offline
billing is missing, and printing is unproven on physical printers.

Phases 1 to 7 of 9 are complete. A restaurant can be set up in the back office and billed
from the POS: orders, discounts, GST invoices, payments, refunds and receipts all work end to end.
Orders reach the kitchen display live, and the floor is laid out in the back office.
Bills and kitchen tickets print on thermal printers through the print bridge, cashiers run a cash register,
and the owner reconciles each day's payments. Offline mode (Phase 8) and deployment (Phase 9) are not built yet.

The first two pieces of selling this as a hosted product are also built: a restaurant can register itself
(or be set up by the vendor), and the vendor has an admin app to see, create, suspend and extend restaurants.
Plans, limits and collecting payment automatically are not built: a paid period is recorded by hand.

Thermal printing has been tested against printer emulators, not against a physical printer: see
"Printing" below for exactly what that covers.

## Completed modules

| Module | State | How it was checked |
|---|---|---|
| Requirements and architecture | Done | `docs/PRD_AND_ARCHITECTURE.md`, approved |
| Monorepo, local infrastructure | Done | `pnpm turbo run build typecheck test`: 24 tasks pass |
| Database schema and rules | Done | 50 tables, 11 migrations, with check constraints and triggers for the rules Prisma cannot express |
| Authentication | Done | 25 API tests |
| Users and roles | Done | 14 API tests |
| Restaurant and billing settings | Done | 16 API tests |
| Menu management | Done | 25 API tests and 2 browser tests, including adding products in bulk from a spreadsheet and deleting them in bulk |
| GST bill engine (`billing-core`) | Done | 30 unit tests: inclusive and exclusive prices, CGST/SGST/IGST, cess, discounts, service charge, rounding, amount in words |
| Orders | Done | 28 API tests: pricing from the menu, variants and modifiers, tables, discounts and manager approval, hold, cancel, merge, delete with renumbering, concurrency, tenant isolation |
| Independent testing | Done | Two testers (API and browser) reported 27 bugs; fixed, with 38 exploratory and 16 regression API tests kept |
| Owner corrections | Done | 18 API tests and 1 browser test: change payment method, delete a billed order, change the items of a billed order under the same bill number, reopen a billed order, number reuse and gaps, permissions, audit entries |
| Invoices, payments, refunds | Done | 34 API tests: gapless numbering under concurrency, split by item, immutability, PDF, split tender, duplicate and simultaneous payments, credit notes, cancellation |
| Reports and dashboard | Done | 17 API tests: each report checked against a known day of trading, reports cross-checked against each other, CSV, Excel and PDF exports, permissions, tenant isolation |
| Kitchen tickets (KOT) | Done | API tests: one ticket per station, only new items sent, cancellation tickets with reason and approval, statuses, reprints, auto-send on billing |
| Floor and tables | Done | API tests: areas, tables, layout, blocking, transfer between tables |
| Live updates | Done | API tests over a real WebSocket: kitchen, billing and menu notices; other restaurants receive nothing; invalid or signed-out sessions are refused |
| Kitchen display app | Done | 1 browser test with POS and kitchen screens side by side |
| Back office screens | Done | 11 browser tests |
| POS billing screen | Done | 6 browser tests: terminal choice, billing, cash with change, discount approval, split tender, hold, dine-in, delete and renumber, split by item, refund, lock and PIN switch |
| Cash register | Done | 12 API tests and 3 browser tests: open, cash in and out with manager approval, close against a count by notes and coins, refunds, corrected and erased bills, permissions, tenant isolation, records that cannot be changed |
| Payment reconciliation | Done | 3 API tests and 1 browser test: totals per day and method less refunds, settled amounts, changes after checking, cash in and out of registers |
| Printers, print queue and bridge protocol | Done | 16 API tests, 7 layout unit tests and 2 browser tests: printers, bridge sign-in, queue, retries, fallback printer, expiry, layouts for 58 mm and 80 mm, layouts served for a device's own printer, tenant isolation |
| Print bridge program | Done | 10 tests against a printer emulator: ESC/POS encoding, network and device printing, failures in plain words, and what the bridge refuses to print to |
| Housekeeping job | Done | 1 API test: expired sessions, spent reset links and old print jobs are removed hourly |
| Sign-up and getting started | Done | 9 API tests and 2 browser tests: registration, email confirmation, re-registration before confirming, no hint about existing accounts, a new restaurant billing its first order, isolation from other restaurants, the getting-started list, rate limits, registration switched off |
| Trial, paid period and suspension | Done | Covered in the sign-up and platform tests: read-only when the time runs out, sign-out at once on suspension |
| Platform admin API | Done | 9 API tests: its own sign-in and cookie session, refusal from any other site, lockout, listing with search, filter and sort, support view recorded in the audit log, creating a restaurant, suspend and restore, trial and paid period |
| Platform admin app | Done | 3 browser tests: sign-in, the list, adding a restaurant whose owner chooses a password from the email, recording a payment, suspending while the owner is signed in, restoring |
| POS on phones and tablets | Done | 3 browser tests: an order billed and paid on a 375 px phone, a 320 px phone and a phone held sideways, each checking that no control is cut off |
| Customers | Done | 6 API tests (one record per phone number, latest details win, records for one order alone, list figures and search, a customer's orders, lookup, permissions and tenant isolation) and 1 browser test (named at the counter, recognised by phone next time, listed in the back office with bills and amounts) |
| Audit, 2026-11-24 | Done | 31 API tests (GST against hand-worked figures, workflows A to J, two-terminal races), 3 browser tests (request traffic per bill, lost answers to Pay and to Bill & pay), and an opt-in benchmark (`PERF=1`, 90,600 bills). See POS_AUDIT_REPORT.md |

Back office screens: sign in, forgot and reset password, dashboard, reports, orders, bills, floor, products, categories,
modifiers, users, roles, restaurant, billing and GST, tax groups, kitchen stations, terminals, account,
cash registers, reconciliation, printers, customers.

POS: sign in, terminal selection, PIN lock, billing screen (search, short codes, variants and
add-ons, cart, line notes and discounts, bill discount, customer with lookup by phone number, tables), hold and resume,
running orders, split by item, payment (cash with change, UPI, card, split tender, split equally,
part payment), today's bills, reprint, PDF, refund, cancel bill (from Today's bills, or straight from
Running orders for a bill nobody has paid, with the choice of reopening the order to change it), the cash register, and receipt
printing: on a printer connected to the device itself (see "Printing"), else on the receipt printer
through the print bridge when one is connected, otherwise through the browser at 58 mm or 80 mm.
A bill prints by itself the moment it is paid in full ("Print the bill automatically", on by default).

The POS adapts to the screen. On a counter screen (1024 px and wider) the order sits beside the menu. Below
that the order slides over the menu from a bar at the bottom, the header becomes two rows, and categories
become a row of chips on phones. On a phone the table picker is a grid of buttons instead of the floor plan.
A phone held sideways gets a one-row header and a cart that scrolls as a whole. Reports from the user menu
use the same layout rules.

Every table sorts by its column headings: click once for ascending, again for descending; the arrow shows
which column and direction are in use. Orders, Bills and Products are sorted by the server, so the order
holds across all pages of the list. Users, Tax groups, Terminals, the items of a bill and every report are
sorted on the page. Empty cells always go last.

## Adding and deleting products in bulk

On Menu → Products in the back office, for anyone who may manage the menu.

- **Add in bulk** takes a CSV file, or rows copied from Excel or Google Sheets and pasted in. The first row names
  the columns: Name, Category and Price are needed; Short code, Type (veg, non-veg or egg), Tax group, Description
  and HSN/SAC are optional. "Download template" gives a starter file. Prices are in rupees.
- Before anything is saved, every row is shown with what will happen to it. A row with a mistake is skipped and
  says why; a product already on the menu (same name in the same category) is skipped; the rest are added
  together. A category that does not exist yet is created. At most 500 products at a time.
- Products added this way have no variants, add-ons or photo; those are set by editing the product. Their kitchen tickets go to the first kitchen station.
- **Deleting in bulk**: tick products (the box in the heading ticks the page, and "Select all" ticks every product
  that matches the search and filters), then "Delete selected". As with a single delete, the products leave the
  menu and past bills are not changed.
- Each bulk add and bulk delete is one entry in the audit log, listing the products.

## Test totals

| Suite | Command | Result |
|---|---|---|
| Unit | `pnpm test` | 47 pass (30 bill engine, 7 print layout in `packages/printing`, 10 print bridge) |
| API integration (real Postgres, Redis, Mailpit) | `pnpm --filter @pos/api test:int` | 381 pass; 5 benchmark tests skipped unless `PERF=1` |
| Browser end to end (Chrome) | `pnpm test:e2e` | 44 pass |
| Load benchmark | `PERF=1 pnpm --filter @pos/api test:int test/perf.int-spec.ts` | 5 pass: 6 terminals billing at once, 90,600 bills of history |

## Kitchen and floor

- **KOT** on the POS (the button was called "Send to kitchen" until 2026-11-24; F6 or F8) saves the order and creates one ticket per kitchen station, holding only what is new since the last send. **Only KOT makes kitchen tickets**: billing never sends anything to the kitchen, so an order billed without pressing KOT does not reach it (the owner's decision, 2026-11-24; before that, billing sent any unsent items).
- **Which station.** A product's ticket goes to its own kitchen station. A product with no station, or whose station is switched off, goes to the first active station in Settings, Kitchen stations: the product form calls this "Default". Only a product set to "No kitchen ticket" (bottled water, say) is left off tickets. Before 2026-11-24 the form's default was "no ticket", so products added without choosing a station never reached the kitchen; every existing product was switched to the new behaviour by the migration.
- **Taking back something already sent** (reducing or removing it, or cancelling the order) needs a reason and the `kot.cancel_item` permission or a manager PIN, and sends the station a cancellation ticket.
- **A sent item cannot be swapped** for another variant or add-on; it is removed and added again, so the kitchen sees both steps.
- **Kitchen display** (`apps/kds`): tickets oldest first, per station or all, with New → Preparing → Ready → Done, a step-back button, a "To make" tally, and an amber then red border after 10 and 20 minutes.
- **When kitchen tickets print** is a choice under Settings, Billing & GST, "Print kitchen tickets (KOT)":
  - *When KOT is pressed* (the default): the KOT button sends new items to the kitchen and prints the tickets.
  - *Don't print (kitchen display only)*: the KOT button sends new items to the kitchen display, and nothing prints.

  Bill & pay prints the bill (see below) and never a kitchen ticket.

  A ticket is printed in the same type sizes as a bill: the station name as the heading, the rest ordinary text, bold where it matters (changed 2026-11-25 at the owner's request; before, the table line and the items were taller). "Large item text" under Settings, Printers, Print layouts makes the item lines taller again for a kitchen that reads from a distance; it is off unless chosen.

  Where a ticket prints: with the print bridge connected, at its own station's printer, whoever sent it and from whichever device. Without it, on the printer connected to the billing device when one is, otherwise through the browser, one ticket per page. Stored as `autoPrintKot`, which the mobile app reads with the same meaning.
- **Floor editor** (back office → Floor): areas, tables with shape and size, drag or arrow keys to place, block a table. The POS table picker shows the same plan with live status and the running total.
- **Moving a party**: pick another free table on the POS and send; there is also an API to move a billed order.
- **Live updates** use Socket.IO over Redis. A notice carries only ids; screens then fetch through the normal API, so permissions still apply. Screens also poll as a fallback. The billing screen fetches only the lists a notice affects, once per burst of notices (one bill sends several). Measured on 2026-11-24, one bill costs 22 requests on the till that takes it and 6 on each idle till, down from 49 and 30.
- **Two terminals on one order** take turns: sending to the kitchen, billing, paying, refunding, hold, resume, cancel, merge and transfer all lock the order first (a merge locks both orders, in id order), and seating a table locks the table. So a change and a bill on two tills never interleave.

## Offline billing: groundwork (step 0 of 5, 2026-11-25)

Nothing bills offline yet. These pieces make the later steps possible, and the first one already protects online
billing:

- **Billing can be asked for again safely.** The POS gives each bill an id of its own (`invoiceIds` on
  `POST /orders/:id/invoices`, one per part of a split bill). The same ids again return the bills already issued
  instead of failing, two requests at once still make one bill, and ids that belong to another order are refused. A
  "Bill & pay" pressed again after its answer was lost now goes straight to the bill, even though the order no longer
  saves. The cart keeps the ids across a page reload (cart version 3).
- **Each device can have its own offline series.** `POST /pos/devices` registers a device by a key it keeps, and gives
  it a hidden till (`terminals.kind = OFFLINE`) with a code from Z01 to ZZZ. The bills that device makes offline will
  be numbered in that till's series (for example Z01/2627/000001), which no other device uses. Hidden tills are never
  listed, edited or signed in to, and owners can no longer create a till code starting with Z. Since step 1 the POS
  registers itself.
- **An offline series is never renumbered.** Erasing an offline bill leaves its gap, and "Reset order and bill
  numbers" leaves offline series alone, because the device may hold bills the server has not seen.
- **Billing or refunding an order from an offline till** numbers the bill or credit note in the signed-in till's
  series, never in the device's.
- **The POS bootstrap carries the print layouts and the numbering epoch**, so the POS can lay out and number without
  the server.
- **The print layouts moved into `packages/printing`**, together with `buildSeller`, so the POS can lay out bills and
  KOTs itself.

## Offline billing: the app opens offline (step 1 of 5, 2026-11-25)

Still nothing is billed offline. What changed is that the POS no longer stops at a spinner when the internet is down:
it opens as the person last signed in on the device, with the menu it last had, and carries on by itself when the
server is back.

- **The app is kept on the device.** A service worker (`apps/pos/public/sw.js`, written by hand rather than with a
  library) keeps the current build's page, scripts, styles and fonts, which it reads from the page itself. The page
  comes from the network when it answers within 4 seconds, otherwise from the kept copy. It never keeps answers from
  the API. It runs only in a production build (`next build`, `next start`) and, as browsers require, only over HTTPS or
  on localhost; `next dev` removes any worker left on its address. Each build registers it under its own build id
  (`POS_BUILD_ID`, or the build time), so a deploy replaces the kept copy.
- **The person signed in is remembered.** The POS keeps who is signed in, as the server last described them and never
  a token, in `localStorage` (`pos.session`). Opened without the server, it opens as them, marked offline. When the
  server answers, the sign-in is confirmed through the refresh cookie, or ended if it ended meanwhile. The record is
  forgotten on signing out, on locking, and after 5 days without contact with the server (`OFFLINE_DAYS`). With nobody
  remembered, the POS says "Cannot reach the server" and moves on by itself once it can.
- **The menu is kept on the device.** Every bootstrap answer is saved in IndexedDB (Dexie, database `pos-offline`), per
  restaurant and till. Without the server, the last one is used, and the screen says when it was saved.
- **Whether the POS is online is the server's say**, not the browser's online flag: it asks `/health` every 30 seconds,
  every 5 seconds while the server cannot be reached, and at once when the browser reports the network back or a list
  fails to load. A server error, or the database or Redis being down, counts as unreachable. Back online, every list
  is fetched again.
- **Each device registers itself** with the restaurant once each time the app opens, and its code is shown in the user
  menu ("Device code Z01"). The browser is asked to keep the app's data rather than clear it when space runs low
  (`navigator.storage.persist()`).
- **The device clock is checked** against the server's time on every health check. More than 5 minutes off shows a
  warning, because bills made offline will take their time from the device.
- **Sign out and Lock terminal are disabled while offline**: done offline, nobody could sign in again until the server
  returns. The lock screen no longer signs out when it cannot reach the server; it offers to try again.
- **The API client** has an opt-in `sessionStore`. Only the POS gives one; the back office, kitchen display and admin
  behave exactly as before. With it, `auth.restore()` opens offline (or `unreachable`), and a server error or a "too
  many requests" answer while renewing the sign-in no longer signs the person out. The client has its first unit tests.
- **A web app manifest and icon**, so the POS can be installed on a tablet or computer.

Offline in this step, a cashier can see the menu and build an order (the cart was already kept on the device). KOT,
Bill & pay and payments still need the server, and the screen says so; billing on the device is step 3.

Known limits: a browser whose data is cleared, or a private window, registers again as a new device with a new code.
The 10-second window in which a refresh token may be reused was handled in step 2 (below).

## Offline billing: the server takes uploads (step 2 of 5, 2026-11-25)

The server side of billing offline. The device does not produce uploads yet (step 3); the endpoint and its rules are
in place and tested.

- **`POST /sync/push`** takes up to 25 operations from one registered device, oldest first: `order.save` (an order
  started on the device, sent whole each time it changes), `kot.print` (a kitchen ticket printed on the device),
  `invoice.issue` (a bill exactly as printed) and `payment.record` (money taken). The contract is
  `packages/validation/src/sync.ts`. Each operation is checked on its own, so one the server cannot read is set aside
  without holding back the rest.
- **Each operation is applied once.** Its id is chosen by the device and kept in `sync_operations`; the same id again is
  answered `DUPLICATE` and changes nothing, also when two uploads arrive at once (one device's operations take turns).
  A payment keeps the same idempotency key as online, so one recorded online is never counted again from the device.
- **Order of arrival.** An operation whose order or bill has not arrived is `DEFERRED`, and so is everything after it
  in the batch; the device sends them again. One whose order or bill was refused is refused too.
- **Bills are stored as printed**, with every amount, the seller details and the customer as on the paper, under the
  number printed, in the device's own series (`Z01/2627/000001`). The order is numbered in the device's series and
  period, as printed; its lines keep the prices and tax rates the device charged.
- **Kitchen tickets** go in as done (the kitchen worked from the paper) and are not printed again. Ticket numbers are
  the restaurant's for the day, so the server gives each its own and keeps the printed one (`kots.offline_number`).
- **Payments** go into the cash register that was open on the device, if it still is.
- **Never refused for not adding up; flagged instead.** Stored, with a note for the owner, when: the printed amounts do
  not work out from the bill's lines (`TOTALS_DIFFER`); a bill number was skipped (`NUMBER_GAP`) or already used, in
  which case the bill is stored under the next free number (`DUPLICATE_NUMBER`); an order number was already used
  (`ORDER_NUMBER_TAKEN`); a discount is over the limit with no manager to approve it offline, or given by someone not
  allowed to (`DISCOUNT_ABOVE_LIMIT`, `DISCOUNT_NOT_ALLOWED`); a price differs from the menu now (`PRICE_DIFFERS`) or
  a tax rate from the item's tax group now (`TAX_RATE_DIFFERS`); the person was not allowed to do it (`NOT_ALLOWED`);
  the device's clock was ahead, the business date does not match the time, or the work is more than 5 days old
  (`CLOCK_AHEAD`, `BUSINESS_DATE`, `LATE_UPLOAD`); the order was cancelled or billed online meanwhile
  (`ORDER_CANCELLED`, `BILLED_TWICE`); cash arrived for a register already closed, or with none open where one is
  required (`REGISTER_CLOSED`, `NO_REGISTER`); more was paid than was due, or the bill was cancelled
  (`OVERPAID`, `BILL_CANCELLED`); an order changed on another till was replaced by the device's version (`CHANGED_ONLINE`).
- **Refused, and kept for the owner**: an operation the server cannot read, by someone who is not the restaurant's
  user, for an item not on the restaurant's menu, a change to an order already billed or closed, or to one not started
  on this device offline, or one whose order or bill was itself refused.
- **Never across restaurants.** Device keys, users, items, orders and operation ids are all looked up within the
  restaurant; another restaurant's operation id is refused without touching theirs.
- **After the trial or paid period ends**, uploads are still accepted, while nothing else can be changed: the bills are
  already printed.
- **Sales, Offline uploads** in the back office (for those who reconcile payments: owner and manager) lists what needs
  checking, newest first, with the device, who did it, what it was and each note; "Mark checked" takes an optional
  note, kept in the audit log. `GET /sync/reviews`, `POST /sync/reviews/:id/check`.
- **Device registration now returns where its series stand** (`numbers`: next bill number this financial year, next
  order number in today's period), and so does every upload, so a device that lost its storage carries on.
- **A renewal whose answer was lost** no longer signs the person out. Presenting a refresh token again more than 10
  seconds after it was replaced is accepted once when the token that replaced it was never used and the request comes
  from the same browser; both stop working, and a second use of the old token ends the session as before. A copied
  token used from another browser still ends the whole session (`auth.service.ts`, `retryAfterLostAnswer`).
- The audit log records each applied operation as done by the person on the device, with `offline: true`, the device
  and who uploaded it.

## Offline billing: billing on the device (step 3 of 5, 2026-11-25)

The POS now bills while the internet is down, within the scope agreed in the plan.

- **When.** Once the server cannot be reached (step 1), KOT and Bill & pay work on the device for a new takeaway or
  delivery order. An order started offline is finished on the device, even if the connection comes back meanwhile,
  and uploaded. A KOT or bill that loses the connection half way says "Press again to carry on offline"; an order that
  was sent to the server without an answer takes new ids when it carries on offline, so the two are never mixed up.
- **Numbers.** The order is numbered in the device's series (`Z01-5`, token 5), its kitchen tickets `Z01-K1`,
  `Z01-K2`… per day, and its bill in the device's bill series (`Z01/2627/000004`). The counters are kept in the
  device's database (`apps/pos/src/lib/offline-numbers.ts`) and taken inside one of its transactions, so two tabs
  never take the same number; they carry on from where the server says the series stand.
- **KOT** sends what the kitchen has not had, one ticket per station as the server does (an item with no station needs
  no ticket), and always prints the tickets: offline there is no kitchen display. Items already sent cannot be taken
  off until the connection is back.
- **Bill & pay.** The bill is worked out on the device with the same bill engine as the server, with the restaurant's
  seller details (`buildSeller` from `packages/printing`), and printed with the restaurant's layouts: on the printer
  connected to the device, or through the browser. Payment by cash, UPI, card or other, in parts, with change. Cash
  goes into the register the cashier had open when the server last said so; where a register is required and none was
  open, cash is refused offline (UPI and card still work).
- **Upload** (`apps/pos/src/lib/outbox.ts`). Each order, ticket, bill and payment is kept in an outbox on the device
  (IndexedDB) and uploaded in order once the server answers and the sign-in is confirmed: at once, then every 20
  seconds while anything is left, in batches of 25, from one browser tab at a time. The header shows "N to upload".
  Something the server refuses is shown on the device, and the server keeps it for the owner. Signing out loses
  nothing: uploads resume with the next sign-in of the same restaurant on the device.
- **Today's bills** lists the bills made offline on this device that the server does not list yet, with Print and Pay.
- **Refused offline, with the reason on screen:** tables (dine-in), orders started online, holding, splitting a bill,
  discounts above the cashier's limit (no manager can approve offline), and billing on a device that is not
  registered, cannot keep data, or whose clock is more than 5 minutes off.
- **Closing a cash register** waits until nothing made offline on the device is left to upload.
- **Server side:** the bootstrap carries the kitchen stations in kitchen order; kitchen tickets carry `offlineNumber`
  (printed offline), which reprints show instead of the server's number.

Known limits: a KOT or bill sent online whose answer was lost, and then carried on offline, can leave an empty order on
the server (it shows under Running orders and can be cancelled), and in the rarest case a ticket printed twice. The
mobile app (separate project) bills offline the same way since 2026-11-25, keeping its work in the app's own storage
instead of the browser's; its tickets and bills print through the phone's print dialog.

## Customers

- **A customer is their mobile number.** The Customer button on the billing screen takes a 10-digit Indian mobile number (typed with or without +91, spaces or dashes; it is kept as its digits), and optionally a name and address. A customer has no GSTIN: a restaurant bill is not one the buyer claims tax on, so it was taken off on 2026-11-24 (bills already issued keep the GSTIN they were made out with). Saving the order saves the customer. One number is one customer, and a customer cannot be saved without a number; a name alone is refused with "Enter a 10-digit mobile number". The bill carries its own copy of the number and the name it was issued with, so a later change to the customer does not alter a bill already issued.
- **A number already on record is that customer.** An order with it joins the customer; details typed replace those on record, and a field left empty keeps what was there. On the billing screen, from the third digit typed, customers whose number begins that way are offered under the field (at most eight; the digits may be typed with +91 or a leading 0); picking one fills the number, name and address in. Once a whole number is in, the customer on record fills the fields still empty, with "On record as …, N orders before". A number that is long enough but wrong is marked as it is typed. Two tills typing the same new number at once make one record.
- **Wherever a customer is shown** (the order on the billing screen, Running orders, Today's bills, Orders, Bills, the dashboard, receipts and the PDF) it is the mobile number first, then the name.
- **Sales, Customers** in the back office (for anyone who may see every order: owner and manager) lists each customer by mobile number with name, orders, spent and last order, searchable by number (in any form) or name and sortable by every column. Opening a customer shows each of their orders with its number, date, bill number, amount and status. "Orders" and "Spent" leave out orders cancelled or merged away; "Spent" counts settled orders only.
- Built 2026-11-24 after the owner asked for customer records stored separately with their orders and amounts, then for the mobile number to be the identity everywhere. The migration `20261124170000_customer_mobile` kept numbers already on record as their digits, merged any two records with one number, and removed records that had no number (their bills keep the name they were issued with). The API is `GET /customers`, `GET /customers/:id`, `GET /customers/suggest?phone=` (numbers beginning with the digits typed) and `GET /customers/lookup?phone=` (one whole number). The mobile app shares the validation, so after `npm run sync-shared` its customer form needs the number too; its lookup by number is not built.

## Reports

Fourteen reports under Reports in the back office, each for any period up to three years, each
downloadable as CSV, Excel or PDF: daily sales, monthly sales, orders, item-wise sales (line by line),
item summary, category-wise, GST summary (by rate, less credit notes), HSN/SAC summary, payments
(line by line), payment summary (by day and method), discounts, refunds, cancelled bills, cashier-wise.

Every report uses the same column names for the same things, wherever they apply: Sr. no., Date,
Receipt no., Payment method, Unit, Amount, Discount, Tax, Total amount, Created by. Headline totals
(such as total sales, total sales quantity and total sales amount) sit above the table and in the
Excel and PDF downloads.

| Report | Fields that do not apply, and why |
|---|---|
| Daily, monthly sales | Receipt no. and Created by: each row is a whole day or month. Payment method appears as Cash, UPI, Card and Other columns. |
| Item summary, category-wise, HSN/SAC, GST summary | Date, Receipt no., Payment method, Created by: each row adds up many receipts. |
| Payment summary | Receipt no., Unit, Created by: each row is a day and method. |
| Cashier-wise | Date, Receipt no.: each row is a person. |
| Cancelled bills | Payment method: a cancelled bill has no money against it. |

- **A sale counts once its order is complete**, meaning every bill of the order is paid in full. An order that is still running (open, on hold, or billed and waiting for payment, including part paid) is in no sales report and not in the dashboard's sales. When it is paid it joins the day it was billed on. Cancelled bills are excluded; refunds are shown separately and deducted for net sales.
- **The GST summary and the HSN/SAC summary follow issued bills instead**, paid or not, because GST is due on a bill from the day it is issued. When they include a bill nobody has paid yet, the note under the title says how many and how much. On a day with no unpaid bills they agree with the sales reports.
- **Payments and Payment summary show money actually received**, including a part payment on an order that is still running.
- **The Orders report lists completed orders only.** Running and cancelled orders are under Sales, Orders.
- A bill for nothing (everything discounted away) has nothing to pay, so its order is complete as soon as it is billed.
- Dates are business dates, so they follow the day cut-off in billing settings.
- Item-wise, item summary and category-wise reports do not deduct refunds, because a refund by amount has no item.
- A cancelled bill leaves every sales figure, together with the payments and refunds recorded on it. It is listed under Cancelled bills.
- Lists (orders, item-wise, payments, discounts, refunds, cancelled bills) stop at 5,000 rows and say so.
- Every export is written to the audit log.

**Sharing a report.** A role with "View and export all reports" sees every report. Anyone else sees only the
reports shared with them by name: on the Reports page, open a report, press Share and tick the people.
They then find those reports under Reports in the user menu of their billing screen, for any dates, with
downloads. A shared report shows the whole restaurant's figures, not only
that person's own. Sharing needs the "Share individual reports" permission, held by owners and managers,
and each change is written to the audit log.

**Billing-only logins.** Signing in to the back office is a permission of its own, "Sign in to the back
office". Owner and Manager have it; Cashier, Captain and Kitchen do not, so a biller's email and password
work on the billing screen only, and the back office answers "This account is for billing only". A
back-office session ends at its next renewal if the role loses the permission. A new custom role needs the
permission ticked before its people can use the back office. A biller changes a forgotten password through
the emailed reset link; their PIN is set by the owner under Team → Users.

## How order numbers and bill numbers behave

- **Order number** (for example `A1-12`): a display number per terminal. When an unbilled order is
  deleted, later orders move up to close the gap (setting: automatic, manual, or off). Billed
  orders move up too; only their order number changes.
- **Token number**: the order number at the moment the order was taken. It is what the customer
  was told and what the receipt prints, and it never changes.
- **Bill (invoice) number** (for example `A1/2627/000123`): consecutive per terminal and financial
  year. A cancelled bill keeps its number. Bill numbers move only when a billed order is erased: with
  the renumbering setting on automatic, the whole series is made consecutive again (bills after it move
  up, and any gap left from earlier is closed too); on
  manual they stay until the owner presses "Reset order and bill numbers", which closes gaps in order numbers
  and bill numbers alike; on off they never move. Credit-note numbers follow the same rule. A renumbered
  bill is the same bill in every other respect (order, date, amount, payments). Copies already printed
  keep the old number; the audit log records which numbers moved and by how much.
- **Credit note number** (for example `C-A1/2627/000001`): its own consecutive series for refunds.
- A billed order is normally corrected by cancelling its bill (if unpaid) or refunding it (if paid),
  which keeps the record. The owner can also erase it; see below.

## Owner corrections

Four things the owner can do in the back office to a bill that is already settled. Each needs a
reason, and each is written to the audit log, which cannot be edited or deleted.

- **Change the payment method** (Bills → open a bill → Change payment method). For a payment recorded
  with the wrong method, for example cash instead of UPI. The amount, the bill and its date stay as
  they are; reports count the payment under the new method. Permission "Change the payment method of
  a settled bill": Owner and Manager.
- **Delete a billed order** (Orders → the bin on the row). The order, its bills, payments, refunds and
  kitchen tickets are removed from the database and from every list and report. Order numbers close
  the gap as usual, and so do bill numbers (see "How order numbers and bill numbers behave").
- **Change the items of a billed order** (Orders → the pencil on the row). Quantities are changed, items
  removed, and items added from the menu with their variants and add-ons, with the new total shown as
  you go. On saving, the bill is issued again under the same number, date and cashier. It also keeps the
  customer and seller details it was made out with, and the tax rates its lines were charged at; lines
  added now use today's rates. For the money there are three choices: keep the payments as they were
  recorded (the default for a bill that was part paid or paid by more than one method, leaving any
  difference due), record the whole new total as paid by one method (the default for a bill paid in
  full by one method), or leave it unpaid. All of it happens in one database transaction or not at all.
  The kitchen is not sent anything. A bill that was split by item comes back as one bill under the
  first number. A bill of the order that was cancelled earlier is left as the record it is. An open order is changed from the same pencil; that is an ordinary
  save, and the kitchen is told about reductions as on the POS.
- **Reopen a billed order on the POS** (in that editor: "Change on the billing screen instead"), for
  changes the back-office editor does not cover: discounts, notes, customer, table, splitting. The bills
  and payments are erased in the same way and the order returns to Running orders on the POS, where it
  is changed and billed again. A table order gets its table back if the table is free, and comes back without a table
  if other guests have it.

Deleting, changing and reopening a billed order need the permission "Permanently delete a billed order…", which only the Owner
role has by default; anyone else needs the PIN of someone who holds it.

How it is enforced: database triggers still refuse every change to bills, payments and refunds. The
API lifts that only inside the one transaction that performs a correction (`app.owner_override`), and
the audit entry holds what was removed: bill numbers, amounts, payments and refunds.

Everything that changes an order's bills (billing, paying, refunding, cancelling, and the corrections
above) first takes a lock on the order, so two such changes to one order happen one after the other.
Locks are always taken in the same sequence: order-number series, orders, bills, bill-number series.

Known limits of changing a billed order: the service charge and round-off setting are today's, not those
of the bill's date; and a customer record is one per mobile number, so a bill issued again on the POS
after "reopen" shows the customer as last saved under that number.

**For the owner to weigh:** GST rules expect invoice numbers to be consecutive and issued invoices to
be kept. Erasing a bill that was given to a customer leaves no invoice behind it, and renumbering the
bills after it means the copies those customers hold no longer match the books.
Cancelling or refunding keeps the record and is the safer route for real sales; erasing suits test
bills and entries made by mistake. Have an accountant confirm how this should be used before launch.

## Cash register

- **A register belongs to a cashier.** They open it from the user menu on the billing screen with the cash counted in the drawer. One person has one register open at a time.
- **What should be in the drawer** is the opening cash, plus cash taken against bills, plus cash put in, less cash taken out and cash refunded. It is always worked out from the payments themselves, so correcting a payment method or erasing a bill changes it too.
- **Everything the cashier takes while the register is open is linked to it**, by every method. Only cash counts towards the drawer; the other methods are listed so the whole shift can be checked.
- **Cash in and cash out** need a reason, and the `register.adjust` permission or a manager PIN. More cannot be taken out than the drawer should hold.
- **Closing** compares the cash counted (by notes and coins, or as one total) with what should be there, and records the difference. A closed register is final: the database refuses to change, reopen or delete it. Later corrections to bills do not alter its recorded figures.
- **A manager can close a register left open** (Sales, Cash registers), and sees every register; a cashier sees their own.
- **A refund in cash** comes out of the register of whoever hands the money back; if they have none open, out of the register that took the payment, if that is still open.
- **"Cash can only be taken with the cash register open"** (Settings, Billing & GST) is off by default. When on, a cash payment without an open register is refused and the register dialog comes up. Cash taken without a register is shown under Reconciliation as "outside a register".
- **Register report**: opening, takings, cash in and out, count and difference, printed on the receipt printer.

## Reconciliation

Sales, Reconciliation lists, for each day and payment method, what was received, what was refunded and the net.
The manager enters what actually arrived (the bank statement, the card machine's settlement, the UPI app) and the
page shows the difference. If payments for that day change after the figure was entered, the row says so.
Nothing on this page changes a bill or a payment. It needs the `payment.reconcile` permission.

## Printing

- **Printers** are set up under Settings, Printers: for bills or for kitchen tickets, on the network (IP address and port), on USB or Bluetooth (a device, or the name of a printer installed on the bridge computer), 58 mm or 80 mm. One printer of each kind is the default. A kitchen station can have its own printer and a fallback printer (Settings, Kitchen stations).
- **A printer plugged into the billing device itself** needs no setup and no bridge: the billing screen has a "Connect printer" button (and the same entry in the user menu, where it reads Connected and offers Disconnect once a printer is attached). It talks to the printer from the browser in one of three ways, so it works in Chrome and Edge (not Safari or Firefox): **USB printer** (WebUSB); **Bluetooth printer** (Web Bluetooth, Bluetooth Low Energy: the kind most phone and tablet printers speak, added 2026-11-24 after an EZO printer could not be found on a Mac); and **Paired Bluetooth or serial port** (Web Serial: a Bluetooth Classic printer paired with the computer, or a serial cable). On Android phones and tablets, USB and Bluetooth are available. For Bluetooth the dialog lists what usually stops a printer being found: another phone or POS connected to it (a printer talks to one device at a time), the printer asleep or far away, and, on a Mac, the browser not allowed to use Bluetooth (System Settings, Privacy & Security, Bluetooth). A Bluetooth printer is written to in 20-byte pieces with a short pause between them, through the first writable channel of the printing services thermal printers commonly use, and is reconnected by itself when it lets an idle link drop. On other browsers the header button does not appear, but the user-menu entry stays and its dialog says to use Chrome or Edge, or the print bridge. A USB or serial printer reconnects by itself when the page opens again; a Bluetooth printer is chosen again after a reload, because browsers do not yet list Bluetooth devices allowed before. A test page can be printed from the connect dialog. Bills, kitchen tickets and register reports print there first, before the bridge is considered; the API lays the printout out (`GET …/print-document?width=`) and the page only turns lines into ESC/POS, exactly as the bridge does. Printouts are sent one after another, so a split bill cannot interleave.
- **A bill prints by itself when it is paid in full** ("Print the bill": *Automatically when paid in full*, the default, or *Only when Print is pressed*; Settings, Billing & GST). Only bills not printed yet print this way; through the browser's dialog only the first bill of a split prints itself, since that dialog shows one printout at a time.
- **The print bridge** (`apps/print-bridge`) is a small program for the counter computer. It is added under Settings, Printers, which shows a token once; only a hash of it is stored. The bridge asks the API for work every second, prints, and reports back. It prints nothing unless it asked for it, and listens only on the computer itself.
- **The API lays every printout out** as lines of text for the printer's paper width, so changing what a bill looks like never needs the bridge updated. The bridge only turns lines into ESC/POS commands.
- **When printing fails** the job is tried three times, a little later each time, then moved to the station's fallback printer, and only then marked failed. The cashier who sent it is told on the billing screen, with the printer's reason ("The printer refused the connection. Check that it is switched on."). Failed jobs can be sent again from Settings, Printers.
- **A job nobody could print within 15 minutes is given up on**, so a kitchen does not receive an hour-old ticket when a printer comes back.
- **Without a bridge, or when it is not connected**, the billing screen falls back to the browser's print dialog, as before.
- **The cash drawer opens** when a bill paid in cash is first printed (not for duplicates), if the drawer is wired to the receipt printer. This can be switched off.
- **What is printed** (a line under the restaurant name, customer, HSN codes, tax breakup, amount in words, a UPI QR code for unpaid bills, copies) is set under Settings, Printers.
- **The bridge refuses anything that is not a printer.** Printer settings come from the server, so a stolen back-office login must not be able to aim the bridge elsewhere. It prints only to network ports 9100 to 9109 and to the usual printer devices; anything else has to be allowed on the bridge computer itself (`PRINT_BRIDGE_ALLOW_PORTS`, `PRINT_BRIDGE_ALLOW_DEVICES`).

What has and has not been tested:

| Tested | How |
|---|---|
| The bytes sent to a network printer (text, bold, large text, QR code, cut, drawer kick) | Against a printer emulator that records what arrives on its port |
| The whole path: a cashier presses Print, the bill arrives at the printer; a kitchen ticket arrives at the kitchen printer; a printer that is off is reported | Browser test running the real bridge code against emulators |
| Writing to a USB or Bluetooth device | Against a file standing in for the device |
| Not tested: a physical thermal printer of any make | Needs hardware. Expect to check paper width, the cut command and the drawer kick on the first real printer |
| Not tested: printing to a named printer on Windows or through `lp` on macOS and Linux | Needs a computer with a printer installed |

## Selling it as a hosted product: what is built

**Registering a restaurant.** There are two ways, and both end with the same ready-to-bill restaurant: its
settings, the five standard roles, GST tax groups (0, 5, 12 and 18%), one billing terminal (A1), one kitchen
station and the owner's account. The menu, tables and staff are for the owner to add.

- **Sign-up** (back office, "Register your restaurant"): restaurant name, owner's name, email, mobile, password,
  state and GST registration. The owner cannot sign in until they open the link sent to their email (it works
  for 24 hours, and only the newest one works). The free trial is counted from that moment.
- **By the vendor** (admin app, "Add restaurant"): the owner is emailed a link to choose their password (7 days).
  Using the link is what confirms the address. The trial length is chosen there; 0 means no time limit.
- Registration never says whether an address already has an account: the answer is the same, and the person who
  owns the address is told by email. Someone who registered but never confirmed can register again; the newest
  details win.
- `SIGNUP_ENABLED=false` closes registration, leaving only the vendor's way. `TRIAL_DAYS` sets the trial (14).
- A new restaurant's dashboard shows a **getting-started list** (address, menu, tables, staff, first bill) that
  ticks itself off from what exists, until it is done or the owner hides it.

**Where a restaurant stands** is one of four states, shown to it in a strip at the top of the back office:

| State | When | What the restaurant can do |
|---|---|---|
| On trial | The trial end is in the future | Everything |
| Active | Paid up to a date that has not passed, or no time limit at all | Everything |
| Expired | The trial or the paid period is over | Look at and export everything; change nothing, make no bills |
| Suspended | The vendor switched it off | Nothing: nobody can sign in, and anyone signed in is signed out |

A restaurant that existed before this was built has no time limit. The check costs nothing extra per request
(it rides on the existing Redis lookup) and a change takes effect at once when the vendor makes it, or within
a minute when a trial simply runs out.

**The platform admin app** (`apps/admin`, port 3103) is for the vendor's own staff.

- It has its own accounts (`platform_admins`), separate from restaurant users. A restaurant sign-in opens none
  of it, and a platform sign-in opens nothing in a restaurant.
- It lists every restaurant with its owner, state, how much it is used (users, bills and sales in the last 30
  days, last sign-in) and how it came to exist; with search, a state filter and sorting.
- For one restaurant it shows details, use, the people with accounts, and the recent audit log. It does not show
  bills or customers. Opening that page is written into the restaurant's own audit log.
- Actions: add a restaurant, change the trial end, record a payment (a "paid until" date with a note of how it
  was paid), remove a paid period, suspend with a reason, restore, and email the owner a password link.
  Each is written into the restaurant's audit log with the admin's name.
- The first admin is created by `pnpm db:seed` from `PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD`.

## Deployment

A single-server deployment is written and was rehearsed end to end on a laptop on 2026-11-23.

- `Dockerfile`: one image that runs every service. `infra/prod/`: the compose stack (Caddy for HTTPS, API, the
  four apps, Postgres, Redis, a migration step), settings template, backup and restore scripts, and a smoke
  test that checks an installation from the outside.
- `docker compose run --rm platform-admin` (or `pnpm db:platform-admin` outside Docker) creates the vendor's
  sign-in without the demo restaurant, and changes its password when run again.
- `docs/DEPLOYMENT.md`: the step-by-step guide, from DNS records to backups, updates and troubleshooting.

| Rehearsed (Docker with 4 GB of memory, the size of the server in the guide) | Result |
|---|---|
| Image build | Built, 1.48 GB |
| Stack start | Migrations applied, every service running, API healthy; under 500 MB of memory in use when idle |
| Smoke test through the proxy | API health, the four apps, live updates, CORS, platform admin sign-in, and a restaurant registering, confirming its email, uploading a photo, billing an order and taking payment |
| Backup, wipe, restore | After the wipe the restaurant was gone; after the restore its bill, photo and the admin account were back |
| Update | Rebuilt and restarted with data kept |
| Admin password change, admin address limit, restore without confirming | Each behaved as the guide says |

The rehearsal found and fixed one fault: services started through `pnpm` tried to reinstall packages inside
the container and failed. Every service is now started with `node` directly.

| Not tested | Why |
|---|---|
| Real HTTPS certificates and real email delivery | Need a public server, a domain and an SMTP account |
| A build on an x86 server | The laptop is ARM. The image is built from source on the server, so it should work the same |
| Behaviour under load on a 4 GB server | Needs real traffic |

## Pending modules

| Phase | Scope |
|---|---|
| 8 | Offline POS, in five steps (plan agreed 2026-11-25). **Steps 0–3 done** (see "Offline billing: groundwork", "the app opens offline", "the server takes uploads" and "billing on the device"). Still to do: more browser tests (Safari, Android, an installed app) and a pilot week in one outlet (4); then tables and orders started online offline (v1.1) |
| 9 | Partly done: see "Deployment" above. Still to do: first deployment on a real server, security review, S3 storage driver, managed-services setup (Terraform) |
| Hosted product | Plans with limits, renewal reminders, automatic payment (Razorpay), several outlets under one owner |

## Known bugs

No functional bugs are known. The mobile app (separate project) was brought up to date on 2026-11-25: shared code
re-synced, its customer form asks for the mobile number first (with suggestions from the third digit, pick-to-fill, live
validation, no GSTIN), "Send to kitchen" is KOT, and the number is shown first wherever a customer appears. It typechecks;
it has no automated tests and has not been run on a device since. See POS_AUDIT_REPORT.md for what is still missing.

No functional bugs are known. Open issues from the 2026-11-24 audit (details in POS_AUDIT_REPORT.md):

- **Orders sorted by bill number or payment method are slow on a long history**: 4.2 s and 2.1 s at 90,600 bills,
  because every order is loaded to sort it. The Orders page defaults to today, which keeps it fast in normal use.
- **The POS bootstrap carries the whole menu with the tables**: 1.6 MB at 3,000 products, fetched every minute and after
  table changes. Fine for a menu of a few hundred items.
- **A lost answer to "Send to kitchen"**: if the connection drops after the kitchen got the ticket but before the till
  heard back, a till printing through the browser does not print that ticket. The retry says "Nothing new". The kitchen
  display and the print bridge still get it.

## Known gaps and limits

- **Terms of service and a privacy policy are not written**, so the sign-up page does not ask anyone to accept them. They are needed before the public can register.
- **There is one platform admin**, made by the seed. Adding or removing admins, changing an admin's password and two-step sign-in are not built; the last should be added before the admin app is reachable from the internet.
- **Sign-up has no CAPTCHA.** One address can register five times an hour, and nothing works until the email is confirmed, but a restaurant row is created for each attempt and unconfirmed ones are not cleaned up yet.
- **Payment for the subscription is recorded by hand** in the admin app. There are no plans, prices, limits on terminals or users, invoices to the restaurant, or renewal reminders.
- **A person can belong to one restaurant only**: an email address is one account. Several outlets under one owner is later work.
- **CI is unverified.** `.gitlab-ci.yml` has never run on a runner, and it does not yet run the browser tests.
- **The newest work is on branches, not on `main`**: `phase-7-cash-register-printing`, then `fix-print-queue-clock`, then `saas-signup-and-admin`, each built on the one before. Nothing has been pushed.
- **No payment gateway yet.** Cash, UPI and card payments are recorded by the cashier. The gateway adapter (Razorpay) needs account keys and is not built; with it come gateway-initiated UPI QR, pending and failed payment states, and webhooks.
- **Bluetooth printing has been tried on one real printer.** The owner confirmed on 2026-11-24 that the EZO Bluetooth printer works (Chrome on a Mac). The automated tests use a simulated Bluetooth Low Energy printer (connecting, test page, KOT, bill, reconnecting, error messages). On another model: if it prints garbled or cut-off receipts, the piece size or pause needs tuning; if it is not listed, it may use a service the POS does not know yet (its service id can be read with the nRF Connect app and added to `BLE_PRINTER_SERVICES`).
- **Thermal printing is untested on physical printers.** See "Printing" above. This includes the printer connected to the billing device over WebUSB or Web Serial.
- **On Windows, a USB printer whose driver is installed is usually held by that driver**, so the browser cannot claim it over WebUSB. The connect dialog says so in plain words; the ways around it are the Bluetooth/serial choice, the print bridge, or removing the driver.
- **Thermal printers print English letters and digits only.** Names in other scripts print as "?" on a thermal receipt; the browser receipt and the PDF show them correctly. Printing other scripts needs the receipt sent as an image, which is not built.
- **One print bridge prints for the whole outlet.** It reaches every network printer, and the USB or Bluetooth printers of the computer it runs on. A second bridge on another computer would also take jobs, but jobs are not yet routed to a particular bridge.
- **The bridge is run from this repository** (`pnpm --filter @pos/print-bridge start`). An installer for Windows, and starting it with the computer, are not built.
- **The bridge prints only what the server queued.** Printing straight from the billing screen to the bridge with no internet arrives with offline mode (Phase 8).
- **A register's figures are a snapshot once it is closed.** If a payment taken in it is corrected later, the register keeps the figures it was counted against; the reconciliation page shows the corrected payments.
- **The cashier filter on Cash registers** is shown only to people who may also manage users, because the list of users needs that permission.
- **Refunds from the screens are by amount.** Refunding specific items is supported by the API but has no screen yet.
- **Place of supply other than the restaurant's own state** (IGST) is supported by the API but has no screen. Restaurant service is normally supplied where it is performed, so this is rarely needed.
- **Joining two tables into one** is done by merging their orders (Running → Merge into current); the tables are not drawn as joined on the plan.
- **The kitchen display has no sound alert** for new tickets, and cannot mark an item out of stock; use the availability switch in the back office or POS products list.
- **A running order's kitchen tickets are deleted with it** if the order is deleted; cancelling the order instead sends the kitchen a cancellation ticket.
- **A chartered accountant should review the invoice format** before commercial use.
- **Uploaded images are never deleted**; replacing a photo leaves the old file on disk.
- **File storage is local disk only** until the S3 driver in Phase 9.
- **A user's email cannot be changed** after the account is created.
- **Restaurant logo upload is not built**; the column exists.
- **Swagger documents request bodies but not query parameters or response shapes.**
- **A `pg` deprecation warning** is printed once per process. It comes from Prisma's PostgreSQL adapter, not this code, and is harmless on `pg` 8.
- **GST rates must be whole basis points that halve evenly**, so CGST and SGST are exact.
- The seed uses a placeholder GSTIN and FSSAI number; replace them on the Restaurant page.
- Running `pnpm build` while `pnpm dev` is up stops the dev API; restart `pnpm dev` afterwards. The browser tests no longer need it: they compile their own copy of the API.
- **Reports are computed on request, not cached.** That is fine at restaurant scale; very long periods on a busy outlet may take a few seconds.

## Security measures in place

- Passwords and PINs hashed with Argon2id; refresh and reset tokens stored only as SHA-256 hashes.
- Access tokens last 15 minutes and are kept in browser memory, never in storage. Refresh tokens are HttpOnly, SameSite=Strict cookies scoped to the auth routes, rotated on every use; a replayed token ends the whole session.
- Sign-out, deactivation, role change and password change take effect on the next request, not after token expiry.
- Five wrong passwords or PINs lock the account for 15 minutes. Sign-in is limited to 10 attempts a minute per IP address. Every other route allows 600 requests a minute per signed-in session, or per IP address for a request without a valid token: every device at an outlet shares one address, so a per-address budget would be shared by all its tills.
- Cookie-authenticated routes accept only requests from the configured front-end origins.
- The mobile app (a separate project) holds no cookie: its refresh token is given in the sign-in answer, kept in the device's Keychain or Keystore, and sent in a header. The routes never read a cookie for it, so the origin check does not apply to it.
- Every query is scoped to the caller's restaurant; cross-restaurant access is covered by tests in each module.
- Uploads are identified by their bytes, limited to 2 MB, and stored under generated names.
- Platform admins are a separate kind of account with a session cookie that is HttpOnly, SameSite=Strict and sent only to the platform routes; those routes also refuse any request that does not come from the admin app's own address. Sessions end after 12 hours, or 2 hours unused. Five wrong passwords lock the account for 15 minutes.
- Signing up never reveals whether an email address has an account, and a new account opens only from the link sent to that address.
- A suspended restaurant's sessions are ended at once; an expired one is held to reading by the same check that authorises every request.
- A print bridge signs in with its own token, which opens only the two bridge routes of its own restaurant; removing the bridge ends it at once.
- The bridge prints only to printer ports and printer devices unless the person who installed it allows more, and listens only on the computer it runs on.
- Closed cash registers and cash movements cannot be changed or deleted, by a rule in the database itself.

## Changes from the approved plan

| Plan | What was built | Why |
|---|---|---|
| MinIO for local file storage | Files on local disk; S3 in production | The MinIO image is no longer published on Docker Hub |
| `nestjs-zod` for validation | Zod with a small validation pipe of our own | `nestjs-zod` does not yet support NestJS 12 |
| Jest for API tests | Vitest | NestJS 12 is ESM-only and ships Vitest by default |
| react-hook-form | A small form-state hook that validates with the shared Zod schemas | Fewer moving parts; API field errors land on the same fields |
| Default ports | Postgres 5544, Redis 6390, API 4000, web 3100, POS 3101, KDS 3102, bridge 9110, Mailpit 8026 | The usual ports were already in use on this machine |
| Deferrable unique constraint on order numbers | Plain unique constraint; renumbering moves numbers through negative values inside one transaction | Prisma cannot represent deferrable constraints |
| Idempotency keys in Phase 4 | Built in Phase 5 as client-generated ids on payments and refunds | Nothing before payments needs them |
| Split bill equally creates several invoices | Split by item creates several invoices; splitting equally or by amount is done as several payments on one invoice | An invoice must list whole items; sharing one bill is a payment matter |
| Billed orders are never renumbered | A billed order's display number moves up when an earlier unbilled order is deleted; its bill number and token never change | Otherwise the order list could not be gapless |
| pdfmake for PDF | PDFKit with DejaVu Sans | Needs no bundled virtual font file and has the rupee sign |
| Drag-and-drop category ordering | Up and down buttons | Works with keyboard and touch without another library |

## Database changes

| Migration | Contents |
|---|---|
| `20261121174251_init` | All tables, enums, indexes and foreign keys |
| `20261121174341_constraints_and_triggers` | `pg_trgm` extension, partial unique indexes, check constraints, immutability triggers |
| `20261121175955_session_client_and_lock` | `sessions.client` (which app holds the session) and `sessions.locked_at` (terminal lock) |
| `20261122110852_report_shares` | `report_shares` table; the `report.share` permission, granted to existing owner and manager roles |
| `20261122120233_owner_corrections` | Triggers on bills, payments and refunds accept an owner override for one transaction; the `payment.change_method` and `invoice.delete` permissions |
| `20261122150747_bill_renumbering` | `compact_series()`: closes the gaps in one bill or credit-note series and returns what moved |
| `20261122132404_tester_fixes` | `kot_items.cancelled_quantity`; the append-only rule on bill lines no longer blocks removing an order item whose earlier bill was cancelled |
| `20261122112941_backoffice_access` | The `backoffice.access` permission, granted to every existing role except the built-in Cashier, Captain and Kitchen |
| `20261122190000_registers_and_printing` | `restaurant_settings.register_required`; closed cash registers protected by a trigger; print queue columns (title, next attempt, fallback used); `print_bridges` and `payment_reconciliations` tables; one print layout per kind of printout |
| `20261123090000_signup_and_platform` | Trial end, paid-until date, suspension and how a restaurant was created; `users.email_verified_at`; `email_verification_tokens`, `platform_admins` and `platform_sessions` tables |
| `order_number_epoch` | `restaurant_settings.order_number_epoch` (restart numbering from 1) and a wider `orders.number_period` |
| `20261123132201_auto_print_receipt` | `restaurant_settings.auto_print_receipt`: print the bill as soon as it is paid in full |
| `20261124180000_customer_no_gstin` | `customers.gstin` dropped |
| `20261125120000_pos_devices` | `terminals.kind` (COUNTER or OFFLINE) and the `pos_devices` table: offline billing groundwork |
| `20261125180000_offline_sync` | `sync_operations` gains the device, who did it and who uploaded it, what it is about, the owner's flags and who checked them; `kots.offline_number` |
| `20261124170000_customer_mobile` | Customers identified by mobile number: `customers.phone` required and unique per restaurant, `name` optional; existing numbers kept as digits, duplicates merged, records without a number removed |
| `20261124120000_send_to_kitchen` | `products.send_to_kitchen` (default true): a product with no station goes to the first active station; false keeps it off kitchen tickets |

## Next development tasks

The agreed order, on the way to selling this as a hosted product. Sign-up and the platform admin app were
built ahead of deployment at the owner's request.

1. Phase 9, deployment: production images, AWS (Terraform), backups with a restore drill, S3 for files, security review. The review should include rate limits on the print bridge routes, a CAPTCHA on sign-up, and two-step sign-in for platform admins.
2. Plans and subscriptions: limits per plan, renewal reminders, invoices for the subscription fee. Payment is recorded by hand today; Razorpay later.
3. Phase 8, offline POS.
4. Several outlets under one owner.

Before the public can register: terms of service and a privacy policy, and real email delivery (SMTP settings).
Before the first paying restaurant: try the print bridge with a physical thermal printer, and package it for Windows.
