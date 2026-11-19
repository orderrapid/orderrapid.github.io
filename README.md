# Purchase Order App

Web app for the purchase team: sales upload, stock upload, order suggestions,
repeat-order warnings and overstock checks, for every warehouse.

Built on **Supabase (free)** for the database and login, and **GitHub Pages (free)** for the website.
There is no build step: the files in this folder are the website.

## What's in part 1

| Screen | Who | What it does |
|---|---|---|
| Home | everyone | Per warehouse: **sales uploaded up to** which date, and when stock was last counted |
| Sales upload | Admin, Manager | Pick warehouse → upload Excel → check summary → confirm. Lines already uploaded are skipped; gaps in dates are warned about |
| Stock | Admin, Purchase Team | Upload *Medicine Name, Pack Size, Stock in Loose*. Converted to strips using the item master. Items with no or wrong conversion are flagged |
| Item master | Admin | Load the Strips sheet (*Item Name, Pack Size, Qty in Loose*). Fix conversions; busiest problem items first |
| Warehouses | Admin | Add, rename, switch off warehouses |
| Users | Admin | Approve sign-ups, set roles, block users, **set a new password** for anyone who forgets |

Coming in part 2: your analysis (Min/Max) running automatically, order suggestions,
order sheets with "already ordered this morning" warnings. Part 3: purchase import and overstock report.

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
