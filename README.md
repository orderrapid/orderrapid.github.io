# Purchase Order App

Web app for the purchase team: sales upload, stock upload, order suggestions,
repeat-order warnings and overstock checks, for every warehouse.

Built on **Supabase (free)** for the database and login, and **GitHub Pages (free)** for the website.
There is no build step: the files in this folder are the website.

## What's in part 1

| Screen | Who | What it does |
|---|---|---|
| Home | everyone | Per warehouse: **sales uploaded up to** which date, and when stock was last counted. Admin: database space used |
| Orders | everyone (placing: Admin, Purchase Team) | Min / Max per medicine (same rules as MEDICINE ORDERING SHEET v4), Order Qty = Max − stock − already on order, place order + Excel, "ordered today" warnings; tabs New – Decide, Too Much Stock, Not Ordering, Slow Medicines, Orders placed |
| Reports | everyone | By Category / Ailment / Manufacturer / Brand: Summary (sales, growth, purchases), Buying vs Selling (>120% flagged), Rising & Falling, Hourly sales |
| Sales upload | Admin, Manager | Pick warehouse → upload Excel → check summary → confirm. Lines already uploaded are skipped; gaps in dates are warned about |
| Purchase returns | Admin, Manager, Purchase Team | On Purchases: upload the return file (Date, Reference No, Distributor, Medicines Name, Pack Size, Total Quantity in loose units → strips via the Strips sheet). Repeat reports and Buying, not selling count what was kept (returns within 7 days of buying); repeats fully sent back go to "Settled by a return"; Returns by distributor; Reports show Returned and Kept |
| Buying, not selling | everyone (Admin: limits, block) | On Purchases: medicines bought on many bills / from several distributors while hardly selling, with the likely cause (duplicate code, not ordered in the app, discontinued). Order Sheet shows a red label; Admin can untick them by default or block a medicine per warehouse |
| Turn Around Time | everyone (Admin: targets) | Reports tab: delivery time per distributor (order placed → goods arrived), on time vs expected, orders still waiting, bounce follow-up time and bounced medicines not re-ordered yet. Expected time is set when placing; arrival time when receiving or from the purchase file (Arrival / Entry Time column) |
| Order Sheet tags | everyone (upload: Admin) | Every line is Urgent (Fast/Average with < 2 days stock, bounced, found again), Regular, Rare or Check Duplicate (possible duplicate code / buying-not-selling; unticked). Admin uploads an order sheet (Medicine Name, Pack Size, Closing Stock (Strip), Min, Max, Qty to Order, 7 / 15 / 30 Days Sale, Tag; optional Distributor, Note; Qty 0 lines skipped): its qty replaces the app's, new medicines are added, lines stay until ordered. Filters: tags + From app / From Admin |
| Short in market | everyone (found: Admin, Manager) | On the Order Sheet, "Short in market?" only after ticking both Pharmarack and Retailer Shakti; the medicine stays on the sheet unticked with name, time and days marked. Orders → Short in market lists them; Admin/Manager mark "Found — order it"; closed when ordered |
| Download / delete | Admin, Manager (delete: Admin) | On Sales upload and Purchases: download any warehouse and dates in the upload format (sales with mobile numbers); Admin deletes a wrong upload by warehouse + dates after a preview and typing the warehouse name |
| Stock | Admin, Purchase Team | Upload *Medicine Name, Pack Size, Stock in Loose*. Converted to strips using the item master. Items with no or wrong conversion are flagged |
| Item master | everyone views; Admin, Manager upload / edit | All medicines (search, counts, Excel), Needs checking, Upload history. Uploads: Strips sheet, Medicine details, Duplicate Items (discontinue per warehouse or all) |
| Warehouses | Admin | Add, rename, switch off warehouses |
| Users | Admin | Approve sign-ups, set roles, block users, **set a new password** for anyone who forgets |

Coming in part 3: purchase import and the overstock report (repeat orders, duplicate codes, pack sizes).

