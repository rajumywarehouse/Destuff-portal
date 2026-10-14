# CFS Destuffing Portal: deploy guide

One website, two portals:

- **Staff portal:** inventory grid, strict FIFO job queue, live destuffing clocks, photos and files, audit log, users and customers.
- **Customer portal:** each customer signs in and sees only their own containers, their queue position and any photos you share with them.

The site is hosted on **Vercel** (free plan). Data, logins and files live in **Supabase** (free plan). Allow about 20 minutes.

## What's in this folder

| File | Purpose |
|---|---|
| `index.html` | The website (one page that shows the staff portal or the customer portal, depending on who signs in) |
| `assets/config.js` | **The only file you edit**: your Supabase address and key |
| `assets/core.js`, `staff.js`, `customer.js`, `app.css` | Portal code and design |
| `supabase/schema.sql` | Database tables, security rules and the FIFO logic. Run it once in Supabase. |
| `api/admin-users.js` | Secure server function that creates, resets, disables and deletes logins (superadmin only) |
| `vercel.json` | Vercel settings and security headers |

---

## Step 1: Create the Supabase project

1. Go to **supabase.com**, sign up, and click **New project**.
2. Name it `cfs-portal`, set a strong database password (save it), and pick region **Mumbai (ap-south-1)**.
3. Wait about 2 minutes for it to finish setting up.

## Step 2: Create the database

1. In Supabase, open **SQL Editor** → **New query**.
2. Open `supabase/schema.sql` from this folder, copy all of it, paste it in and click **Run**.
3. You should see "Success. No rows returned". You can safely run it again later if you update the portal.

## Step 3: Get your two keys

1. In Supabase, open **Project Settings → API** (on newer dashboards: **Project Settings → Data API** and **API Keys**).
2. Copy the **Project URL** (looks like `https://abcdxyz.supabase.co`).
3. Copy the **anon public** key: a long text starting `eyJ…`. On newer dashboards it's under the **Legacy API Keys** tab. The newer `sb_publishable_…` key also works; if sign-in fails with it, use the legacy anon key.
   - Never use the `service_role` / secret key in this website.

## Step 4: Put the keys in the portal

Open `assets/config.js` and replace the two placeholder values:

```js
SUPABASE_URL: "https://abcdxyz.supabase.co",
SUPABASE_ANON_KEY: "eyJhbGciOi....",
COMPANY_NAME: "Your CFS name",
SLA_MINUTES: 120
```

The anon key is meant to be public. Your data is protected by the database rules from Step 2, not by hiding this key.

## Step 5: Publish on Vercel

**Option A: drag and drop (no GitHub needed)**

1. Install the Vercel command line: `npm i -g vercel`
2. Open a terminal in this folder and run: `vercel --prod`
3. Log in when asked, and accept the defaults (framework: **Other**, no build command).

**Option B: through GitHub (best for future updates)**

1. Create a new GitHub repository and upload all files in this folder (keep the folder structure).
2. In Vercel, click **Add New → Project**, import the repository, set Framework Preset to **Other**, leave Build Command empty and click **Deploy**.
3. Every later change you push to GitHub redeploys automatically.

Vercel gives you an address like `https://cfs-portal.vercel.app`. You can add your own domain (e.g. `portal.yourcfs.in`) under **Vercel → Project → Settings → Domains**.

## Step 6: Turn on user management (no emails)

Logins are created by the superadmin inside the portal: a **User ID + password**, with no sign-up page and no emails. This needs Supabase's secret key, which lives only on Vercel's server, never in the website files.

1. In Supabase: **Project Settings → API Keys → Legacy API Keys**, find **service_role**, click **Reveal** and copy it. Keep it secret.
2. In Vercel: open the project → **Settings → Environment Variables** and add:
   - `SUPABASE_URL` = your Project URL (e.g. `https://abcd.supabase.co`)
   - `SUPABASE_SERVICE_ROLE_KEY` = the service_role key
3. In Vercel: **Deployments** → the top deployment → **⋯ → Redeploy** (environment variables only apply after a redeploy).
4. In Supabase: **Authentication → Sign In / Providers** → turn **off** "Allow new users to sign up". This blocks anyone from creating their own account. Logins you create in the portal still work.

## Step 7: Create your superadmin account