## Database updates
Run each file once, in order, in Supabase → SQL Editor: `01_schema.sql`, `02_sale_time.sql`, `03_orders.sql`, `04_check_upload.sql`, `05_distributor_invoice.sql`, `06_purchases_bounces.sql`, `07_categories_reports.sql`, `08_item_master_view.sql`, `09_delete_download.sql`, `10_buying_not_selling.sql`, `11_turn_around_time.sql`, `12_short_in_market.sql`, `13_admin_order_sheet.sql`, `14_admin_sheet_format.sql`, `15_purchase_returns.sql`, `16_upload_ranges.sql`.
All are safe to run again.

## One-time setup (about 20 minutes)

### 1. Supabase
1. Go to **supabase.com** → sign in → **New project**. Name: `purchase-order`. Region: **Mumbai (ap-south-1)**.
   Save the database password somewhere safe (a password manager).
2. Open **SQL Editor** → **New query** → paste everything from `database/01_schema.sql` → **Run**.
   It should end with "Success. No rows returned".
3. **Authentication → Sign In / Providers → Email**: switch **off** "Confirm email", then Save.
   (Supabase's free email only reaches your own account, so confirmation mails would never reach staff.)
4. **Project Settings → API**: copy the **Project URL** and the **anon / publishable** key.
   Never copy the `service_role` / secret key into the app.

### 2. GitHub
1. Create a repository (e.g. `purchase-order-app`) and upload all files from this folder
   (the `tests` folder is optional).
2. Edit `js/config.js` on GitHub and paste the Project URL and anon key from step 1.4.
3. **Settings → Pages** → Source: *Deploy from a branch* → Branch: `main`, folder `/ (root)` → Save.
   After a minute the site is live at `https://<your-github-name>.github.io/purchase-order-app/`.
4. Back in Supabase: **Authentication → URL Configuration** → Site URL = that address.

### 3. First login
1. Open the site → **Create an account**. **The first account becomes Admin**, so do this yourself straight away.
2. Ask your team to create accounts. They'll see "Waiting for approval" until you give them a role under **Users**.
3. Give a second trusted person the Admin role too.
4. Item master → load the Strips sheet. Then Sales upload → load each warehouse's sales history once.

## Day-to-day
- **Manager**: upload each warehouse's sales for the new days. The Home screen shows which date each warehouse is up to.
- **Purchase Team**: upload the stock count before ordering.
- **Admin**: fix items listed under Item master → *Needs checking*.

## If someone forgets their password
- **Staff**: an Admin opens **Users → Set password** and tells them the new one.
- **The only Admin**: sign in to supabase.com → your project → **Authentication → Users** →
  click the user → set a new password (or use **SQL Editor**: `select admin_set_password(...)` won't work there
  because it checks the role, so use the dashboard).

Keep a note of: your supabase.com login (or which GitHub account you sign in with), the project name,
and the database password. That is everything needed to recover access later.

## Limits on the free plan
- Database 500 MB. Bill lines are kept for 400 days (setting `sales_keep_days`); one warehouse is about
  30–40 MB, so 7 warehouses fit. Mobile numbers are stored once each and are visible to Admin only.
- A free Supabase project **pauses after 7 days with no use**. Daily use keeps it awake; if it pauses,
  open supabase.com and click **Restore**. (Part 2 adds a daily GitHub job that also keeps it awake.)

## Files
```
index.html            the page
assets/styles.css     look and feel
js/config.js          your Supabase URL + anon key
js/main.js            login, menu, screen switching
js/db.js              database connection, who is logged in
js/excel.js           reading the Excel files (column names, mixed date formats)
js/excel-worker.js    reads big files in the background
js/ui.js              shared helpers
js/pages/*.js         one file per screen
database/01_schema.sql  tables, security rules, upload functions
tests/                checks used during development (not needed on the site)
```

## Security
- Every table has row-level security: the database itself checks the role, not just the menu.
- Sales, stock and item master are only changed through functions that check the role first.
- Customer mobile numbers sit in their own table that only Admin can read.
- People who sign up see nothing until an Admin gives them a role. Anyone not logged in can't read anything.