The very first account becomes the superadmin automatically. On a fresh install, create it in Supabase: **Authentication → Users → Add user → Create new user**, enter your email and a password, and tick **Auto Confirm User**. Then sign in to the portal by typing that email in the User ID box.

If you set up the portal before user IDs existed, your email login is already the superadmin and keeps working the same way.

If someone else got in first, fix it in Supabase SQL Editor:

```sql
update profiles set role = 'superadmin' where email = 'you@yourcompany.com';
```

## Step 8: Create logins for staff and customers

In the portal, open **Users & customers**.

1. **Add customers** first: a short code (e.g. `ABCIMP`) and a name.
2. **Create a login** for each person: full name, User ID (e.g. `karthik.r`), password (one is generated for you) and role. For a customer contact, pick role **Customer** and their company.
3. Click **Copy details** and send them the portal address, User ID and password (WhatsApp, SMS, whatever you use). The password is shown only once.
4. People can change their own password with the **Password** button at the top after signing in.
5. Forgotten password: click **Reset password** next to the person and share the new one. **Disable** blocks a login without deleting history; **Delete** removes it.

   | Role | Can do |
   |---|---|
   | Superadmin | Everything, including FIFO bypass, priority, user management |
   | Operations + Supervisor | Inventory, starting/completing jobs, Move to position, Hold / Release |
   | Operations team | Inventory only |
   | Warehouse supervisor | Start/complete jobs and photos |
   | Read only | View everything, change nothing |
   | Customer | Only their own containers on the customer portal |
   | Display screen | The warehouse TV: live jobs, job queue and "check your container", with no customer names |

6. **Inventory:** put the customer code in the **Customer** column of each container (or in the Excel upload). Only containers with that customer's code appear on their portal.
7. **Photos:** tick **Customer can see** on any file you want to share. Files are private to staff until you tick it.

## Recommended Supabase settings

- No emails are needed: logins are created in the portal, so Supabase's email limits don't apply.
- **Free plan pauses after 7 days of no activity.** Daily use keeps it awake. Upgrade to the Pro plan ($25/month) for production use and daily backups.
- **Storage:** the free plan includes 1 GB for photos and files. Photos are resized to about 200–400 KB each.

## Holds and customer priority

- **Hold:** a superadmin or Operations + Supervisor user can put a container that hasn't started on hold (reason required). It leaves the job queue and can't be started. **Release hold** puts it back at its normal FIFO place. The customer sees "On hold" but not the reason.
- **Customer priority:** on the customer portal, **Set my priority** lets a customer order their own containers. Their containers keep the places they already hold in the overall queue; only which of their containers sits in which place changes. Other customers are never moved. A container staff moved to the front keeps its place.

## Warehouse display screen

Create a login with role **Display screen** (e.g. User ID `gate.screen`) and sign in with it on the TV or kiosk PC in the warehouse. It shows the live destuffing jobs (container, size, start time, running clock, Manual/Mechanical, dock) and the overall job queue, with no customer names. Visitors can type a full container number to see when it arrived and whether it is queued, being destuffed or done. Use **Full screen** (or F11) on the TV. Staff can preview it with the **Display screen** link at the top of the portal.

## Move to position

**Move to position** (superadmin or Operations + Supervisor) places a container just ahead of whatever is at that position now, with a reason. It then moves up normally as jobs finish, so it is never stuck at a fixed number. **Back to FIFO place** undoes it.

## How the security works

- **FIFO is enforced by the database.** The Start button calls a database function that checks the queue order, the person's role and the bypass reason. Even someone calling the database directly cannot skip the queue without being a superadmin.
- **Job fields are locked.** Status, start and finish times, mode and durations can only change through Start, Complete and Requeue. Saved arrival times (which set FIFO order) can only be changed by a superadmin, and every change is logged.
- **Customers never read the containers table directly.** They get a limited view of their own containers only: no staff names, no audit log, no bypass reasons, and no other customers' data.
- **Only a superadmin can create logins.** The server function checks the caller is a signed-in superadmin before every action, and the secret key never reaches the browser.

## Updating later

- **Portal changes:** replace the files and redeploy (`vercel --prod`, or push to GitHub).
- **Database changes:** run the new `schema.sql` again in the SQL Editor. It updates in place without deleting data.
